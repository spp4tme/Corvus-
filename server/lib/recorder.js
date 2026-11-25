// Enregistrement des sessions de terminal au format asciicast v2 (celui d'asciinema) :
//   ligne 1 : en-tête JSON { version: 2, width, height, timestamp, title }
//   ensuite : [secondes écoulées, "o", texte affiché]  ou  [secondes, "r", "COLSxROWS"].
// Seule la SORTIE est enregistrée (jamais les frappes : un mot de passe tapé pour sudo n'est pas
// affiché, il n'apparaît donc pas). L'enregistrement est stocké chiffré à la fermeture (blobs).
import { HttpError } from './validate.js';
import { logger } from './log.js';

const log = logger('rec');

export class Recorder {
  constructor({ db, blobs, maxBytes = 50 * 1024 * 1024, enabled = true }) {
    Object.assign(this, { db, blobs, maxBytes, enabled });
  }

  start(s, host) {
    this.db.run(`INSERT INTO term_sessions (id, host_id, user_id, username, host_label, title, tmux, started_at, cols, rows)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, s.id, s.hostId, s.owner?.id ?? null, s.owner?.username ?? null,
    `${host.name} (${host.username}@${host.hostname})`, s.title, s.tmux, s.createdAt, s.cols, s.rows);
    if (!this.enabled) return;
    const header = { version: 2, width: s.cols, height: s.rows, timestamp: Math.floor(s.createdAt / 1000), title: s.title, env: { TERM: 'xterm-256color' } };
    s.rec = { lines: [JSON.stringify(header)], size: 0, decoder: new TextDecoder('utf-8'), truncated: false, done: false };
  }

  push(s, type, data) {
    const r = s.rec;
    if (!r || r.done || r.truncated) return;
    const line = JSON.stringify([Number(((Date.now() - s.createdAt) / 1000).toFixed(3)), type, data]);
    r.size += line.length + 1;
    if (r.size > this.maxBytes) {
      r.truncated = true;
      r.lines.push(JSON.stringify([Number(((Date.now() - s.createdAt) / 1000).toFixed(3)), 'o', '\r\n[corvus] enregistrement interrompu : taille maximale atteinte (RECORDING_MAX_MB)\r\n']));
      return;
    }
    r.lines.push(line);
  }

  output(s, chunk) {
    if (!s.rec) return;
    // Décodage en flux : un caractère UTF-8 coupé entre deux paquets n'est pas abîmé.
    const text = s.rec.decoder.decode(chunk, { stream: true });
    if (text) this.push(s, 'o', text);
  }

  resize(s, cols, rows) {
    this.push(s, 'r', `${cols}x${rows}`);
  }

  /** Ferme l'enregistrement (idempotent) : stockage chiffré + métadonnées. */
  finish(s) {
    const ended = Date.now();
    const r = s.rec;
    if (r?.done) return;
    try {
      let sha = null;
      let bytes = null;
      if (r) {
        r.done = true;
        const tail = r.decoder.decode();
        if (tail) r.lines.push(JSON.stringify([Number(((ended - s.createdAt) / 1000).toFixed(3)), 'o', tail]));
        if (r.lines.length > 1) {
          const buf = Buffer.from(`${r.lines.join('\n')}\n`, 'utf8');
          sha = this.blobs.put(buf, 'recording');
          bytes = buf.length;
        }
        r.lines = [];
      }
      this.db.run('UPDATE term_sessions SET ended_at = ?, recording_sha = ?, recording_bytes = ?, duration_ms = ? WHERE id = ?',
        ended, sha, bytes, ended - s.createdAt, s.id);
    } catch (err) {
      log.warn(`Enregistrement de ${s.id} non sauvegardé`, err);
    }
  }

  /** Sessions enregistrées ; `userId` limite aux sessions du compte, `hostIds` aux hôtes autorisés. */
  list({ userId, hostIds, hostId, limit = 100 } = {}) {
    const where = ['recording_sha IS NOT NULL'];
    const params = [];
    if (userId) { where.push('user_id = ?'); params.push(userId); }
    if (hostId) { where.push('host_id = ?'); params.push(hostId); }
    let rows = this.db.all(`SELECT * FROM term_sessions WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`, ...params, limit);
    if (hostIds) rows = rows.filter((x) => hostIds.includes(x.host_id));
    return rows.map((x) => ({
      id: x.id, hostId: x.host_id, host: x.host_label, user: x.username, userId: x.user_id, title: x.title,
      startedAt: x.started_at, endedAt: x.ended_at, durationMs: x.duration_ms, bytes: x.recording_bytes,
    }));
  }

  get(id) {
    const row = this.db.get('SELECT * FROM term_sessions WHERE id = ?', id);
    if (!row?.recording_sha) throw new HttpError(404, 'NOT_FOUND', 'Enregistrement introuvable (expiré ou session sans enregistrement)');
    return { row, cast: this.blobs.get(row.recording_sha) };
  }
}
