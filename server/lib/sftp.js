// Opérations SFTP (aucune commande shell : tout passe par le protocole SFTP).
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { HttpError } from './validate.js';

const P = path.posix;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const MAX_ENTRIES = 5000;
const MAX_DELETE = 20000;

export const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml',
};

export function mapSftpError(err, p) {
  if (err instanceof HttpError) return err;
  const where = p ? ` : ${p}` : '';
  switch (err?.code) {
    case 2: case 'ENOENT': return new HttpError(404, 'NOT_FOUND', `Introuvable${where}`);
    case 3: case 'EACCES': return new HttpError(403, 'PERMISSION_DENIED', `Permission refusée${where}`);
    case 4: return new HttpError(400, 'SFTP_FAILURE', `Opération refusée par le serveur${where}${err.message && err.message !== 'Failure' ? ` (${err.message})` : ''}`);
    default: return new HttpError(502, 'SFTP_ERROR', `Erreur SFTP${where} : ${err?.message || err}`);
  }
}

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
});

export function typeOf(mode) {
  const t = mode & S_IFMT;
  if (t === S_IFDIR) return 'dir';
  if (t === S_IFLNK) return 'link';
  if (t === S_IFREG) return 'file';
  return 'other';
}

export class SftpService {
  constructor({ pool, hosts, journal, config }) {
    Object.assign(this, { pool, hosts, journal, config });
    this.homes = new Map();
  }

  log(hostId, event, detail, ok = true) {
    this.journal.add({ type: 'sftp', event, host: this.hosts.get(hostId), detail, ok });
  }

  /** À appeler quand la connexion d'un hôte change (utilisateur, adresse…) : le dossier personnel peut différer. */
  forget(hostId) {
    this.homes.delete(hostId);
  }

  async home(hostId, sftp) {
    if (!this.homes.has(hostId)) this.homes.set(hostId, await call(sftp, 'realpath', '.'));
    return this.homes.get(hostId);
  }

  /** Normalise un chemin : absolu, ou relatif au dossier personnel (~). */
  async resolve(hostId, sftp, p) {
    if (!p || p === '~' || p === '.') return this.home(hostId, sftp);
    if (p.startsWith('~/')) return P.join(await this.home(hostId, sftp), p.slice(2));
    if (!p.startsWith('/')) return P.join(await this.home(hostId, sftp), p);
    return P.normalize(p);
  }

  async open(hostId, p) {
    const sftp = await this.pool.sftp(hostId);
    const abs = await this.resolve(hostId, sftp, p);
    return { sftp, abs };
  }

  async list(hostId, p) {
    const { sftp, abs } = await this.open(hostId, p);
    let items;
    try {
      items = await call(sftp, 'readdir', abs);
    } catch (err) {
      throw mapSftpError(err, abs);
    }
    const truncated = items.length > MAX_ENTRIES;
    if (truncated) items = items.slice(0, MAX_ENTRIES);
    const entries = await Promise.all(items.filter((i) => i.filename !== '.' && i.filename !== '..').map(async (i) => {
      let type = typeOf(i.attrs.mode);
      let target;
      if (type === 'link') {
        try {
          const st = await call(sftp, 'stat', P.join(abs, i.filename));
          target = typeOf(st.mode);
        } catch { target = 'broken'; }
      }
      return {
        name: i.filename,
        type,
        target,
        size: i.attrs.size,
        mtime: i.attrs.mtime,
        mode: i.attrs.mode & 0o7777,
        hidden: i.filename.startsWith('.'),
      };
    }));
    const isDir = (e) => e.type === 'dir' || e.target === 'dir';
    entries.sort((a, b) => (isDir(b) - isDir(a)) || a.name.localeCompare(b.name, 'fr', { numeric: true }));
    return { path: abs, home: await this.home(hostId, sftp), entries, truncated };
  }

  async stat(hostId, p) {
    const { sftp, abs } = await this.open(hostId, p);
    try {
      const st = await call(sftp, 'stat', abs);
      return { sftp, abs, st, type: typeOf(st.mode) };
    } catch (err) {
      throw mapSftpError(err, abs);
    }
  }

