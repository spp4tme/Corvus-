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
    const id = Number(r.lastInsertRowid);
    this.journal?.add({ type: 'alert', event: a.kind, ok: a.severity === 'info', detail: a.message });
    // `alertId` et `severity` servent à proposer « Acquitter » / « Isoler… » dans la notification (voir push.js).
    this.notify?.({ title: a.severity === 'critical' ? 'Corvus — alerte' : 'Corvus', body: a.message, hostId: a.hostId, alertId: id, severity: a.severity });
    return id;
  }

  list({ limit = 100, open = false, hostIds } = {}) {
    const where = [];
    const params = [];
    if (open) where.push('ack_at IS NULL');
    // Filtre des hôtes autorisés DANS la requête (après le LIMIT, les alertes d'autres hôtes pouvaient tout masquer).
    if (hostIds) { where.push('(host_id IS NULL OR host_id IN (SELECT value FROM json_each(?)))'); params.push(JSON.stringify(hostIds)); }
    const rows = this.db.all(`SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, limit);
    return rows.map((r) => ({
      id: r.id, ts: r.ts, hostId: r.host_id, kind: r.kind, severity: r.severity, message: r.message,
      data: r.data ? JSON.parse(r.data) : null, ackAt: r.ack_at, ackBy: r.ack_by,
    }));
  }

  /** `hostIds` (null = tous) : on n'acquitte que ce qu'on peut voir. */
  ack(id, user, hostIds = null) {
    const row = this.db.get('SELECT host_id, kind FROM alerts WHERE id = ?', id);
    if (!row || (hostIds && row.host_id && !hostIds.includes(row.host_id))) throw new HttpError(404, 'NOT_FOUND', 'Alerte introuvable ou déjà acquittée');
    const r = this.db.run('UPDATE alerts SET ack_at = ?, ack_by = ? WHERE id = ? AND ack_at IS NULL', Date.now(), user?.username ?? null, id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Alerte introuvable ou déjà acquittée');
    this.journal?.add({ type: 'alert', event: 'ack', detail: `alerte ${id} acquittée (${String(row.kind).slice(0, 60)})` });
  }

  /** Alerte non acquittée ? (pour décider des boutons d'une notification) */
  open(id) {
    const r = this.db.get('SELECT id, host_id, severity FROM alerts WHERE id = ? AND ack_at IS NULL', id);
    return r ? { id: r.id, hostId: r.host_id, severity: r.severity } : null;
  }
}
