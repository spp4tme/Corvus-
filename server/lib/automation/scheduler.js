// Planification des playbooks : cron + fuseau explicite + fenêtre de maintenance. Désactivée par défaut (comme tout le reste).
//
// Garde-fous (chacun testé) :
//  - une planification n'est acceptée que pour un playbook `autoAutorise`, jamais « danger » (revérifié à CHAQUE lancement) ;
//  - pas plus d'un déclenchement toutes les 5 minutes ;
//  - JAMAIS de rattrapage : après une panne, les occurrences manquées sont abandonnées (au plus une tolérance de 2 minutes de retard) ;
//  - la prochaine échéance est recalculée AVANT de lancer (un plantage ne peut pas faire boucler) ;
//  - l'interrupteur général éteint tout, et les échéances passées pendant l'arrêt ne sont pas rejouées ;
//  - un playbook déjà en cours n'est pas relancé par-dessus (planifications chevauchantes) ;
//  - chaque décision (lancé, manqué, hors fenêtre, refusé) est visible dans la liste ; le journal garde lancements et refus.
import crypto from 'node:crypto';
import { HttpError } from '../validate.js';
import { parseCron, nextRun, checkTimeZone, parseWindow, inWindow, CronError } from './cron.js';
import { coerceValues } from './params.js';
import { asHttp } from './service.js';

const newId = () => crypto.randomBytes(8).toString('hex');
const MIN_GAP_MS = 5 * 60_000;
export const GRACE_MS = 2 * 60_000;
const MAX_SCHEDULES = 100;

const bad = (m) => new HttpError(400, 'INVALID_SCHEDULE', m);

/** Plus petit écart entre les prochains déclenchements (sur 60 occurrences). */
function minGap(cron, tz, from) {
  let prev = nextRun(cron, from, tz);
  if (prev === null) return Infinity;
  let min = Infinity;
  for (let i = 0; i < 60; i++) {
    const n = nextRun(cron, prev, tz);
    if (n === null) break;
    min = Math.min(min, n - prev);
    prev = n;
  }
  return min;
}

export class Scheduler {
  constructor({ automation, runs, db, journal, now = Date.now }) {
    Object.assign(this, { automation, runs, db, journal, now });
    automation.onDeleted = ((prev) => (id) => { prev?.(id); this.db.run('DELETE FROM automation_schedules WHERE playbook_id = ?', id); })(automation.onDeleted);
  }

