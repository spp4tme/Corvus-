// Coffre de secrets chiffré au repos : AES-256-GCM, clé dérivée par scrypt
// d'une passphrase maître (CORVUS_MASTER_PASSPHRASE) ou, à défaut, du token d'accès.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readJson, writeJson } from './store.js';
import { HttpError } from './validate.js';

const AAD = Buffer.from('corvus-secrets-v1');
const KDF = { N: 2 ** 15, r: 8, p: 1 };

function deriveKey(material, salt, params = KDF) {
  return crypto.scryptSync(material, salt, 32, { ...params, maxmem: 128 * params.N * params.r * 2 });
}

function encrypt(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(key, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

export class Vault {
  /**
   * @param {string} file chemin du fichier chiffré
   * @param {{token: string, passphrase?: string}} materials
   */
  constructor(file, { token, passphrase }) {
    this.file = file;
    this.source = passphrase ? 'passphrase' : 'token';
    const material = passphrase || token;
    const existing = readJson(file, null);

    if (!existing) {
      this.salt = crypto.randomBytes(16);
      this.key = deriveKey(material, this.salt);
      this.secrets = {};
      this.save();
      return;
    }

    this.salt = Buffer.from(existing.kdf.salt, 'base64');
    const params = { N: existing.kdf.N, r: existing.kdf.r, p: existing.kdf.p };

    if (existing.kdf.src === 'passphrase' && !passphrase) {
      throw new Error('Les secrets sont protégés par une passphrase maître : définissez CORVUS_MASTER_PASSPHRASE.');
    }
    // Migration automatique token → passphrase si une passphrase vient d'être définie.
    const openMaterial = existing.kdf.src === 'passphrase' ? passphrase : token;
    try {
      this.secrets = decrypt(deriveKey(openMaterial, this.salt, params), existing.box);
    } catch {
      throw new Error(existing.kdf.src === 'passphrase'
        ? 'Passphrase maître incorrecte : impossible de déchiffrer les secrets.'
        : 'Impossible de déchiffrer les secrets avec le token actuel (data/token modifié à la main ?).');
    }
    if (existing.kdf.src !== this.source) {
      this.salt = crypto.randomBytes(16);
    }
    this.key = deriveKey(material, this.salt);
    this.diskSalt = existing.kdf.salt;
    if (existing.kdf.src !== this.source) this.save({ force: true });
  }

  /** Re-chiffre tout avec un nouveau matériau (rotation du token). */
  rekey({ token, passphrase }) {
    this.source = passphrase ? 'passphrase' : 'token';
    this.salt = crypto.randomBytes(16);
    this.key = deriveKey(passphrase || token, this.salt);
    this.save({ force: true });
  }

  save({ force = false } = {}) {
    // Si le fichier a été re-chiffré par ailleurs (`npm run token:rotate` pendant que le serveur
    // tourne), l'écraser avec l'ancienne clé rendrait tous les secrets indéchiffrables au redémarrage.
    if (!force && this.diskSalt) {
      const onDisk = readJson(this.file, null);
      if (onDisk?.kdf?.salt && onDisk.kdf.salt !== this.diskSalt) {
        throw new HttpError(409, 'VAULT_ROTATED', 'Le token ou la passphrase a été renouvelé : redémarrez Corvus avant de modifier des secrets.');
      }
    }
    const salt = this.salt.toString('base64');
    writeJson(this.file, {
      v: 1,
      kdf: { alg: 'scrypt', src: this.source, salt, ...KDF },
      box: encrypt(this.key, this.secrets),
    });
    this.diskSalt = salt;
  }

  get(id) {
    return this.secrets[id] ? { ...this.secrets[id] } : null;
  }

  set(id, value) {
    if (value && Object.keys(value).length) this.secrets[id] = value;
    else delete this.secrets[id];
    this.save();
  }

  delete(id) {
    if (this.secrets[id]) {
      delete this.secrets[id];
      this.save();
    }
  }

  static exists(file) {
    return fs.existsSync(file);
  }
}
