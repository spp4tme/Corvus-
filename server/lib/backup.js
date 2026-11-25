// Sauvegarde / restauration complète de Corvus en un fichier chiffré (`.cvbk`).
//
// Format (version 1) :
//   "CVBK1\n" + ligne JSON d'en-tête (sel scrypt, iv) + "\n"
//   + AES-256-GCM( gzip( archive ) ) + étiquette GCM (16 octets)
// L'archive est une suite d'entrées : [longueur du nom u32][nom][taille u64][contenu].
// Entrées : `corvus.db` (copie cohérente à chaud via VACUUM INTO), `token` (nécessaire pour
// ouvrir le coffre si aucune passphrase maître n'est utilisée), `blobs/xx/<sha>`.
// La clé vient d'un mot de passe choisi à l'export : le fichier peut être stocké n'importe où.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { deriveKey } from './vault.js';
import { HttpError } from './validate.js';
import { ensureDir } from './store.js';
import { logger } from './log.js';

const log = logger('backup');
const MAGIC = 'CVBK1\n';
const NAME_RE = /^corvus-\d{8}-\d{6}(-[a-z0-9]{4})?\.cvbk$/;
const ENTRY_RE = /^(corvus\.db|token|blobs\/[0-9a-f]{2}\/[0-9a-f]{64})$/;
const PENDING = 'restore-pending';

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 1024) {
    throw new HttpError(400, 'WEAK_PASSWORD', 'Mot de passe de sauvegarde : 10 caractères minimum');
  }
  return pw;
}

export class BackupService {
  constructor({ db, storage, config, journal }) {
    Object.assign(this, { db, storage, config, journal });
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(this.storage.backupDir).filter((f) => NAME_RE.test(f)); } catch { /* vide */ }
    return files.map((name) => {
      const st = fs.statSync(path.join(this.storage.backupDir, name));
      return { name, size: st.size, createdAt: st.mtimeMs };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  path(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HttpError(400, 'BAD_NAME', 'Nom de sauvegarde invalide');
    const file = path.join(this.storage.backupDir, name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'NOT_FOUND', 'Sauvegarde introuvable');
    return file;
  }

  remove(name, user) {
    fs.unlinkSync(this.path(name));
    this.journal.add({ type: 'backup', event: 'delete', user, detail: name });
  }

  async *entries(snapshot) {
    const blobRoot = this.storage.blobDir;
    const files = [['corvus.db', snapshot]];
    const tokenFile = path.join(this.config.dataDir, 'token');
    if (fs.existsSync(tokenFile)) files.push(['token', tokenFile]);
    for (const d of fs.existsSync(blobRoot) ? fs.readdirSync(blobRoot) : []) {
      if (!/^[0-9a-f]{2}$/.test(d)) continue;
      for (const f of fs.readdirSync(path.join(blobRoot, d))) {
        if (/^[0-9a-f]{64}$/.test(f)) files.push([`blobs/${d}/${f}`, path.join(blobRoot, d, f)]);
      }
    }
    for (const [name, file] of files) {
      const size = fs.statSync(file).size;
      const head = Buffer.alloc(4 + Buffer.byteLength(name) + 8);
      head.writeUInt32BE(Buffer.byteLength(name), 0);
      head.write(name, 4);
      head.writeBigUInt64BE(BigInt(size), 4 + Buffer.byteLength(name));
      yield head;
      let sent = 0;
      for await (const chunk of fs.createReadStream(file)) {
        // Taille figée à l'en-tête : un fichier qui grossit pendant la copie est tronqué.
        const part = chunk.subarray(0, Math.max(0, size - sent));
        sent += part.length;
        if (part.length) yield part;
      }
      if (sent < size) throw new Error(`Fichier raccourci pendant la sauvegarde : ${name}`);
    }
  }

  /** Crée une sauvegarde chiffrée par `password` dans le dossier de stockage. */
  async create(password, user) {
    checkPassword(password);
    const dir = this.storage.backupDir;
    ensureDir(dir);
    const name = `corvus-${stamp()}-${crypto.randomBytes(2).toString('hex')}.cvbk`;
    const tmp = path.join(dir, `.${name}.part`);
    const snapshot = path.join(dir, `.snapshot-${crypto.randomBytes(4).toString('hex')}.db`);
    try {
      this.db.backupTo(snapshot);
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const header = Buffer.from(`${MAGIC}${JSON.stringify({ v: 1, kdf: { alg: 'scrypt', salt: salt.toString('base64'), N: 2 ** 15, r: 8, p: 1 }, iv: iv.toString('base64'), createdAt: Date.now() })}\n`);
      fs.writeFileSync(tmp, header, { mode: 0o600 });
      const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt), iv);
      cipher.setAAD(header);
      await pipeline(Readable.from(this.entries(snapshot)), zlib.createGzip({ level: 6 }), cipher, fs.createWriteStream(tmp, { flags: 'a' }));
      fs.appendFileSync(tmp, cipher.getAuthTag());
      fs.renameSync(tmp, path.join(dir, name));
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* rien */ }
      throw err;
    } finally {
      try { fs.unlinkSync(snapshot); } catch { /* rien */ }
    }
    this.journal.add({ type: 'backup', event: 'create', user, detail: name });
    log.info(`Sauvegarde créée : ${name}`);
    return this.list().find((b) => b.name === name);
  }

  /**
   * Vérifie et déchiffre une sauvegarde dans `restore-pending/` ; elle sera appliquée au prochain
   * démarrage (la base ne peut pas être remplacée pendant qu'elle est ouverte).
   */
  async stage(file, password, user) {
    checkPassword(password);
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    let header;
    let tag;
    try {
      const first = Buffer.alloc(Math.min(4096, size));
      fs.readSync(fd, first, 0, first.length, 0);
      if (!first.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) throw new HttpError(400, 'NOT_A_BACKUP', 'Ce fichier n\'est pas une sauvegarde Corvus (.cvbk)');
      const end = first.indexOf(0x0a, MAGIC.length);
      if (end < 0) throw new HttpError(400, 'NOT_A_BACKUP', 'En-tête de sauvegarde illisible');
      header = first.subarray(0, end + 1);
      tag = Buffer.alloc(16);
      fs.readSync(fd, tag, 0, 16, size - 16);
    } finally {
      fs.closeSync(fd);
    }
    const meta = JSON.parse(header.subarray(MAGIC.length).toString('utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, Buffer.from(meta.kdf.salt, 'base64'), meta.kdf), Buffer.from(meta.iv, 'base64'));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);

    const staging = path.join(this.storage.dir, `${PENDING}.tmp`);
    fs.rmSync(staging, { recursive: true, force: true });
    ensureDir(staging);
    try {
      await pipeline(
        fs.createReadStream(file, { start: header.length, end: size - 17 }),
        decipher, zlib.createGunzip(),
        async (source) => unpack(source, staging),
      );
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (/unable to authenticate|auth/i.test(err.message)) throw new HttpError(400, 'BAD_PASSWORD', 'Mot de passe incorrect ou fichier altéré');
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'BAD_BACKUP', `Sauvegarde illisible : ${err.message}`);
    }
    const dbFile = path.join(staging, 'corvus.db');
    try {
      const check = new DatabaseSync(dbFile, { readOnly: true });
      const ok = check.prepare('PRAGMA integrity_check').get();
      check.close();
      if (Object.values(ok)[0] !== 'ok') throw new Error('contrôle d\'intégrité échoué');
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new HttpError(400, 'BAD_BACKUP', `Base de la sauvegarde invalide : ${err.message}`);
    }
    const pending = path.join(this.storage.dir, PENDING);
    fs.rmSync(pending, { recursive: true, force: true });
    fs.renameSync(staging, pending);
    this.journal.add({ type: 'backup', event: 'restore-staged', user, detail: `sauvegarde du ${new Date(meta.createdAt).toISOString()}` });
    return { ok: true, createdAt: meta.createdAt, restartRequired: true };
  }
}

