// Empreinte du « normal » d'un hôte (étape 7.2) — règles et statistiques simples, AUCUNE IA.
//
// Pendant la période d'apprentissage (14 jours par défaut, depuis le premier événement de l'hôte), tout ce qui
// est observé est mémorisé comme normal : programmes lancés (binaire + utilisateur), destinations réseau
// (agrégées par réseau /24 et port), ports en écoute, et un histogramme d'activité par heure.
// Ensuite, un élément JAMAIS vu devient une anomalie : alerte (push) et ajout à la liste « à examiner ».
// Si en plus il apparaît pendant une heure « creuse » (< 1 % de l'activité apprise), l'alerte est critique
// et, si l'option est activée pour l'hôte, le processus est gelé (SIGSTOP) en attendant votre décision.
import { logger } from './log.js';

const log = logger('behavior');
const DAY = 86_400_000;
const QUIET_SHARE = 0.01;
const MIN_HISTORY = 100; // en dessous, l'histogramme horaire n'est pas assez fourni pour juger une heure « creuse »

/** « 203.0.113.45:443 » → « 203.0.113.0/24:443 » ; IPv6 : 3 premiers groupes. Évite qu'un CDN génère mille anomalies. */
export function aggregateDestination(remote) {
  const m4 = /^(\d+)\.(\d+)\.(\d+)\.\d+:(\d+)$/.exec(remote || '');
  if (m4) return `${m4[1]}.${m4[2]}.${m4[3]}.0/24:${m4[4]}`;
  const m6 = /^\[([0-9a-f:]+)\]:(\d+)$/i.exec(remote || '');
  if (m6) return `${m6[1].split(':').slice(0, 3).join(':')}::/48:${m6[2]}`;
  return remote || '?';
}

export class Behavior {
  constructor({ db, alerts, journal, hosts, agents, config }) {
    Object.assign(this, { db, alerts, journal, hosts, agents });
    this.learnDays = config?.behaviorLearnDays ?? 14;
  }

  // --- Paramètres par hôte (table meta) ----------------------------------
  startedAt(hostId) { return this.db.getMeta(`behavior.start.${hostId}`, null); }
  autoFreeze(hostId) { return this.db.getMeta(`behavior.autofreeze.${hostId}`, false) === true; }
  setAutoFreeze(hostId, on) { this.db.setMeta(`behavior.autofreeze.${hostId}`, !!on); }
  learningEnd(hostId) {
    const s = this.startedAt(hostId);
    return s ? s + (this.db.getMeta(`behavior.days.${hostId}`, this.learnDays)) * DAY : null;
  }
  learning(hostId, now = Date.now()) { const e = this.learningEnd(hostId); return e === null || now < e; }

  restartLearning(hostId, days) {
    this.db.run('DELETE FROM behavior_profile WHERE host_id = ?', hostId);
    this.db.setMeta(`behavior.start.${hostId}`, Date.now());
    if (days) this.db.setMeta(`behavior.days.${hostId}`, days);
  }

