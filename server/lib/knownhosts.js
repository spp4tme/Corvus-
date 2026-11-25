// Vérification des host keys SSH en mode TOFU (Trust On First Use).
import crypto from 'node:crypto';

export function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

export function keyType(keyBuf) {
  try {
    const len = keyBuf.readUInt32BE(0);
    return keyBuf.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'inconnu';
  }
}

export class KnownHosts {
  /** @param {import('../db/index.js').Db} db */
  constructor(db) {
    this.db = db;
  }
  static key(hostname, port) {
    return `${hostname}:${port}`;
  }
  get(hostname, port) {
    const r = this.db.get('SELECT fingerprint, type, added_at FROM known_hosts WHERE host_port = ?', KnownHosts.key(hostname, port));
    return r ? { fingerprint: r.fingerprint, type: r.type, addedAt: r.added_at } : null;
  }
  /**
   * @returns {{status: 'known'|'new'|'mismatch', fingerprint, type, expected?}}
   */
  check(hostname, port, keyBuf) {
    const fp = fingerprint(keyBuf);
    const type = keyType(keyBuf);
    const known = this.get(hostname, port);
    if (!known) return { status: 'new', fingerprint: fp, type };
    if (known.fingerprint === fp) return { status: 'known', fingerprint: fp, type };
    return { status: 'mismatch', fingerprint: fp, type, expected: known.fingerprint, expectedType: known.type };
  }
  remember(hostname, port, fp, type) {
    this.db.run(`INSERT INTO known_hosts (host_port, fingerprint, type, added_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(host_port) DO UPDATE SET fingerprint = excluded.fingerprint, type = excluded.type, added_at = excluded.added_at`,
    KnownHosts.key(hostname, port), fp, type, Date.now());
  }
  forget(hostname, port) {
    this.db.run('DELETE FROM known_hosts WHERE host_port = ?', KnownHosts.key(hostname, port));
  }
}
