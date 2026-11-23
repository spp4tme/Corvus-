// Stockage JSON local : écriture atomique (tmp + rename) et permissions 600.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows : sans effet */ }
}

export function writeFileSecure(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* idem */ }
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Fichier de données illisible : ${file} (${err.message})`);
  }
}

export function writeJson(file, value) {
  writeFileSecure(file, JSON.stringify(value, null, 2) + '\n');
}

/** Petit store clé→document persistant, sérialisé à chaque écriture. */
export class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = readJson(file, structuredClone(defaults));
  }
  save() {
    writeJson(this.file, this.data);
  }
}
