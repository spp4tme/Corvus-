// Coffre de secrets chiffré au repos, stocké dans SQLite.
//
// Deux niveaux de clés (« enveloppe ») :
//  - une clé de données (DEK) aléatoire chiffre les secrets ET les blobs (enregistrements,
//    sauvegardes de fichiers) en AES-256-GCM ;
//  - la DEK est elle-même chiffrée par une clé dérivée (scrypt) de la passphrase maître
//    (CORVUS_MASTER_PASSPHRASE) ou, à défaut, du token d'amorçage.
// Changer de passphrase ou de token ne ré-chiffre donc que la DEK (32 octets), pas les blobs.
import crypto from 'node:crypto';
import { HttpError } from './validate.js';

const AAD = Buffer.from('corvus-secrets-v2');
const KDF = { N: 2 ** 15, r: 8, p: 1 };

export function deriveKey(material, salt, params = KDF) {
  return crypto.scryptSync(material, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 });
}

function seal(key, plain, aad = AAD) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function open(key, box, aad = AAD) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAAD(aad);
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]);
}

/** Déchiffre l'ancien fichier secrets.enc.json (format v1) — utilisé par la migration. */
export function openLegacyVault(existing, { token, passphrase }) {
  const material = existing.kdf.src === 'passphrase' ? passphrase : token;
  if (!material) throw new Error('Les anciens secrets sont protégés par une passphrase maître : définissez CORVUS_MASTER_PASSPHRASE.');
  const key = deriveKey(material, Buffer.from(existing.kdf.salt, 'base64'), existing.kdf);
  return JSON.parse(open(key, existing.box, Buffer.from('corvus-secrets-v1')).toString('utf8'));
}

export class Vault {
  /**
   * @param {import('../db/index.js').Db} db
   * @param {{token: string, passphrase?: string}} materials
   */
  constructor(db, { token, passphrase }) {
    this.db = db;
    this.source = passphrase ? 'passphrase' : 'token';
    const material = passphrase || token;
    const kdf = db.getMeta('vault.kdf');

    if (!kdf) {
      this.dek = crypto.randomBytes(32);
      this.wrap(material);
    } else {
      if (kdf.src === 'passphrase' && !passphrase) {
        throw new Error('Les secrets sont protégés par une passphrase maître : définissez CORVUS_MASTER_PASSPHRASE.');
      }
      const kek = deriveKey(kdf.src === 'passphrase' ? passphrase : token, Buffer.from(kdf.salt, 'base64'), kdf);
      try {
        this.dek = open(kek, db.getMeta('vault.dek'));
      } catch {
        throw new Error(kdf.src === 'passphrase'
          ? 'Passphrase maître incorrecte : impossible de déchiffrer les secrets.'
          : 'Impossible de déchiffrer les secrets avec le token actuel (data/token modifié à la main ?).');
      }
      this.salt = kdf.salt;
      // Une passphrase vient d'être définie (ou retirée) : on ré-emballe la DEK.
      if (kdf.src !== this.source) this.wrap(material);
    }
    this.secrets = new Map();
    for (const row of db.all('SELECT id, iv, tag, ct FROM secrets')) {
      this.secrets.set(row.id, JSON.parse(open(this.dek, row).toString('utf8')));
    }
  }

  /** Chiffre la DEK avec une clé dérivée de `material` (nouveau sel). */
  wrap(material) {
    const salt = crypto.randomBytes(16).toString('base64');
    const kek = deriveKey(material, Buffer.from(salt, 'base64'));
    this.db.tx(() => {
      this.db.setMeta('vault.kdf', { alg: 'scrypt', src: this.source, salt, ...KDF });
      this.db.setMeta('vault.dek', seal(kek, this.dek));
    });
    this.salt = salt;
  }

  /** Rotation du token ou de la passphrase : seule la DEK est ré-emballée. */
  rekey({ token, passphrase }) {
    this.source = passphrase ? 'passphrase' : 'token';
    this.wrap(passphrase || token);
  }

  /**
   * Un autre processus (`npm run token:rotate`) a ré-emballé la DEK pendant que le serveur
   * tourne : on refuse d'écrire, le redémarrage remettra tout d'aplomb.
   */
  guard() {
    const kdf = this.db.getMeta('vault.kdf');
    if (kdf && kdf.salt !== this.salt) {
      throw new HttpError(409, 'VAULT_ROTATED', 'Le token ou la passphrase a été renouvelé : redémarrez Corvus avant de modifier des secrets.');
    }
  }

  get(id) {
    const v = this.secrets.get(id);
    return v ? structuredClone(v) : null;
  }

  set(id, value) {
    if (!value || (typeof value === 'object' && !Object.keys(value).length)) return this.delete(id);
    this.guard();
    const box = seal(this.dek, Buffer.from(JSON.stringify(value), 'utf8'));
    this.db.run(`INSERT INTO secrets (id, iv, tag, ct, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, ct = excluded.ct, updated_at = excluded.updated_at`,
    id, box.iv, box.tag, box.ct, Date.now());
    this.secrets.set(id, structuredClone(value));
  }

  delete(id) {
    if (!this.secrets.has(id)) return;
    this.db.run('DELETE FROM secrets WHERE id = ?', id);
    this.secrets.delete(id);
  }

  /** Chiffrement de contenus binaires (blobs) : iv(12) | tag(16) | données. */
  encryptBuffer(buf, label = 'blob') {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.dek, iv);
    c.setAAD(Buffer.from(`corvus-${label}`));
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  decryptBuffer(buf, label = 'blob') {
    const d = crypto.createDecipheriv('aes-256-gcm', this.dek, buf.subarray(0, 12));
    d.setAAD(Buffer.from(`corvus-${label}`));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  }
}
