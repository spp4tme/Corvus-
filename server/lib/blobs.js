// Magasin de « blobs » : gros contenus (enregistrements de session, sauvegardes de fichiers)
// stockés sur disque, compressés (brotli) puis chiffrés (AES-256-GCM, clé du coffre).
// Adressage par contenu : le nom du fichier est le SHA-256 du contenu en clair, donc un même
// contenu n'est stocké qu'une fois (compteur de références dans la table `blobs`).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { HttpError } from './validate.js';
import { ensureDir, writeFileSecure } from './store.js';

const SHA_RE = /^[0-9a-f]{64}$/;

export class BlobStore {
  constructor({ db, vault, dir }) {
    Object.assign(this, { db, vault, dir });
    ensureDir(dir);
  }

  file(sha) {
    if (!SHA_RE.test(sha)) throw new HttpError(400, 'BAD_BLOB', 'Référence de blob invalide');
    return path.join(this.dir, sha.slice(0, 2), sha);
  }

  /** Enregistre un contenu ; retourne son empreinte. */
  put(buf, kind = 'data') {
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const existing = this.db.get('SELECT sha FROM blobs WHERE sha = ?', sha);
    if (existing && fs.existsSync(this.file(sha))) {
      this.db.run('UPDATE blobs SET refs = refs + 1 WHERE sha = ?', sha);
      return sha;
    }
    const packed = this.vault.encryptBuffer(zlib.brotliCompressSync(buf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
    }), 'blob');
    const file = this.file(sha);
    ensureDir(path.dirname(file));
    writeFileSecure(file, packed);
    this.db.run(`INSERT INTO blobs (sha, size, stored_size, kind, refs, created_at) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(sha) DO UPDATE SET refs = refs + 1, stored_size = excluded.stored_size`, sha, buf.length, packed.length, kind, Date.now());
    return sha;
  }

  get(sha) {
    let packed;
    try { packed = fs.readFileSync(this.file(sha)); } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, 'BLOB_MISSING', 'Contenu introuvable sur le disque de stockage (disque changé ou purgé ?)');
      throw err;
    }
    const buf = zlib.brotliDecompressSync(this.vault.decryptBuffer(packed, 'blob'));
    if (crypto.createHash('sha256').update(buf).digest('hex') !== sha) {
      throw new HttpError(500, 'BLOB_CORRUPT', 'Contenu corrompu (empreinte différente)');
    }
    return buf;
  }

  /** Retire une référence ; le fichier est supprimé quand plus personne ne l'utilise. */
  release(sha) {
    if (!sha) return;
    this.db.run('UPDATE blobs SET refs = refs - 1 WHERE sha = ?', sha);
    const row = this.db.get('SELECT refs FROM blobs WHERE sha = ?', sha);
    if (row && row.refs <= 0) {
      this.db.run('DELETE FROM blobs WHERE sha = ?', sha);
      try { fs.unlinkSync(this.file(sha)); } catch { /* déjà absent */ }
    }
  }

  stats() {
    const r = this.db.get('SELECT COUNT(*) AS count, IFNULL(SUM(size), 0) AS size, IFNULL(SUM(stored_size), 0) AS stored FROM blobs');
    return { count: r.count, size: r.size, stored: r.stored };
  }
}