  // --- Mémorisation -----------------------------------------------------------
  /** Retourne true si l'élément est NOUVEAU (jamais vu). */
  #touch(hostId, kind, item, ts, allowed) {
    const row = this.db.get('SELECT count FROM behavior_profile WHERE host_id = ? AND kind = ? AND item = ?', hostId, kind, item);
    if (row) {
      this.db.run('UPDATE behavior_profile SET count = count + 1, last_seen = ? WHERE host_id = ? AND kind = ? AND item = ?', ts, hostId, kind, item);
      return false;
    }
    this.db.run('INSERT INTO behavior_profile (host_id, kind, item, count, first_seen, last_seen, allowed) VALUES (?, ?, ?, 1, ?, ?, ?)', hostId, kind, item, ts, ts, allowed ? 1 : 0);
    return true;
  }

  #quietHour(hostId, hour) {
    const rows = this.db.all("SELECT item, count FROM behavior_profile WHERE host_id = ? AND kind = 'hour'", hostId);
    const total = rows.reduce((a, r) => a + r.count, 0);
    if (total < MIN_HISTORY) return false;
    const mine = rows.find((r) => r.item === String(hour))?.count || 0;
    return mine / total < QUIET_SHARE;
  }

  /** Traite un événement d'agent. Appelé une seule fois par événement (les renvois sont ignorés en amont). */
  ingest(hostId, event) {
    if (!hostId) return;
    if (this.#ransomEvent(hostId, event)) return;
    const { type, body, ts } = event;
    let kind = null;
    let item = null;
    const items = [];
    if (type === 'proc.start') { kind = 'proc'; item = `${body.exe}|${body.uid}`; }
    else if (type === 'proc.snapshot') for (const p of body.processes || []) items.push(['proc', `${p.exe}|${p.uid}`]);
    else if (type === 'conn.open') { kind = 'conn'; item = `${body.exe || '?'}|${aggregateDestination(body.remote)}`; }
    else if (type === 'conn.snapshot') for (const c of body.connections || []) items.push(['conn', `${c.exe || '?'}|${aggregateDestination(c.remote)}`]);
    else if (type === 'port.open') { kind = 'listen'; item = body.item; }
    else if (type === 'port.snapshot') for (const p of body.items || []) items.push(['listen', p]);
    else return;
    if (kind) items.push([kind, item]);

    // L'heure de l'AGENT ne décide jamais de l'apprentissage : un Pi sans horloge matérielle démarre en
    // 1970 (apprentissage « déjà fini » → avalanche d'alertes), et un hôte compromis pourrait antidater
    // ses événements pour qu'ils soient appris comme normaux. On se fie à l'heure du serveur ; celle de
    // l'agent ne sert qu'à l'histogramme horaire, et seulement si elle est plausible (± 1 jour).
    const now = Date.now();
    const at = Number.isFinite(ts) && Math.abs(ts - now) <= DAY ? ts : now;
    if (this.startedAt(hostId) === null) this.db.setMeta(`behavior.start.${hostId}`, now);
    const learning = this.learning(hostId, now);
    const hour = new Date(at).getHours();
    for (const [k, it] of items) {
      if (!it || String(it).length > 400) continue;
      const isNew = this.#touch(hostId, k, it, at, learning);
      if (!learning && isNew && type !== 'proc.snapshot' && type !== 'conn.snapshot' && type !== 'port.snapshot') this.#anomaly(hostId, k, it, event, hour);
    }
    // Histogramme horaire : démarrages de programmes (pendant l'apprentissage seulement, sinon il se « laverait »).
    if (type === 'proc.start' && learning) this.#touch(hostId, 'hour', String(hour), at, true);
  }

  #anomaly(hostId, kind, item, event, hour) {
    const quiet = this.#quietHour(hostId, hour);
    const host = this.hosts.find(hostId);
    const name = host?.name || 'hôte';
    const what = { proc: 'Programme jamais vu', conn: 'Destination réseau jamais vue', listen: 'Port en écoute jamais vu' }[kind];
    const via = event.body.via?.ssh ? ` (session SSH de ${event.body.via.ssh})` : '';
    const severity = quiet && kind === 'proc' ? 'critical' : 'warn';
    const message = `${name} : ${what} — ${item.replace('|', ' · ')}${via}${quiet ? ' · pendant une heure habituellement calme' : ''}`;
    this.alerts?.raise({ kind: `anomaly:${kind}:${item}`.slice(0, 120), severity, message, hostId, data: { kind, item, quiet, lineage: event.body.lineage, pid: event.body.pid } });
    this.journal?.add({ type: 'behavior', event: 'anomaly', host, user: null, ip: null, ok: false, detail: `${kind} ${item}${quiet ? ' [heure creuse]' : ''}` });
    if (severity === 'critical' && this.autoFreeze(hostId) && event.body.pid && event.body.start) {
      this.agents?.request(hostId, 'proc.freeze', { pid: event.body.pid, start: event.body.start }).then(() => {
        this.journal?.add({ type: 'behavior', event: 'auto-freeze', host, user: null, ip: null, detail: `pid ${event.body.pid} ${event.body.exe} gelé automatiquement` });
        this.alerts?.raise({ kind: `anomaly:frozen:${event.body.pid}`, severity: 'critical', hostId, message: `${name} : ${event.body.exe} gelé automatiquement — autorisez-le (dégeler) ou tuez-le depuis Radiographie` });
      }).catch((err) => log.warn(`gel automatique impossible : ${err.message}`));
    }
  }

  // --- Anti-ransomware (étape 7.3) ------------------------------------------------
  autoIsolate(hostId) { return this.db.getMeta(`behavior.autoisolate.${hostId}`, false) === true; }
  setAutoIsolate(hostId, on) { this.db.setMeta(`behavior.autoisolate.${hostId}`, !!on); }
  isolateTtl(hostId) { return this.db.getMeta(`behavior.isolatettl.${hostId}`, 900); }
  setIsolateTtl(hostId, sec) { this.db.setMeta(`behavior.isolatettl.${hostId}`, sec); }

  /** Événements de défense envoyés par l'agent. Retourne true si l'événement a été traité ici. */
  #ransomEvent(hostId, { type, body }) {
    const host = this.hosts.find(hostId);
    const name = host?.name || 'hôte';
    if (type === 'net.isolated' || type === 'net.released') {
      this.journal?.add({ type: 'ransom', event: type === 'net.isolated' ? 'isolated' : 'released', host, user: null, ip: null, detail: type === 'net.isolated' ? `isolement réseau posé (${body.ttlSec} s)` : `isolement réseau levé${body.auto ? ' automatiquement' : ''}` });
      return true;
    }
    if (type !== 'canary.touched' && type !== 'ransom.suspect') return false;
    const writers = Array.isArray(body.writers) ? body.writers : [];
    const top = writers[0];
    const what = type === 'canary.touched'
      ? `fichier piège ${body.change === 'file.deleted' ? 'supprimé' : 'modifié'} : ${body.path}`
      : `${body.count} fichiers chiffrés en ${body.windowSec} s (ex. ${(body.sample || []).slice(0, 2).join(', ')})`;
    const actions = [];
    const reactions = [];
    if (this.autoFreeze(hostId) && top) reactions.push(this.agents.request(hostId, 'proc.freeze', { pid: top.pid, start: top.start }).then(() => actions.push(`${top.exe} (pid ${top.pid}) gelé`)));
    if (this.autoIsolate(hostId)) reactions.push(this.agents.request(hostId, 'net.isolate', { ttlSec: this.isolateTtl(hostId) }).then(() => actions.push(`hôte isolé du réseau ${this.isolateTtl(hostId)} s (Tailscale et Corvus conservés)`)));
    Promise.allSettled(reactions).then((res) => {
      res.filter((x) => x.status === 'rejected').forEach((x) => actions.push(`réaction impossible : ${x.reason?.message}`));
      this.journal?.add({ type: 'ransom', event: type === 'canary.touched' ? 'canary' : 'suspect', host, user: null, ip: null, ok: false, detail: `${what}${top ? ` · écrivain principal : ${top.exe} (pid ${top.pid})` : ''}${actions.length ? ` → ${actions.join(' ; ')}` : ''}` });
      this.alerts?.raise({
        kind: `ransom:${type === 'canary.touched' ? `canary:${body.path}` : 'suspect'}`.slice(0, 120), severity: 'critical', hostId,
        message: `${name} : RANSOMWARE POSSIBLE — ${what}${top ? ` · écrivain principal : ${top.exe}` : ''}${actions.length ? ` → ${actions.join(' ; ')}` : ' → aucune réaction automatique (options désactivées)'}`,
        data: { type, body },
      });
    });
    return true;
  }

  // --- Lecture / décisions ------------------------------------------------------
  overview(hostId) {
    const counts = Object.fromEntries(this.db.all('SELECT kind, COUNT(*) AS n FROM behavior_profile WHERE host_id = ? AND allowed = 1 GROUP BY kind', hostId).map((r) => [r.kind, r.n]));
    const anomalies = this.db.all("SELECT kind, item, count, first_seen AS firstSeen, last_seen AS lastSeen FROM behavior_profile WHERE host_id = ? AND allowed = 0 AND kind != 'hour' ORDER BY first_seen DESC LIMIT 200", hostId);
    const hours = Array.from({ length: 24 }, (_, h) => this.db.get("SELECT count FROM behavior_profile WHERE host_id = ? AND kind = 'hour' AND item = ?", hostId, String(h))?.count || 0);
    const end = this.learningEnd(hostId);
    return { learning: this.learning(hostId), startedAt: this.startedAt(hostId), endsAt: end, learnDays: this.db.getMeta(`behavior.days.${hostId}`, this.learnDays), counts, anomalies, hours, autoFreeze: this.autoFreeze(hostId), autoIsolate: this.autoIsolate(hostId), isolateTtl: this.isolateTtl(hostId) };
  }

  allow(hostId, kind, item) {
    const r = this.db.run('UPDATE behavior_profile SET allowed = 1 WHERE host_id = ? AND kind = ? AND item = ?', hostId, kind, item);
    return r.changes > 0;
  }
}
