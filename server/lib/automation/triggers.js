// Déclencheurs des playbooks : (a) alerte → playbook, (b) webhook entrant, (c) webhook sortant. TOUT est désactivé par défaut
// (interrupteur général `automation.enabled`) et chaque déclenchement automatique exige un playbook `autoAutorise` jamais « danger ».
//
// (a) Alerte → playbook : LISTE D'AUTORISATIONS explicite définie par un administrateur (un type d'alerte exact → un playbook).
//     Limitation de fréquence (délai de repos) et COUPE-CIRCUIT : N déclenchements en M minutes → le déclencheur est désactivé et une
//     alerte critique est levée. Les alertes « playbook-* » et « automation-* » ne peuvent PAS déclencher (aucune boucle possible :
//     un playbook qui échoue lève « playbook-failed », qui ne relance rien).
// (b) Webhook entrant : jeton `cvu_hk_…` (haché en base) limité à UN playbook, secret HMAC dans le coffre, horodatage ±5 min, anti-rejeu par
//     signature, limite par IP et par jeton, réponse uniforme 401 (aucun indice sur ce qui a échoué).
// (c) Webhook sortant (n8n…) : cible définie par un administrateur, délai court, pas de redirection, corps minimal signé, aucun contenu de sortie.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from '../validate.js';
import { TokenBuckets } from '../ratelimit.js';
import { sign, verify, freshTimestamp, REPLAY_TTL_S } from './hmac.js';
import { coerceValues } from './params.js';
import { asHttp } from './service.js';

const newId = () => crypto.randomBytes(8).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64 = (n) => crypto.randomBytes(n).toString('base64url');
export const SEVERITIES = ['info', 'warn', 'critical'];
const KIND_RE = /^[a-z][a-z0-9._-]{1,48}$/;
const FORBIDDEN_KIND = /^(playbook|automation)/; // pas de boucle : un playbook en échec ne peut jamais en relancer un autre
const MAX_TRIGGERS = 50;
const MAX_HOOKS = 50;
const MAX_BODY = 8 * 1024;
export const HOOK_TOKEN_PREFIX = 'cvu_hk_';
const OUT_EVENTS = ['succeeded', 'failed', 'cancelled'];

const bad = (m) => new HttpError(400, 'INVALID', m);
const denied = () => new HttpError(401, 'HOOK_DENIED', 'Webhook refusé');

/** Adresse interdite comme cible de webhook sortant : lien-local (métadonnées cloud), non spécifiée, multicast. */
export function forbiddenAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low.startsWith('::ffff:')) return forbiddenAddress(low.slice(7));
    return low === '::' || low.startsWith('fe80:') || low.startsWith('ff');
  }
  return false;
}

