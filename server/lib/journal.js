// Journal d'audit infalsifiable, stocké dans SQLite.
//
// Chaque entrée contient l'empreinte (SHA-256) de la précédente : `hash = sha256(prev_hash | contenu)`.
// Modifier, insérer ou supprimer une entrée au milieu casse la chaîne, ce que `verify()` détecte.
// Limite (documentée) : quelqu'un qui est root sur le serveur peut recalculer toute la chaîne ;
// l'empreinte de tête (`head()`) peut donc être notée ou exportée pour comparaison ultérieure.
import crypto from 'node:crypto';
import { requestContext } from './context.js';

export const GENESIS = '0'.repeat(64);
const TYPE_RE = /^[a-z][a-z0-9-]{0,19}$/;

export function entryHash(prev, e) {
  const content = JSON.stringify([e.ts, e.type, e.event, e.ok ? 1 : 0, e.user_id ?? null, e.username ?? null,
    e.host_id ?? null, e.host_label ?? null, e.ip ?? null, e.detail ?? null]);
  return crypto.createHash('sha256').update(`${prev}|${content}`).digest('hex');
}

export class Journal {
  /** @param {import('../db/index.js').Db} db */
  constructor(db) {
    this.db = db;
    this.listeners = new Set();
  }

  /**
   * @param {{type: string, event: string, host?: {id: string, name: string, hostname: string, username?: string},
   *          user?: {id: string, username: string}, ip?: string, detail?: string, ok?: boolean}} e
   */
  add(e) {
    if (!TYPE_RE.test(String(e.type))) return null;
    // `user: null` explicite = action système ; absent = compte de la requête en cours.
    const store = requestContext.getStore();
    const user = e.user !== undefined ? e.user : store?.user;
    const ip = e.ip !== undefined ? e.ip : store?.ip;
    const row = {
      ts: Date.now(),
      type: e.type,
      event: String(e.event).slice(0, 40),
      ok: e.ok !== false,
      user_id: user?.id ?? null,
      username: user?.username ?? null,
      host_id: e.host?.id ?? null,
      host_label: e.host ? `${e.host.name} (${e.host.username ? `${e.host.username}@` : ''}${e.host.hostname})` : null,
      ip: ip ? String(ip).slice(0, 64) : null,
      detail: e.detail ? String(e.detail).slice(0, 500) : null,
    };
    try {
      this.db.tx(() => {
        const prev = this.db.get('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')?.hash || GENESIS;
        row.prev_hash = prev;
        row.hash = entryHash(prev, row);
        const r = this.db.run(`INSERT INTO audit (ts, type, event, ok, user_id, username, host_id, host_label, ip, detail, prev_hash, hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.ts, row.type, row.event, row.ok, row.user_id, row.username, row.host_id, row.host_label, row.ip, row.detail, row.prev_hash, row.hash);
        row.seq = Number(r.lastInsertRowid);
      });
    } catch {
      return null; // le journal ne doit jamais casser l'action journalisée
    }
    const view = toView(row);
    for (const fn of this.listeners) { try { fn(view); } catch { /* écouteur fautif ignoré */ } }
    return view;
  }

  /** Abonnement aux nouvelles entrées (alertes, notifications). */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list({ limit = 200, type, hostId, before, hostIds } = {}) {
    const where = [];
    const params = [];
    if (type) { where.push('type = ?'); params.push(type); }
    if (hostId) { where.push('host_id = ?'); params.push(hostId); }
    if (before) { where.push('seq < ?'); params.push(before); }
    if (hostIds) {
      // Utilisateur restreint : seulement ses hôtes (et ses propres actions sans hôte).
      where.push(`(host_id IN (${hostIds.map(() => '?').join(',') || "''"}) OR (host_id IS NULL AND user_id = ?))`);
      params.push(...hostIds.map(String), hostIds.userId ?? '');
    }
    const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
    return this.db.all(sql, ...params, limit).map(toView);
  }

  head() {
    const r = this.db.get('SELECT seq, hash, ts FROM audit ORDER BY seq DESC LIMIT 1');
    return r ? { seq: r.seq, hash: r.hash, ts: r.ts } : { seq: 0, hash: GENESIS, ts: null };
  }

  /** Recalcule toute la chaîne. Retourne la première rupture trouvée. */
  verify() {
    let prev = GENESIS;
    let count = 0;
    let lastSeq = 0;
    for (const r of this.db.prep('SELECT * FROM audit ORDER BY seq').iterate()) {
      count++;
      if (r.prev_hash !== prev) return { ok: false, count, brokenAt: r.seq, reason: 'maillon manquant ou réordonné' };
      if (entryHash(prev, r) !== r.hash) return { ok: false, count, brokenAt: r.seq, reason: 'contenu modifié' };
      prev = r.hash;
      lastSeq = r.seq;
    }
    return { ok: true, count, head: prev, lastSeq };
  }
}

function toView(r) {
  return {
    seq: r.seq, ts: new Date(r.ts).toISOString(), type: r.type, event: r.event, ok: !!r.ok,
    userId: r.user_id || undefined, user: r.username || undefined,
    hostId: r.host_id || undefined, host: r.host_label || undefined, ip: r.ip || undefined,
    detail: r.detail || undefined, hash: r.hash,
  };
}
