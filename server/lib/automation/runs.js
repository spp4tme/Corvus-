// Orchestration des exécutions de playbooks : autorisation, confirmation du risque, prévisualisation, lancement, historique.
//
// Règles (chaque ligne a son test) :
//  - `automation.enabled` faux → RIEN ne s'exécute (409) ; l'éteindre arrête aussi tout ce qui tourne ;
//  - un opérateur lance un playbook seulement si TOUS ses hôtes cibles lui sont accordés au niveau « operator » (sinon 404) ;
//  - un lancement automatique (planning, alerte, webhook) exige `autoAutorise` ET un playbook jamais « danger » ;
//  - un playbook à risque exige `confirm: true` ; un playbook « danger » exige en plus une prévisualisation récente quand l'agent
//    de l'un des hôtes en propose une ;
//  - un seul lancement actif par playbook, et un plafond global de lancements simultanés ;
//  - l'hôte Windows (ou « agent seul » pour des commandes) est refusé à CHAQUE exécution (l'OS peut changer) ;
//  - le journal reçoit qui / quoi / où / résultat, JAMAIS de sortie ni de valeur de secret.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HttpError } from '../validate.js';
import { analyze } from '../risk.js';
import { lineDiff } from '../rewind.js';
import { unsupportedReason } from '../agent-support.js';
import { coerceValues, render, scanTemplate, PlaybookError } from './params.js';
import { runPlaybook } from './runner.js';
import { asHttp } from './service.js';

const newId = () => crypto.randomBytes(8).toString('hex');
const PREVIEW_TTL_MS = 15 * 60_000;
const MAX_PREVIEW_COMMANDS = 20;
const RETENTION_DAYS = 90;

export class RunManager extends EventEmitter {
  constructor({ automation, db, hosts, pool, agents, journal, alerts = null, maxConcurrentRuns = 3, limits = {}, now = Date.now }) {
    super();
    Object.assign(this, { automation, db, hosts, pool, agents, journal, alerts, maxConcurrentRuns, limits, now });
    this.active = new Map(); // runId → { ac, playbookId, userId, startedAt }
    this.previews = new Map(); // clé → horodatage
    automation.onDisabled = () => this.stopAll({ user: null, reason: 'interrupteur général désactivé' });
  }

  /** Au démarrage : un lancement resté « running » (arrêt brutal) est marqué interrompu ; l'historique ancien est purgé. */
  recover() {
    const t = this.now();
    this.db.run("UPDATE playbook_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'", t);
    this.db.run("UPDATE playbook_run_steps SET status = 'cancelled' WHERE status = 'running'");
    const old = t - RETENTION_DAYS * 86_400_000;
    this.db.run('DELETE FROM playbook_run_steps WHERE run_id IN (SELECT id FROM playbook_runs WHERE started_at < ?)', old);
    this.db.run('DELETE FROM playbook_runs WHERE started_at < ?', old);
  }

  // --- Lancement --------------------------------------------------------------------------------------------------------------