  #view(r) {
    return {
      id: r.id, playbookId: r.playbook_id, cron: r.cron, tz: r.tz, window: r.win ? JSON.parse(r.win) : null, values: JSON.parse(r.params || '{}'),
      enabled: !!r.enabled, nextAt: r.next_at, lastAt: r.last_at, lastStatus: r.last_status, createdBy: r.created_by, createdAt: r.created_at,
    };
  }

  list() { return this.db.all('SELECT * FROM automation_schedules ORDER BY created_at').map((r) => this.#view(r)); }

  get(id) {
    const r = this.db.get('SELECT * FROM automation_schedules WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Planification introuvable');
    return this.#view(r);
  }

  /** Valide et normalise une planification. */
  #check(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Planification : objet attendu');
    for (const k of Object.keys(input)) if (!['playbookId', 'cron', 'tz', 'window', 'values', 'enabled'].includes(k)) throw bad(`Champ inconnu : « ${String(k).slice(0, 40)} »`);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw bad('enabled doit être un booléen');
    let cron; let win;
    try {
      if (typeof input.tz !== 'string') throw new CronError('Le fuseau horaire est obligatoire (ex. Europe/Paris) : aucun fuseau par défaut');
      checkTimeZone(input.tz);
      cron = parseCron(input.cron);
      win = parseWindow(input.window);
    } catch (err) { if (err instanceof CronError) throw bad(err.message); throw err; }
    if (typeof input.playbookId !== 'string' || !/^[a-z0-9]{8,32}$/i.test(input.playbookId)) throw bad('playbookId invalide');
    const def = this.automation.definitionOf(input.playbookId); // 404 si inconnu
    if (!def.autoAutorise) throw new HttpError(409, 'NOT_AUTO_AUTHORIZED', 'Ce playbook n\'est pas autorisé à se lancer automatiquement : cochez « autoAutorise » sur le playbook d\'abord');
    if (def.risk === 'danger') throw new HttpError(409, 'RISK_NOT_AUTO', 'Un playbook « danger » ne se planifie jamais');
    const hosts = this.automation.resolveTargets(def);
    let values;
    try { values = coerceValues(def.params, input.values, { hostIds: hosts.map((h) => h.id) }); } catch (err) { throw asHttp(err); }
    if (minGap(cron, input.tz, this.now()) < MIN_GAP_MS) throw bad('Trop fréquent : au moins 5 minutes entre deux déclenchements');
    return { def, cron, tz: input.tz, win, values, enabled: input.enabled !== false };
  }

  create(input, { user, ip } = {}) {
    const v = this.#check(input);
    if (this.db.get('SELECT COUNT(*) AS n FROM automation_schedules').n >= MAX_SCHEDULES) throw new HttpError(409, 'LIMIT', `Trop de planifications (maximum ${MAX_SCHEDULES})`);
    const id = newId();
    const next = nextRun(v.cron, this.now(), v.tz);
    this.db.run('INSERT INTO automation_schedules (id, playbook_id, cron, tz, win, params, enabled, next_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, v.def.id, v.cron.source, v.tz, v.win ? JSON.stringify({ from: v.win.from, to: v.win.to, days: v.win.days ?? undefined }) : null, JSON.stringify(v.values), v.enabled ? 1 : 0, next, user?.username ?? null, this.now());
    this.journal.add({ type: 'automation', event: 'schedule-create', user, ip, ok: true, detail: `${v.def.name} : « ${v.cron.source} » (${v.tz})${v.win ? ` fenêtre ${v.win.from}-${v.win.to}` : ''}` });
    return this.get(id);
  }

  update(id, input, { user, ip } = {}) {
    this.get(id);
    const v = this.#check(input);
    const next = nextRun(v.cron, this.now(), v.tz);
    this.db.run('UPDATE automation_schedules SET playbook_id = ?, cron = ?, tz = ?, win = ?, params = ?, enabled = ?, next_at = ?, last_status = NULL WHERE id = ?',
      v.def.id, v.cron.source, v.tz, v.win ? JSON.stringify({ from: v.win.from, to: v.win.to, days: v.win.days ?? undefined }) : null, JSON.stringify(v.values), v.enabled ? 1 : 0, next, id);
    this.journal.add({ type: 'automation', event: 'schedule-update', user, ip, ok: true, detail: `${v.def.name} : « ${v.cron.source} » (${v.tz}), ${v.enabled ? 'active' : 'désactivée'}` });
    return this.get(id);
  }

  delete(id, { user, ip } = {}) {
    const s = this.get(id);
    this.db.run('DELETE FROM automation_schedules WHERE id = ?', id);
    this.journal.add({ type: 'automation', event: 'schedule-delete', user, ip, ok: true, detail: `planification ${s.cron} (${s.tz}) supprimée` });
  }

  /**
   * Examine les échéances arrivées. Retourne la décision pour chacune (utile aux tests et à l'interface).
   * @returns {Promise<{id: string, outcome: string}[]>}
   */
  async tick(now = this.now()) {
    const out = [];
    const due = this.db.all('SELECT * FROM automation_schedules WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ?', now);
    for (const r of due) {
      let outcome;
      let following = null;
      try { following = nextRun(parseCron(r.cron), now, r.tz); } catch { /* base altérée : on désactive plus bas */ }
      // On avance l'échéance AVANT toute chose : même si la suite plante, la même échéance ne reviendra jamais.
      this.db.run('UPDATE automation_schedules SET next_at = ?, enabled = ? WHERE id = ?', following, following === null ? 0 : 1, r.id);
      const late = now - r.next_at;
      if (!this.automation.enabled) outcome = 'désactivé';
      else if (late > GRACE_MS) outcome = 'manqué';
      else if (!inWindow(r.win ? parseWindow(JSON.parse(r.win)) : null, now, r.tz)) outcome = 'hors fenêtre';
      else {
        try {
          await this.runs.start({ playbookId: r.playbook_id, values: JSON.parse(r.params || '{}'), trigger: 'schedule', actor: `planning:${r.id}` });
          outcome = 'lancé';
        } catch (err) {
          outcome = err?.code === 'ALREADY_RUNNING' ? 'déjà en cours' : `refusé (${err?.code || 'erreur'})`;
          if (!['ALREADY_RUNNING', 'AUTOMATION_DISABLED'].includes(err?.code)) {
            this.journal.add({ type: 'automation', event: 'schedule-refused', ok: false, detail: `planification ${r.id} : ${String(err?.message || err).slice(0, 200)}` });
          }
        }
      }
      if (outcome === 'manqué') this.journal.add({ type: 'automation', event: 'schedule-missed', ok: false, detail: `planification ${r.id} : échéance manquée de ${Math.round(late / 1000)} s, abandonnée (aucun rattrapage)` });
      this.db.run('UPDATE automation_schedules SET last_at = ?, last_status = ? WHERE id = ?', now, outcome, r.id);
      out.push({ id: r.id, outcome });
    }
    return out;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 15_000);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); }
}