/** Écrit les entrées de l'archive dans `dest` (noms strictement contrôlés : aucune évasion de dossier). */
async function unpack(source, dest) {
  let buf = Buffer.alloc(0);
  let fd = null;
  let remaining = 0;
  let count = 0;
  for await (const chunk of source) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (fd !== null) {
        const take = Math.min(remaining, buf.length);
        if (!take) break;
        fs.writeSync(fd, buf, 0, take);
        buf = buf.subarray(take);
        remaining -= take;
        if (remaining === 0) { fs.closeSync(fd); fd = null; }
        continue;
      }
      if (buf.length < 4) break;
      const nameLen = buf.readUInt32BE(0);
      if (nameLen > 200) throw new Error('entrée invalide');
      if (buf.length < 12 + nameLen) break;
      const name = buf.subarray(4, 4 + nameLen).toString('utf8');
      const size = Number(buf.readBigUInt64BE(4 + nameLen));
      if (!ENTRY_RE.test(name)) throw new Error(`entrée inattendue : ${name.slice(0, 80)}`);
      buf = buf.subarray(12 + nameLen);
      const target = path.join(dest, ...name.split('/'));
      ensureDir(path.dirname(target));
      fd = fs.openSync(target, 'w', 0o600);
      remaining = size;
      count++;
      if (size === 0) { fs.closeSync(fd); fd = null; }
    }
  }
  if (fd !== null || buf.length) throw new Error('archive tronquée');
  if (!count) throw new Error('archive vide');
}

/**
 * Au démarrage, avant d'ouvrir la base : applique une restauration en attente.
 * L'état actuel est conservé dans `pre-restore-<date>/` (retour arrière manuel possible).
 */
export function applyPendingRestore(storage, dataDir) {
  const pending = path.join(storage.dir, PENDING);
  if (!fs.existsSync(path.join(pending, 'corvus.db'))) return null;
  const keep = path.join(storage.dir, `pre-restore-${stamp()}`);
  ensureDir(keep);
  for (const f of ['corvus.db', 'corvus.db-wal', 'corvus.db-shm']) {
    const p = path.join(storage.dir, f);
    if (fs.existsSync(p)) fs.renameSync(p, path.join(keep, f));
  }
  if (fs.existsSync(storage.blobDir)) fs.renameSync(storage.blobDir, path.join(keep, 'blobs'));
  fs.renameSync(path.join(pending, 'corvus.db'), storage.dbFile);
  if (fs.existsSync(path.join(pending, 'blobs'))) fs.renameSync(path.join(pending, 'blobs'), storage.blobDir);
  else ensureDir(storage.blobDir);
  const tokenFile = path.join(dataDir, 'token');
  if (fs.existsSync(path.join(pending, 'token'))) {
    if (fs.existsSync(tokenFile)) fs.copyFileSync(tokenFile, path.join(keep, 'token'));
    fs.copyFileSync(path.join(pending, 'token'), tokenFile);
    try { fs.chmodSync(tokenFile, 0o600); } catch { /* Windows */ }
  }
  fs.rmSync(pending, { recursive: true, force: true });
  log.warn(`Restauration appliquée. Ancien état conservé dans ${keep}`);
  return keep;
}
