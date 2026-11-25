// Alertes : stockées en base, journalisées, et envoyées en notification push.
// Une même alerte (type + hôte) non acquittée n'est pas répétée avant `dedupMs`.
import { HttpError } from './validate.js';

export class Alerts {
  constructor({ db, journal, notify, dedupMs = 3600_000 }) {
    Object.assign(this, { db, journal, notify, dedupMs });
  }

  /** @param {{kind: string, severity: 'info'|'warn'|'critical', message: string, hostId?: string, data?: object}} a */
  raise(a) {
    const recent = this.db.get(`SELECT id FROM alerts WHERE kind = ? AND IFNULL(host_id, '') = ? AND ack_at IS NULL AND ts > ?
      ORDER BY id DESC LIMIT 1`, a.kind, a.hostId || '', Date.now() - this.dedupMs);
    if (recent) return null;
    const r = this.db.run('INSERT INTO alerts (ts, host_id, kind, severity, message, data) VALUES (?, ?, ?, ?, ?, ?)',
      Date.now(), a.hostId ?? null, a.kind, a.severity, String(a.message).slice(0, 500), a.data ? JSON.stringify(a.data) : null);
    this.journal?.add({ type: 'alert', event: a.kind, ok: a.severity === 'info', detail: a.message });
    this.notify?.({ title: a.severity === 'critical' ? 'Corvus — alerte' : 'Corvus', body: a.message, hostId: a.hostId });
    return Number(r.lastInsertRowid);
  }

  list({ limit = 100, open = false, hostIds } = {}) {
    let rows = this.db.all(`SELECT * FROM alerts ${open ? 'WHERE ack_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`, limit);
    if (hostIds) rows = rows.filter((r) => !r.host_id || hostIds.includes(r.host_id));
    return rows.map((r) => ({
      id: r.id, ts: r.ts, hostId: r.host_id, kind: r.kind, severity: r.severity, message: r.message,
      data: r.data ? JSON.parse(r.data) : null, ackAt: r.ack_at, ackBy: r.ack_by,
    }));
  }

  ack(id, user) {
    const r = this.db.run('UPDATE alerts SET ack_at = ?, ack_by = ? WHERE id = ? AND ack_at IS NULL', Date.now(), user?.username ?? null, id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Alerte introuvable ou déjà acquittée');
  }
}