  async readText(hostId, p) {
    const { sftp, abs, st, type } = await this.stat(hostId, p);
    if (type !== 'file') throw new HttpError(400, 'NOT_A_FILE', 'Ce n\'est pas un fichier');
    if (st.size > this.config.maxEditBytes) {
      throw new HttpError(413, 'FILE_TOO_LARGE', `Fichier trop gros pour l'éditeur (${Math.round(st.size / 1024)} Ko > 2 Mo) — téléchargez-le.`);
    }
    const buf = await readAll(sftp.createReadStream(abs), this.config.maxEditBytes + 1);
    if (buf.subarray(0, 8192).includes(0)) throw new HttpError(415, 'BINARY', 'Fichier binaire : prévisualisation texte impossible');
    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new HttpError(415, 'NOT_UTF8', 'Encodage non UTF-8 : édition désactivée pour éviter de corrompre le fichier');
    }
    return { path: abs, content, size: st.size, mtime: st.mtime };
  }

  /**
   * Lecture bornée d'un fichier texte pour la comparaison : taille maximale `maxBytes`, refus du binaire
   * et de l'UTF-8 invalide. Renvoie le texte tel quel (fins de ligne comprises).
   */
  async readLimited(hostId, p, maxBytes) {
    const { sftp, abs, st, type } = await this.stat(hostId, p);
    if (type !== 'file') throw new HttpError(400, 'NOT_A_FILE', 'Ce n\'est pas un fichier');
    if (st.size > maxBytes) throw new HttpError(413, 'FILE_TOO_LARGE', `Fichier trop gros (${Math.round(st.size / 1024)} Ko > ${Math.round(maxBytes / 1024)} Ko)`);
    const buf = await readAll(sftp.createReadStream(abs), maxBytes + 1);
    if (buf.subarray(0, 8192).includes(0)) throw new HttpError(415, 'BINARY', 'Fichier binaire : comparaison impossible');
    try {
      return { path: abs, text: new TextDecoder('utf-8', { fatal: true }).decode(buf), size: buf.length };
    } catch {
      throw new HttpError(415, 'NOT_UTF8', 'Encodage non UTF-8 : comparaison impossible');
    }
  }

  async writeText(hostId, p, content, expectedMtime) {
    if (Buffer.byteLength(content, 'utf8') > this.config.maxEditBytes) throw new HttpError(413, 'FILE_TOO_LARGE', 'Contenu > 2 Mo');
    const { sftp, abs } = await this.open(hostId, p);
    if (expectedMtime !== undefined) {
      try {
        const st = await call(sftp, 'stat', abs);
        if (st.mtime !== expectedMtime) {
          throw new HttpError(409, 'CONFLICT', 'Le fichier a été modifié sur le serveur depuis son ouverture. Rechargez-le avant d\'enregistrer.');
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err.code !== 2) throw mapSftpError(err, abs);
      }
    }
    try {
      await this.#replaceContent(sftp, abs, Buffer.from(content, 'utf8'));
      const st = await call(sftp, 'stat', abs);
      this.log(hostId, 'edit', abs);
      return { path: abs, size: st.size, mtime: st.mtime };
    } catch (err) {
      this.log(hostId, 'edit', abs, false);
      throw mapSftpError(err, abs);
    }
  }

  /**
   * Enregistre un fichier sans jamais le laisser tronqué : écriture dans un fichier voisin puis renommage.
   * Écriture directe seulement si le renommage changerait le propriétaire (fichier d'un autre compte) ou si le
   * dossier est fermé en écriture ; un lien symbolique est suivi (c'est sa cible qui est remplacée).
   */
  async #replaceContent(sftp, abs, buf) {
    const target = await call(sftp, 'realpath', abs).catch(() => abs);
    const previous = await call(sftp, 'stat', target).catch(() => null);
    const direct = () => pipeline(bufferStream(buf), sftp.createWriteStream(target, { flags: 'w' }));
    const tmp = P.join(P.dirname(target), `.${P.basename(target).slice(0, 100)}.corvus-${crypto.randomBytes(4).toString('hex')}.part`);
    try {
      await pipeline(bufferStream(buf), sftp.createWriteStream(tmp, { flags: 'wx' }));
    } catch (err) {
      await call(sftp, 'unlink', tmp).catch(() => {});
      if (err?.code === 3) return direct(); // dossier non modifiable, fichier modifiable
      throw err;
    }
    try {
      const mine = await call(sftp, 'stat', tmp);
      if (previous && previous.uid != null && mine.uid != null && previous.uid !== mine.uid) {
        await call(sftp, 'unlink', tmp).catch(() => {});
        return direct();
      }
      const exists = () => call(sftp, 'lstat', target).then((st) => st, () => null);
      await finalizeUpload(sftp, tmp, target, { overwrite: true, previous, exists });
    } catch (err) {
      await call(sftp, 'unlink', tmp).catch(() => {});
      throw err;
    }
  }

  /** Flux de lecture pour téléchargement / aperçu. */
  async readStream(hostId, p, maxBytes) {
    const { sftp, abs, st, type } = await this.stat(hostId, p);
    if (type !== 'file') throw new HttpError(400, 'NOT_A_FILE', 'Ce n\'est pas un fichier');
    if (maxBytes && st.size > maxBytes) throw new HttpError(413, 'FILE_TOO_LARGE', 'Fichier trop gros pour l\'aperçu');
    // La connexion reste « active » pendant tout le transfert (sinon coupée après SSH_IDLE_MIN).
    const release = this.pool.hold(hostId);
    const stream = sftp.createReadStream(abs);
    stream.once('close', release);
    stream.once('error', release);
    return { stream, size: st.size, abs, name: P.basename(abs) };
  }

  /**
   * Téléversement atomique : écriture dans un fichier temporaire voisin, puis renommage.
   * Un échec ou une coupure en cours de route ne détruit donc jamais le fichier existant.
   */
  async upload(hostId, dir, name, source, { overwrite = false } = {}) {
    const { sftp, abs: dirAbs } = await this.open(hostId, dir);
    const target = P.join(dirAbs, name);
    const tmp = P.join(dirAbs, `.${name.slice(0, 100)}.corvus-${crypto.randomBytes(4).toString('hex')}.part`);
    let written = 0;
    const limit = this.config.maxUploadBytes;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > limit) return cb(new HttpError(413, 'TOO_LARGE', `Fichier trop volumineux (> ${Math.round(limit / 1048576)} Mo)`));
        cb(null, chunk);
      },
    });
    const exists = () => call(sftp, 'lstat', target).then((st) => st, () => null);
    const previous = await exists();
    if (previous && !overwrite) throw new HttpError(409, 'EXISTS', `« ${name} » existe déjà dans ce dossier`);
    const release = this.pool.hold(hostId);
    try {
      try {
        await pipeline(source, counter, sftp.createWriteStream(tmp, { flags: 'wx' }));
      } catch (err) {
        await call(sftp, 'unlink', tmp).catch(() => {});
        throw err;
      }
      try {
        await finalizeUpload(sftp, tmp, target, { overwrite, previous, exists });
      } catch (err) {
        await call(sftp, 'unlink', tmp).catch(() => {});
        throw err;
      }
    } catch (err) {
      this.log(hostId, 'upload', target, false);
      throw mapSftpError(err, target);
    } finally {
      release();
    }
    this.log(hostId, 'upload', `${target} (${written} o)`);
    return { path: target, size: written };
  }

  async mkdir(hostId, p) {
    const { sftp, abs } = await this.open(hostId, p);
    try { await call(sftp, 'mkdir', abs); } catch (err) { throw mapSftpError(err, abs); }
    this.log(hostId, 'mkdir', abs);
    return { path: abs };
  }

  async rename(hostId, from, to) {
    const sftp = await this.pool.sftp(hostId);
    const a = await this.resolve(hostId, sftp, from);
    const b = await this.resolve(hostId, sftp, to);
    const exists = await call(sftp, 'lstat', b).then(() => true, () => false);
    if (exists) throw new HttpError(409, 'EXISTS', 'La destination existe déjà');
    try { await call(sftp, 'rename', a, b); } catch (err) { throw mapSftpError(err, a); }
    this.log(hostId, 'rename', `${a} → ${b}`);
    return { path: b };
  }

  async remove(hostId, p) {
    const { sftp, abs } = await this.open(hostId, p);
    const home = await this.home(hostId, sftp);
    if (abs === '/' || abs === home || P.dirname(abs) === abs) {
      throw new HttpError(400, 'REFUSED', 'Suppression refusée pour ce dossier (racine ou dossier personnel)');
    }
    let count = 0;
    const rm = async (target) => {
      const st = await call(sftp, 'lstat', target);
      if (++count > MAX_DELETE) throw new HttpError(400, 'TOO_MANY', `Plus de ${MAX_DELETE} éléments : utilisez le terminal`);
      if (typeOf(st.mode) === 'dir') {
        const items = await call(sftp, 'readdir', target);
        for (const i of items) {
          if (i.filename === '.' || i.filename === '..') continue;
          await rm(P.join(target, i.filename));
        }
        await call(sftp, 'rmdir', target);
      } else {
        await call(sftp, 'unlink', target);
      }
    };
    try {
      await rm(abs);
    } catch (err) {
      this.log(hostId, 'delete', abs, false);
      throw mapSftpError(err, abs);
    }
    this.log(hostId, 'delete', `${abs}${count > 1 ? ` (${count} éléments)` : ''}`);
    return { deleted: count };
  }
}