  #previewKey(userId, def, values) {
    return `${userId}|${def.id}|${def.version}|${crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24)}`;
  }

  #previewAvailable(hosts) {
    return hosts.some((h) => { const a = this.agents?.forHost?.(h.id); return a?.online && a.support?.preview?.ok; });
  }

  /** Commandes rendues d'un playbook (sans les valeurs de secrets : elles restent des références). */
  #rendered(def, values) {
    const out = [];
    let idx = 0;
    const one = (s) => {
      if (s.agent) { out.push({ idx: idx++, name: s.name, agent: s.agent, command: `[agent] ${s.agent.action}` }); return; }
      out.push({ idx: idx++, name: s.name, command: render(s.run, def.params, values), usesSecret: scanTemplate(s.run, { allowedParams: def.params.map((p) => p.name) }).secrets.length > 0 });
    };
    for (const s of def.steps) { if (s.parallel) s.parallel.forEach(one); else one(s); }
    return out;
  }

  /**
   * @param {object} o
   * @param {string} o.playbookId
   * @param {object} [o.values] valeurs des paramètres
   * @param {boolean} [o.confirm]
   * @param {boolean} [o.dry] prévisualisation seulement : n'exécute RIEN sur les hôtes
   * @param {'manual'|'schedule'|'alert'|'webhook'} [o.trigger]
   * @param {object|null} [o.user] compte (lancement manuel)
   * @param {string} [o.actor] nom de l'acteur pour un déclencheur automatique (ex. « planning:ab12 »)
   * @param {string} [o.ip]
   * @param {(host: object) => void} [o.authorize] lève si le compte n'a pas le droit « operator » sur cet hôte
   */
  async start({ playbookId, values = {}, confirm = false, dry = false, trigger = 'manual', user = null, actor = null, ip = null, authorize = null }) {
    const A = this.automation;
    if (!A.enabled) throw new HttpError(409, 'AUTOMATION_DISABLED', 'L\'automatisation est désactivée (interrupteur général) : activez-la dans Playbooks avant de lancer quoi que ce soit');
    const def = A.definitionOf(playbookId);
    const hosts = A.resolveTargets(def);
    if (!hosts.length) throw new HttpError(409, 'NO_TARGETS', 'Ce playbook ne vise plus aucun hôte existant');
    if (authorize) {
      try { for (const h of hosts) authorize(h); } catch (err) {
        // Un hôte non accordé = 404 : on ne révèle ni l'existence du playbook ni celle de l'hôte.
        if (err instanceof HttpError && (err.status === 404 || err.status === 403)) throw new HttpError(404, 'NOT_FOUND', 'Playbook introuvable');
        throw err;
      }
    }
    A.assertTargetsUsable(def, hosts); // Windows / agent seul : refusé À CHAQUE exécution
    if (trigger !== 'manual') {
      if (!def.autoAutorise) throw new HttpError(403, 'NOT_AUTO_AUTHORIZED', 'Ce playbook n\'est pas autorisé à se lancer automatiquement (autoAutorise)');
      if (def.risk === 'danger') throw new HttpError(403, 'RISK_NOT_AUTO', 'Un playbook à risque « danger » ne se lance jamais automatiquement');
    }
    let vals;
    try { vals = coerceValues(def.params, values, { hostIds: hosts.map((h) => h.id) }); } catch (err) { throw asHttp(err); }

    const secretNames = A.secretsUsedBy(def);
    const secrets = A.secretValues(secretNames);
    const who = user ? user.username : (actor || trigger);

    if (dry) return this.#dryRun({ def, hosts, vals, user, ip, who, trigger });

    if (trigger === 'manual' && def.risk !== 'safe' && confirm !== true) {
      throw Object.assign(new HttpError(400, 'CONFIRM_REQUIRED', `Ce playbook est à risque « ${def.risk} » : confirmation explicite requise (confirm: true)`), { details: { risk: def.risk } });
    }
    if (trigger === 'manual' && def.risk === 'danger' && this.#previewAvailable(hosts)) {
      const at = this.previews.get(this.#previewKey(user?.id, def, vals));
      if (!at || this.now() - at > PREVIEW_TTL_MS) {
        throw new HttpError(409, 'PREVIEW_REQUIRED', 'Playbook « danger » : lancez d\'abord une prévisualisation (dry: true) avec les mêmes paramètres ; elle reste valable 15 minutes');
      }
    }
    if (this.active.size >= this.maxConcurrentRuns) throw new HttpError(429, 'TOO_MANY_RUNS', `Trop de playbooks en cours (maximum ${this.maxConcurrentRuns}) : attendez la fin de l'un d'eux`);
    for (const a of this.active.values()) if (a.playbookId === def.id) throw new HttpError(409, 'ALREADY_RUNNING', 'Ce playbook est déjà en cours d\'exécution');

    const runId = newId();
    const t = this.now();
    this.db.run('INSERT INTO playbook_runs (id, playbook_id, playbook_name, playbook_version, trigger, actor, user_id, status, dry, params, started_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
      runId, def.id, def.name, def.version, trigger, who, user?.id ?? null, 'running', JSON.stringify(vals), t,
      JSON.stringify({ hostIds: hosts.map((h) => h.id), risk: def.risk }));
    this.journal.add({ type: 'automation', event: 'run-start', user: user || undefined, ip, ok: true, detail: `${def.name} v${def.version} (${trigger}${user ? '' : `, ${who}`}) sur ${hosts.length} hôte(s)` });
    const ac = new AbortController();
    const hostIds = hosts.map((h) => h.id);
    this.active.set(runId, { ac, playbookId: def.id, userId: user?.id ?? null, startedAt: t, hostIds, name: def.name });
    this.emit('event', { type: 'run-start', runId, playbookId: def.id, name: def.name, hostIds });
    // Exécution détachée : la requête répond tout de suite (202) ; le suivi se fait par l'historique et le WebSocket.
    this.#execute({ runId, def, hosts, vals, secrets, ac, user, ip, who, trigger }).catch((err) => {
      this.journal.add({ type: 'automation', event: 'run-error', user: user || undefined, ip, ok: false, detail: `${def.name} : ${String(err?.message || err).slice(0, 200)}` });
    });
    return { runId, status: 'running', hosts: hosts.length };
  }

  async #dryRun({ def, hosts, vals, user, ip, who, trigger }) {
    const rendered = this.#rendered(def, vals);
    const plan = [];
    let previews = 0;
    for (const h of hosts) {
      const steps = [];
      for (const c of rendered) {
        const entry = { idx: c.idx, name: c.name, command: c.command, analysis: null, preview: null };
        if (!c.agent) {
          const a = analyze(c.command);
          entry.analysis = { level: a.level, reasons: a.reasons, sudo: a.sudo, dynamic: a.dynamic };
          const agent = this.agents?.forHost?.(h.id);
          if (agent?.online && agent.support?.preview?.ok && !c.usesSecret && previews < MAX_PREVIEW_COMMANDS) {
            previews += 1;
            try {
              const r = await this.agents.request(h.id, 'preview.run', { command: c.command, root: false, user: h.username, timeoutSec: 30 }, 90_000);
              entry.preview = { entries: (r.entries || []).slice(0, 50).map((e) => {
                const { before, after, ...rest } = e;
                return typeof after === 'string' || typeof before === 'string' ? { ...rest, diff: lineDiff(before || '', after || '') } : rest;
              }) };
            } catch (err) { entry.preview = { error: String(err?.message || err).slice(0, 200) }; }
          } else if (c.usesSecret) entry.preview = { skipped: 'utilise un secret : non prévisualisé' };
        }
        steps.push(entry);
      }
      plan.push({ hostId: h.id, label: h.name, steps });
    }
    if (user) this.previews.set(this.#previewKey(user.id, def, vals), this.now());
    for (const [k, ts] of this.previews) if (this.now() - ts > PREVIEW_TTL_MS) this.previews.delete(k);
    const runId = newId();
    this.db.run('INSERT INTO playbook_runs (id, playbook_id, playbook_name, playbook_version, trigger, actor, user_id, status, dry, params, started_at, ended_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
      runId, def.id, def.name, def.version, trigger, who, user?.id ?? null, 'previewed', JSON.stringify(vals), this.now(), this.now(),
      JSON.stringify({ hostIds: hosts.map((h) => h.id), risk: def.risk }));
    this.journal.add({ type: 'automation', event: 'run-preview', user: user || undefined, ip, ok: true, detail: `${def.name} v${def.version} : prévisualisation sur ${hosts.length} hôte(s), rien n'a été exécuté` });
    const riskReasons = [...new Set(plan.flatMap((h) => h.steps.flatMap((s) => s.analysis?.reasons || [])))];
    return { dry: true, runId, risk: def.risk, riskReasons, previewAvailable: this.#previewAvailable(hosts), plan };
  }

  async #execute({ runId, def, hosts, vals, secrets, ac, user, ip, who, trigger }) {
    const label = (id) => hosts.find((h) => h.id === id)?.name || id;
    const onEvent = (ev) => {
      try {
        if (ev.type === 'step-start') {
          this.db.run('INSERT OR REPLACE INTO playbook_run_steps (run_id, host_id, host_label, idx, name, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)', runId, ev.hostId, label(ev.hostId), ev.idx, ev.name, 'running', this.now());
        } else if (ev.type === 'step-end') {
          this.db.run('INSERT OR REPLACE INTO playbook_run_steps (run_id, host_id, host_label, idx, name, status, code, output, truncated, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            runId, ev.hostId, label(ev.hostId), ev.idx, ev.name, ev.status, ev.code, ev.output, ev.truncated ? 1 : 0, this.now() - (ev.ms || 0), this.now());
        }
      } catch { /* la persistance ne doit jamais interrompre l'exécution */ }
      this.emit('event', { runId, ...ev, output: undefined }); // la sortie n'est pas diffusée en direct : on la lit par l'historique
    };
    let result;
    try {
      result = await runPlaybook({
        def, values: vals, hosts: hosts.map((h) => ({ id: h.id, label: h.name })), secrets, signal: ac.signal, onEvent, limits: this.limits,
        exec: (id, script, o) => this.pool.exec(id, script, o),
        agentCall: async (id, action, args, ms) => {
          const a = this.agents?.forHost?.(id);
          if (!a?.online) throw new Error('L\'agent de cet hôte n\'est pas connecté');
          const why = unsupportedReason(a.platform, a.capabilities, action);
          if (why) throw new Error(why); // respecte les capacités ANNONCÉES par l'agent
          return this.agents.request(id, action, args, ms);
        },
      });
    } catch (err) {
      result = { status: 'failed', hosts: [], error: String(err?.message || err).slice(0, 300) };
    }
    // Toutes les commandes sont conservées avec leur statut final, y compris celles qui n'ont jamais démarré (sautées, annulées) :
    // l'historique doit montrer ce qui N'a PAS été exécuté autant que ce qui l'a été.
    try {
      for (const h of result.hosts) {
        for (const st of h.steps) {
          this.db.run('INSERT OR REPLACE INTO playbook_run_steps (run_id, host_id, host_label, idx, name, status, code, output, truncated, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            runId, h.id, label(h.id), st.idx, st.name, st.status, st.code, st.output, st.truncated ? 1 : 0, this.now() - (st.ms || 0), this.now());
        }
      }
    } catch { /* l'historique ne doit jamais empêcher de conclure le lancement */ }
    const counts = { hosts: result.hosts.length, ok: result.hosts.filter((h) => h.status === 'succeeded').length, failed: result.hosts.filter((h) => h.status !== 'succeeded').length };
    const prev = JSON.parse(this.db.get('SELECT summary FROM playbook_runs WHERE id = ?', runId)?.summary || '{}');
    this.db.run('UPDATE playbook_runs SET status = ?, ended_at = ?, summary = ? WHERE id = ?', result.status, this.now(), JSON.stringify({ ...prev, ...counts, error: result.error }), runId);
    this.active.delete(runId);
    this.journal.add({ type: 'automation', event: 'run-end', user: user || undefined, ip, ok: result.status === 'succeeded',
      detail: `${def.name} v${def.version} : ${result.status} (${counts.ok}/${counts.hosts} hôte(s) réussi(s))` });
    this.emit('event', { type: 'run-end', runId, status: result.status, name: def.name, counts, hostIds: hosts.map((h) => h.id) });
    if (result.status === 'failed' || result.status === 'timeout') {
      this.alerts?.raise({ kind: 'playbook-failed', severity: 'warn', message: `Playbook « ${def.name} » : ${result.status} (${counts.ok}/${counts.hosts} hôte(s) réussi(s))`, data: { runId } });
    }
    this.onFinished?.({ runId, playbookId: def.id, name: def.name, status: result.status, trigger, counts, actor: who });
  }

  // --- Arrêt ------------------------------------------------------------------------------------------------------------------

  /** Annule un lancement : son auteur ou un administrateur. */
  cancel(runId, { user, ip } = {}) {
    const a = this.active.get(runId);
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'Aucun lancement en cours avec cet identifiant');
    if (user && user.role !== 'admin' && a.userId !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Ce lancement appartient à un autre compte');
    a.ac.abort();
    this.journal.add({ type: 'automation', event: 'run-cancel', user: user || undefined, ip, ok: true, detail: `lancement ${runId} annulé` });
    return { runId, cancelling: true };
  }

  /** Arrêt d'urgence : tout ce qui tourne reçoit l'ordre de s'arrêter. N'importe quel opérateur peut le demander (c'est sûr). */
  stopAll({ user, ip, reason = 'arrêt d\'urgence' } = {}) {
    let n = 0;
    for (const a of this.active.values()) { a.ac.abort(); n += 1; }
    this.journal.add({ type: 'automation', event: 'stop-all', user: user || undefined, ip, ok: true, detail: `${reason} : ${n} lancement(s) interrompu(s)` });
    return { stopped: n };
  }

  // --- Lecture ----------------------------------------------------------------------------------------------------------------

  #row(r) {
    const summary = JSON.parse(r.summary || '{}');
    return {
      id: r.id, playbookId: r.playbook_id, name: r.playbook_name, version: r.playbook_version, trigger: r.trigger, actor: r.actor, status: r.status, dry: !!r.dry,
      startedAt: r.started_at, endedAt: r.ended_at, risk: summary.risk, counts: summary.hosts !== undefined ? { hosts: summary.hosts, ok: summary.ok, failed: summary.failed } : null,
      error: summary.error, hostIds: summary.hostIds || [], active: this.active.has(r.id),
    };
  }

  /** @param {string[]|null} allowedHostIds hôtes visibles par le compte (null = tous) */
  list(allowedHostIds, { limit = 50, playbookId = null } = {}) {
    const rows = this.db.all(`SELECT * FROM playbook_runs ${playbookId ? 'WHERE playbook_id = ?' : ''} ORDER BY started_at DESC LIMIT ?`, ...(playbookId ? [playbookId] : []), Math.min(Math.max(limit, 1), 200) * 4);
    return rows.map((r) => this.#row(r)).filter((r) => !allowedHostIds || r.hostIds.some((h) => allowedHostIds.includes(h))).slice(0, Math.min(Math.max(limit, 1), 200))
      .map((r) => ({ ...r, hostIds: allowedHostIds ? r.hostIds.filter((h) => allowedHostIds.includes(h)) : r.hostIds }));
  }

  get(allowedHostIds, runId) {
    const r = this.db.get('SELECT * FROM playbook_runs WHERE id = ?', runId);
    const run = r && this.#row(r);
    if (!run || (allowedHostIds && !run.hostIds.some((h) => allowedHostIds.includes(h)))) throw new HttpError(404, 'NOT_FOUND', 'Lancement introuvable');
    const steps = this.db.all('SELECT host_id AS hostId, host_label AS hostLabel, idx, name, status, code, output, truncated, started_at AS startedAt, ended_at AS endedAt FROM playbook_run_steps WHERE run_id = ? ORDER BY host_label, idx', runId)
      .filter((s) => !allowedHostIds || allowedHostIds.includes(s.hostId)).map((s) => ({ ...s, truncated: !!s.truncated }));
    return { ...run, hostIds: allowedHostIds ? run.hostIds.filter((h) => allowedHostIds.includes(h)) : run.hostIds, params: JSON.parse(r.params || '{}'), steps };
  }
}

export { PlaybookError };