/** Valide l'URL d'un webhook sortant (définie par un administrateur, jamais par un utilisateur ordinaire). */
export function checkOutgoingUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\u0000- \u007f]/.test(value)) throw bad('URL du webhook sortant invalide');
  let u;
  try { u = new URL(value); } catch { throw bad('URL du webhook sortant invalide'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Webhook sortant : seulement http:// ou https://');
  if (u.username || u.password) throw bad('Webhook sortant : pas d\'identifiants dans l\'URL (utilisez la signature)');
  if (!u.hostname) throw bad('Webhook sortant : hôte manquant');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (forbiddenAddress(host)) throw bad('Webhook sortant : cette adresse est interdite (lien-local, non spécifiée ou multicast)');
  return u.toString();
}

export class Triggers {
  constructor({ automation, runs, db, vault, journal, alerts = null, now = Date.now, fetchImpl = globalThis.fetch, lookup = dns.lookup, limits = {} }) {
    Object.assign(this, { automation, runs, db, vault, journal, alerts, now, fetchImpl, lookup });
    this.ipBuckets = new TokenBuckets({ perMinute: limits.ipPerMin ?? 30, now });
    this.tokenBuckets = new TokenBuckets({ perMinute: limits.tokenPerMin ?? 6, now });
    this.reported = new Map(); // ip → dernier signalement au journal (un par minute : le journal ne doit pas être inondable)
    this.outReported = 0;
    runs.onFinished = (info) => { this.notifyOut(info).catch(() => {}); };
    const prev = automation.onDeleted;
    automation.onDeleted = (id) => {
      prev?.(id);
      this.db.run('DELETE FROM automation_alert_triggers WHERE playbook_id = ?', id);
      for (const h of this.db.all('SELECT id FROM automation_hooks WHERE playbook_id = ?', id)) this.vault.delete(`automation:hook:${h.id}`);
      this.db.run('DELETE FROM automation_hooks WHERE playbook_id = ?', id);
    };
  }

  #autoPlaybook(playbookId) {
    if (typeof playbookId !== 'string' || !/^[a-z0-9]{8,32}$/i.test(playbookId)) throw bad('playbookId invalide');
    const def = this.automation.definitionOf(playbookId);
    if (!def.autoAutorise) throw new HttpError(409, 'NOT_AUTO_AUTHORIZED', 'Ce playbook n\'est pas autorisé à se lancer automatiquement : cochez « autoAutorise » sur le playbook d\'abord');
    if (def.risk === 'danger') throw new HttpError(409, 'RISK_NOT_AUTO', 'Un playbook « danger » ne se lance jamais automatiquement');
    return def;
  }

  // --- (a) alerte → playbook --------------------------------------------------------------------------------------------------

  #triggerView(r) {
    return { id: r.id, playbookId: r.playbook_id, alertKind: r.alert_kind, minSeverity: r.min_severity, hostId: r.host_id, values: JSON.parse(r.params || '{}'), enabled: !!r.enabled,
      maxRuns: r.max_runs, windowMin: r.window_min, cooldownSec: r.cooldown_sec, trippedAt: r.tripped_at, createdBy: r.created_by, createdAt: r.created_at };
  }

  listAlertTriggers() { return this.db.all('SELECT * FROM automation_alert_triggers ORDER BY created_at').map((r) => this.#triggerView(r)); }

  #checkTrigger(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Déclencheur : objet attendu');
    for (const k of Object.keys(input)) if (!['playbookId', 'alertKind', 'minSeverity', 'hostId', 'values', 'enabled', 'maxRuns', 'windowMin', 'cooldownSec'].includes(k)) throw bad(`Champ inconnu : « ${String(k).slice(0, 40)} »`);
    if (typeof input.alertKind !== 'string' || !KIND_RE.test(input.alertKind)) throw bad('Type d\'alerte invalide (minuscules, chiffres, « . _ - »)');
    if (FORBIDDEN_KIND.test(input.alertKind)) throw bad('Les alertes « playbook-… » et « automation-… » ne peuvent pas déclencher de playbook (risque de boucle)');
    const minSeverity = input.minSeverity === undefined ? 'warn' : input.minSeverity; // explicite : null n'est PAS « valeur par défaut »
    if (!SEVERITIES.includes(minSeverity)) throw bad('Gravité minimale invalide (info, warn, critical)');
    const int = (v, def, min, max, name) => {
      const n = v === undefined ? def : v;
      if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} : entier entre ${min} et ${max} attendu`);
      return n;
    };
    const maxRuns = int(input.maxRuns, 3, 1, 20, 'maxRuns');
    const windowMin = int(input.windowMin, 60, 1, 1440, 'windowMin');
    const cooldownSec = int(input.cooldownSec, 120, 30, 3600, 'cooldownSec');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw bad('enabled doit être un booléen');
    if (input.hostId !== undefined && input.hostId !== null) {
      if (typeof input.hostId !== 'string' || !this.automation.hosts.find(input.hostId)) throw bad('Hôte inconnu');
    }
    const def = this.#autoPlaybook(input.playbookId);
    let values;
    try { values = coerceValues(def.params, input.values, { hostIds: this.automation.resolveTargets(def).map((h) => h.id) }); } catch (err) { throw asHttp(err); }
    return { def, alertKind: input.alertKind, minSeverity, hostId: input.hostId ?? null, values, maxRuns, windowMin, cooldownSec, enabled: input.enabled !== false };
  }

  createAlertTrigger(input, { user, ip } = {}) {
    const v = this.#checkTrigger(input);
    if (this.db.get('SELECT COUNT(*) AS n FROM automation_alert_triggers').n >= MAX_TRIGGERS) throw new HttpError(409, 'LIMIT', `Trop de déclencheurs (maximum ${MAX_TRIGGERS})`);
    const id = newId();
    this.db.run('INSERT INTO automation_alert_triggers (id, playbook_id, alert_kind, min_severity, host_id, params, enabled, max_runs, window_min, cooldown_sec, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, v.def.id, v.alertKind, v.minSeverity, v.hostId, JSON.stringify(v.values), v.enabled ? 1 : 0, v.maxRuns, v.windowMin, v.cooldownSec, user?.username ?? null, this.now());
    this.journal.add({ type: 'automation', event: 'trigger-create', user, ip, ok: true, detail: `alerte « ${v.alertKind} » (≥ ${v.minSeverity}) → ${v.def.name}, au plus ${v.maxRuns} en ${v.windowMin} min` });
    return this.#triggerView(this.db.get('SELECT * FROM automation_alert_triggers WHERE id = ?', id));
  }

  updateAlertTrigger(id, input, { user, ip } = {}) {
    const cur = this.db.get('SELECT * FROM automation_alert_triggers WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Déclencheur introuvable');
    const v = this.#checkTrigger(input);
    // Réactiver un déclencheur désactivé par le coupe-circuit : décision explicite de l'administrateur.
    this.db.run('UPDATE automation_alert_triggers SET playbook_id = ?, alert_kind = ?, min_severity = ?, host_id = ?, params = ?, enabled = ?, max_runs = ?, window_min = ?, cooldown_sec = ?, tripped_at = ? WHERE id = ?',
      v.def.id, v.alertKind, v.minSeverity, v.hostId, JSON.stringify(v.values), v.enabled ? 1 : 0, v.maxRuns, v.windowMin, v.cooldownSec, v.enabled ? null : cur.tripped_at, id);
    if (v.enabled) this.db.run('DELETE FROM automation_trigger_events WHERE trigger_id = ?', id);
    this.journal.add({ type: 'automation', event: 'trigger-update', user, ip, ok: true, detail: `déclencheur ${id} : « ${v.alertKind} » → ${v.def.name}, ${v.enabled ? 'actif' : 'désactivé'}` });
    return this.#triggerView(this.db.get('SELECT * FROM automation_alert_triggers WHERE id = ?', id));
  }

  deleteAlertTrigger(id, { user, ip } = {}) {
    if (!this.db.run('DELETE FROM automation_alert_triggers WHERE id = ?', id).changes) throw new HttpError(404, 'NOT_FOUND', 'Déclencheur introuvable');
    this.db.run('DELETE FROM automation_trigger_events WHERE trigger_id = ?', id);
    this.journal.add({ type: 'automation', event: 'trigger-delete', user, ip, ok: true, detail: `déclencheur ${id} supprimé` });
  }

  /** Appelé par Alerts.raise pour CHAQUE nouvelle alerte. Ne lève jamais. */
  async onAlert(alert) {
    try {
      if (!this.automation.enabled || !alert || FORBIDDEN_KIND.test(String(alert.kind))) return [];
      const out = [];
      const t = this.now();
      for (const r of this.db.all('SELECT * FROM automation_alert_triggers WHERE enabled = 1 AND alert_kind = ?', alert.kind)) {
        if (SEVERITIES.indexOf(alert.severity) < SEVERITIES.indexOf(r.min_severity)) continue;
        if (r.host_id && r.host_id !== alert.hostId) continue;
        const last = this.db.get('SELECT MAX(ts) AS ts FROM automation_trigger_events WHERE trigger_id = ?', r.id).ts;
        if (last && t - last < r.cooldown_sec * 1000) { out.push({ id: r.id, outcome: 'repos' }); continue; }
        const recent = this.db.get('SELECT COUNT(*) AS n FROM automation_trigger_events WHERE trigger_id = ? AND ts > ?', r.id, t - r.window_min * 60_000).n;
        if (recent >= r.max_runs) {
          // COUPE-CIRCUIT : trop de déclenchements dans la fenêtre → désactivé jusqu'à une décision d'un administrateur.
          this.db.run('UPDATE automation_alert_triggers SET enabled = 0, tripped_at = ? WHERE id = ?', t, r.id);
          this.journal.add({ type: 'automation', event: 'trigger-tripped', ok: false, detail: `déclencheur ${r.id} (« ${r.alert_kind} ») désactivé : ${r.max_runs} déclenchements en ${r.window_min} min` });
          this.alerts?.raise({ kind: 'automation-circuit-breaker', severity: 'critical', message: `Coupe-circuit : le déclencheur d'alerte « ${r.alert_kind} » a été désactivé (${r.max_runs} lancements en ${r.window_min} min). Vérifiez avant de le réactiver.` });
          out.push({ id: r.id, outcome: 'coupe-circuit' });
          continue;
        }
        this.db.run('INSERT INTO automation_trigger_events (trigger_id, ts) VALUES (?, ?)', r.id, t);
        try {
          await this.runs.start({ playbookId: r.playbook_id, values: JSON.parse(r.params || '{}'), trigger: 'alert', actor: `alerte:${r.id}` });
          out.push({ id: r.id, outcome: 'lancé' });
        } catch (err) {
          out.push({ id: r.id, outcome: `refusé (${err?.code || 'erreur'})` });
          this.journal.add({ type: 'automation', event: 'trigger-refused', ok: false, detail: `déclencheur ${r.id} : ${String(err?.message || err).slice(0, 200)}` });
        }
      }
      return out;
    } catch { return []; }
  }

  // --- (b) webhook entrant ----------------------------------------------------------------------------------------------------

  listHooks() {
    return this.db.all('SELECT id, playbook_id, name, enabled, created_by, created_at, last_used_at FROM automation_hooks ORDER BY created_at')
      .map((r) => ({ id: r.id, playbookId: r.playbook_id, name: r.name, enabled: !!r.enabled, createdBy: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  /** Crée un webhook. Le jeton ET le secret ne sont montrés QU'UNE FOIS (seule l'empreinte du jeton est conservée). */
  createHook({ playbookId, name }, { user, ip } = {}) {
    const def = this.#autoPlaybook(playbookId);
    if (typeof name !== 'string' || !name.trim() || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw bad('Nom du webhook invalide (1 à 60 caractères)');
    if (this.db.get('SELECT COUNT(*) AS n FROM automation_hooks').n >= MAX_HOOKS) throw new HttpError(409, 'LIMIT', `Trop de webhooks (maximum ${MAX_HOOKS})`);
    const id = newId();
    const token = `${HOOK_TOKEN_PREFIX}${b64(32)}`;
    const secret = `cvs_${b64(32)}`;
    this.db.tx(() => {
      this.db.run('INSERT INTO automation_hooks (id, playbook_id, name, token_hash, enabled, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)', id, def.id, name.trim(), sha256(token), user?.username ?? null, this.now());
      this.vault.set(`automation:hook:${id}`, { secret });
    });
    this.journal.add({ type: 'automation', event: 'hook-create', user, ip, ok: true, detail: `webhook « ${name.trim()} » → ${def.name}` }); // jamais le jeton ni le secret
    return { id, playbookId: def.id, name: name.trim(), token, secret };
  }

  setHookEnabled(id, enabled, { user, ip } = {}) {
    if (typeof enabled !== 'boolean') throw bad('enabled doit être un booléen');
    if (!this.db.run('UPDATE automation_hooks SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id).changes) throw new HttpError(404, 'NOT_FOUND', 'Webhook introuvable');
    this.journal.add({ type: 'automation', event: enabled ? 'hook-enable' : 'hook-disable', user, ip, ok: true, detail: `webhook ${id}` });
  }

  deleteHook(id, { user, ip } = {}) {
    if (!this.db.run('DELETE FROM automation_hooks WHERE id = ?', id).changes) throw new HttpError(404, 'NOT_FOUND', 'Webhook introuvable');
    this.vault.delete(`automation:hook:${id}`);
    this.db.run('DELETE FROM automation_hook_replays WHERE hook_id = ?', id);
    this.journal.add({ type: 'automation', event: 'hook-delete', user, ip, ok: true, detail: `webhook ${id} supprimé` });
  }

  #reportHookFailure(ip, why) {
    const t = this.now();
    if (t - (this.reported.get(ip) || 0) < 60_000) return;
    this.reported.set(ip, t);
    if (this.reported.size > 1000) this.reported.clear();
    this.journal.add({ type: 'automation', event: 'hook-denied', ip, ok: false, detail: `webhook refusé (${why})` });
  }

  /**
   * Webhook entrant. `token`, `timestamp`, `signature` viennent des en-têtes ; `rawBody` est le corps EXACT (Buffer).
   * Toute erreur d'authentification donne la MÊME réponse 401 (aucun indice sur ce qui a échoué).
   */
  async handleInbound({ token, timestamp, signature, rawBody, ip }) {
    const wait = Math.max(this.ipBuckets.waitFor(ip), 0);
    if (wait > 0) throw Object.assign(new HttpError(429, 'RATE_LIMITED', 'Trop de requêtes'), { retryAfterMs: wait });
    this.ipBuckets.spend(ip);
    if (typeof token !== 'string' || !token.startsWith(HOOK_TOKEN_PREFIX) || token.length > 100) { this.#reportHookFailure(ip, 'jeton absent ou mal formé'); throw denied(); }
    const hook = this.db.get('SELECT * FROM automation_hooks WHERE token_hash = ?', sha256(token));
    if (!hook) { this.#reportHookFailure(ip, 'jeton inconnu'); throw denied(); }
    const tokWait = this.tokenBuckets.waitFor(hook.id);
    if (tokWait > 0) throw Object.assign(new HttpError(429, 'RATE_LIMITED', 'Trop de requêtes pour ce webhook'), { retryAfterMs: tokWait });
    this.tokenBuckets.spend(hook.id);
    const secret = this.vault.get(`automation:hook:${hook.id}`)?.secret;
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''));
    if (!hook.enabled || !secret || body.length > MAX_BODY || !freshTimestamp(timestamp, this.now()) || !verify(secret, timestamp, body, signature)) {
      this.#reportHookFailure(ip, `webhook ${hook.id} : signature, horodatage ou état invalide`);
      throw denied();
    }
    // Anti-rejeu : une signature valide ne sert QU'UNE fois (mémorisée au-delà de la tolérance d'horloge).
    this.db.run('DELETE FROM automation_hook_replays WHERE ts < ?', this.now() - REPLAY_TTL_S * 1000);
    if (this.db.run('INSERT OR IGNORE INTO automation_hook_replays (hook_id, sig, ts) VALUES (?, ?, ?)', hook.id, signature, this.now()).changes === 0) {
      this.#reportHookFailure(ip, `webhook ${hook.id} : rejeu`);
      throw denied();
    }
    // Authentifié. Le corps : JSON borné `{ values?: {...} }`.
    let values = {};
    if (body.length) {
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { throw bad('Corps JSON invalide'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some((k) => k !== 'values')) throw bad('Corps : { "values": { … } } attendu');
      values = parsed.values ?? {};
    }
    this.db.run('UPDATE automation_hooks SET last_used_at = ? WHERE id = ?', this.now(), hook.id);
    const out = await this.runs.start({ playbookId: hook.playbook_id, values, trigger: 'webhook', actor: `webhook:${hook.id}`, ip });
    this.journal.add({ type: 'automation', event: 'hook-run', ip, ok: true, detail: `webhook « ${hook.name} » → lancement ${out.runId}` });
    return out;
  }

  // --- (c) webhook sortant ----------------------------------------------------------------------------------------------------

  outgoing() {
    const c = this.db.getMeta('automation.outgoing', null);
    return c ? { url: c.url, events: c.events, enabled: !!c.enabled, hasSecret: !!this.vault.get('automation:outgoing')?.secret } : { url: null, events: ['failed'], enabled: false, hasSecret: false };
  }

  /** Définit le webhook sortant. Le secret de signature est généré à la première configuration (montré UNE fois). */
  setOutgoing(input, { user, ip } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Webhook sortant : objet attendu');
    for (const k of Object.keys(input)) if (!['url', 'events', 'enabled', 'rotateSecret'].includes(k)) throw bad(`Champ inconnu : « ${String(k).slice(0, 40)} »`);
    const url = checkOutgoingUrl(input.url);
    const events = input.events === undefined ? ['failed'] : input.events;
    if (!Array.isArray(events) || !events.length || events.length > 3 || !events.every((e) => OUT_EVENTS.includes(e))) throw bad(`events : liste non vide parmi ${OUT_EVENTS.join(', ')}`);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw bad('enabled doit être un booléen');
    if (input.rotateSecret !== undefined && typeof input.rotateSecret !== 'boolean') throw bad('rotateSecret doit être un booléen');
    let secret = null;
    if (!this.vault.get('automation:outgoing')?.secret || input.rotateSecret === true) { secret = `cvs_${b64(32)}`; this.vault.set('automation:outgoing', { secret }); }
    this.db.setMeta('automation.outgoing', { url, events: [...new Set(events)], enabled: input.enabled !== false });
    this.journal.add({ type: 'automation', event: 'outgoing-set', user, ip, ok: true, detail: `webhook sortant → ${new URL(url).host} (${[...new Set(events)].join(', ')})${secret ? ', secret (re)généré' : ''}` });
    return { ...this.outgoing(), ...(secret ? { secret } : {}) };
  }

  deleteOutgoing({ user, ip } = {}) {
    this.db.setMeta('automation.outgoing', null);
    this.vault.delete('automation:outgoing');
    this.journal.add({ type: 'automation', event: 'outgoing-delete', user, ip, ok: true, detail: 'webhook sortant supprimé' });
  }

  /** Envoie un évènement signé. Meilleur effort : un échec est journalisé (une fois par minute) et ne change JAMAIS le résultat du lancement. */
  async sendOutgoing(payload) {
    const cfg = this.db.getMeta('automation.outgoing', null);
    const secret = this.vault.get('automation:outgoing')?.secret;
    if (!cfg?.enabled || !secret) return { sent: false, reason: 'non configuré' };
    const url = checkOutgoingUrl(cfg.url);
    const u = new URL(url);
    try { // adresses résolues : même contrôle qu'à la configuration (réduit le risque d'un nom qui pointerait vers une adresse interdite)
      for (const a of await this.lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true })) if (forbiddenAddress(a.address)) throw new Error('adresse interdite');
    } catch (err) { return this.#outFailed(`résolution refusée (${String(err?.message || err).slice(0, 60)})`); }
    const body = JSON.stringify({ ...payload, ts: Math.floor(this.now() / 1000) });
    if (body.length > 2048) return this.#outFailed('charge utile trop grosse');
    const timestamp = String(Math.floor(this.now() / 1000));
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'user-agent': 'Corvus', 'x-corvus-timestamp': timestamp, 'x-corvus-signature': sign(secret, timestamp, body) }, body,
      });
      try { await res.body?.cancel(); } catch { /* la réponse n'est pas lue */ }
      if (!res.ok) return this.#outFailed(`réponse ${res.status}`);
      return { sent: true, status: res.status };
    } catch (err) { return this.#outFailed(String(err?.name === 'TimeoutError' ? 'délai dépassé' : err?.message || err).slice(0, 80)); }
  }

  #outFailed(why) {
    if (this.now() - this.outReported > 60_000) {
      this.outReported = this.now();
      this.journal.add({ type: 'automation', event: 'outgoing-failed', ok: false, detail: `webhook sortant en échec : ${why}` });
    }
    return { sent: false, reason: why };
  }

  async notifyOut(info) {
    const event = info.status === 'succeeded' ? 'succeeded' : info.status === 'cancelled' ? 'cancelled' : 'failed';
    const cfg = this.db.getMeta('automation.outgoing', null);
    if (!cfg?.enabled || !cfg.events.includes(event)) return null;
    // Contenu MINIMAL : jamais de sortie de commande, jamais de paramètres.
    return this.sendOutgoing({ event: `playbook.${event}`, runId: info.runId, playbook: info.name, status: info.status, trigger: info.trigger, hosts: info.counts?.hosts, ok: info.counts?.ok });
  }
}