/** Remplace `target` par `tmp` sans jamais laisser l'utilisateur sans fichier. */
async function finalizeUpload(sftp, tmp, target, { overwrite, previous, exists }) {
  if (previous && previous.mode != null) {
    // Conserve les droits du fichier remplacé (le fichier temporaire a ceux par défaut).
    await call(sftp, 'chmod', tmp, previous.mode & 0o7777).catch(() => {});
  }
  if (!overwrite) {
    if (await exists()) throw new HttpError(409, 'EXISTS', 'Le fichier vient d\'être créé par ailleurs');
    await call(sftp, 'rename', tmp, target);
    return;
  }
  // OpenSSH : posix-rename remplace atomiquement la destination.
  try {
    await call(sftp, 'ext_openssh_rename', tmp, target);
    return;
  } catch { /* extension absente → renommage classique */ }
  try {
    await call(sftp, 'rename', tmp, target);
  } catch (err) {
    if (!(await exists())) throw err;
    // Serveur SFTP sans écrasement : le fichier complet est déjà dans `tmp`, la fenêtre de risque est minime.
    await call(sftp, 'unlink', target);
    await call(sftp, 'rename', tmp, target);
  }
}

function readAll(stream, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > max) { stream.destroy(); reject(new HttpError(413, 'FILE_TOO_LARGE', 'Fichier trop gros')); return; }
      chunks.push(c);
    });
    stream.on('error', (e) => reject(mapSftpError(e)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function bufferStream(buf) {
  return Readable.from([buf]);
}
