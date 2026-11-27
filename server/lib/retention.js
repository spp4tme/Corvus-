// Rétention et agrégation, toutes les heures :
//  - métriques : chaque heure terminée est agrégée (min / moyenne / max) dans `metrics_hourly` ;
//    les points bruts sont gardés `metricsRawDays` jours, les agrégats `metricsHourlyDays` jours ;
//  - enregistrements de session et sauvegardes « annulables » : purgés après leur durée ;
//  - sessions de connexion expirées : supprimées ;
//  - journal d'audit : JAMAIS purgé (chaîne vérifiable).
import { logger } from './log.js';

const log = logger('retention');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export class Retention {
  constructor({ db, blobs, config }) {
    Object.assign(this, { db, blobs, config });
  }

  /** Agrège les heures complètes pas encore agrégées. */
  aggregate(now = Date.now()) {
    const until = Math.floor(now / HOUR) * HOUR; // début de l'heure en cours (exclue)
    const from = this.db.getMeta('retention.aggregatedUntil', 0);
    if (from >= until) return 0;
    const r = this.db.run(`INSERT INTO metrics_hourly (host_id, metric, hour, min, avg, max, n)
      SELECT host_id, metric, (ts / ${HOUR}) * ${HOUR} AS hour, MIN(value), AVG(value), MAX(value), COUNT(*)
      FROM metrics_raw WHERE ts >= ? AND ts < ? GROUP BY host_id, metric, hour
      ON CONFLICT(host_id, metric, hour) DO UPDATE SET min = excluded.min, avg = excluded.avg, max = excluded.max, n = excluded.n`,
    from, until);
    this.db.setMeta('retention.aggregatedUntil', until);
    return r.changes;
  }

  run(now = Date.now()) {
    const ret = this.config.retention;
    const out = {};
    this.db.tx(() => {
      out.aggregated = this.aggregate(now);
      out.metricsRaw = this.db.run('DELETE FROM metrics_raw WHERE ts < ?', now - ret.metricsRawDays * DAY).changes;
      out.metricsHourly = this.db.run('DELETE FROM metrics_hourly WHERE hour < ?', now - ret.metricsHourlyDays * DAY).changes;
      out.sessions = this.db.run('DELETE FROM auth_sessions WHERE expires_at < ?', now).changes;

      const recs = this.db.all('SELECT id, recording_sha FROM term_sessions WHERE recording_sha IS NOT NULL AND started_at < ?', now - ret.recordingsDays * DAY);
      for (const r of recs) {
        this.db.run('UPDATE term_sessions SET recording_sha = NULL WHERE id = ?', r.id);
        this.blobs.release(r.recording_sha);
      }
      out.recordings = recs.length;

      const undos = this.db.all('SELECT id, files FROM undo_ops WHERE ts < ?', now - ret.undoDays * DAY);
      for (const u of undos) {
        for (const f of JSON.parse(u.files)) this.blobs.release(f.sha);
        this.db.run('DELETE FROM undo_ops WHERE id = ?', u.id);
      }
      out.undo = undos.length;
      // Historique des fichiers : événements anciens, puis contenus que plus aucun événement ne cite.
      const cutoff = now - (ret.rewindDays ?? 90) * DAY;
      out.rewindEvents = this.db.run("DELETE FROM agent_events WHERE ts < ? AND (type LIKE 'file.%' OR type LIKE 'port.%' OR type LIKE 'service.%' OR type LIKE 'pkg.%')", cutoff).changes;
      const orphans = this.db.all(`SELECT v.host_id, v.sha256 FROM agent_versions v WHERE v.received_at < ? AND NOT EXISTS (
        SELECT 1 FROM agent_events e WHERE e.host_id = v.host_id AND e.type LIKE 'file.%' AND (json_extract(e.body, '$.sha') = v.sha256 OR json_extract(e.body, '$.prevSha') = v.sha256))`, cutoff);
      for (const o of orphans) {
        this.db.run('DELETE FROM agent_versions WHERE host_id = ? AND sha256 = ?', o.host_id, o.sha256);
        this.blobs.release(o.sha256);
      }
      out.rewindVersions = orphans.length;
      out.alerts = this.db.run('DELETE FROM alerts WHERE ack_at IS NOT NULL AND ts < ?', now - 90 * DAY).changes;
    });
    // Rend au disque la place libérée dans le journal WAL.
    try { this.db.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;'); } catch { /* base occupée : prochaine fois */ }
    if (out.metricsRaw || out.recordings || out.undo) log.info('Purge', out);
    return out;
  }

  start() {
    const tick = () => { try { this.run(); } catch (err) { log.error('Purge impossible', err); } };
    this.first = setTimeout(tick, 60_000);
    this.first.unref();
    this.timer = setInterval(tick, HOUR);
    this.timer.unref();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }
}
