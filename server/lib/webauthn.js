// Passkeys (WebAuthn niveau 2), vérification côté serveur sans dépendance.
//
// Ce qui est vérifié : type et défi (anti-rejeu), origine, empreinte du domaine (rpId),
// présence ET vérification de l'utilisateur (empreinte, code ou visage sur l'appareil), signature
// avec la clé publique enregistrée, compteur (détection de clones).
// Non vérifié : l'« attestation » (le modèle d'authentificateur) — Corvus demande `none`.
// Limite : WebAuthn exige un contexte sécurisé (HTTPS, ex. *.ts.net via tailscale serve, ou
// localhost) ; pas d'accès par adresse IP.
import crypto from 'node:crypto';
import { HttpError } from './validate.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new HttpError(400, 'BAD_PASSKEY', 'Donnée WebAuthn mal encodée');
  return Buffer.from(s, 'base64url');
};
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const fail = (msg) => new HttpError(400, 'BAD_PASSKEY', `Passkey refusée : ${msg}`);

// ---------- CBOR (sous-ensemble utilisé par WebAuthn) ----------
export function cborDecode(buf, pos = 0) {
  const ib = buf[pos];
  if (ib === undefined) throw fail('CBOR tronqué');
  const major = ib >> 5;
  const info = ib & 31;
  pos++;
  let len = info;
  if (info === 24) { len = buf[pos]; pos += 1; } else if (info === 25) { len = buf.readUInt16BE(pos); pos += 2; } else if (info === 26) { len = buf.readUInt32BE(pos); pos += 4; } else if (info === 27) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; } else if (info > 27) throw fail('CBOR non pris en charge');
  switch (major) {
    case 0: return [len, pos];
    case 1: return [-1 - len, pos];
    case 2: return [buf.subarray(pos, pos + len), pos + len];
    case 3: return [buf.subarray(pos, pos + len).toString('utf8'), pos + len];
    case 4: {
      const arr = [];
      for (let i = 0; i < len; i++) { let v; [v, pos] = cborDecode(buf, pos); arr.push(v); }
      return [arr, pos];
    }
    case 5: {
      const obj = {};
      for (let i = 0; i < len; i++) {
        let k; let v;
        [k, pos] = cborDecode(buf, pos);
        [v, pos] = cborDecode(buf, pos);
        obj[String(k)] = v;
      }
      return [obj, pos];
    }
    case 7: return [info === 20 ? false : info === 21 ? true : null, pos];
    default: throw fail('CBOR non pris en charge');
  }
}

/** Clé COSE → { jwk, alg } utilisable par node:crypto. */
export function coseToJwk(cose) {
  const kty = cose['1'];
  const alg = cose['3'];
  if (kty === 2 && cose['-1'] === 1) return { alg: alg ?? -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(cose['-2']), y: b64u(cose['-3']) } };
  if (kty === 1 && cose['-1'] === 6) return { alg: alg ?? -8, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(cose['-2']) } };
  if (kty === 3) return { alg: alg ?? -257, jwk: { kty: 'RSA', n: b64u(cose['-1']), e: b64u(cose['-2']) } };
  throw fail('type de clé non pris en charge (ES256, Ed25519 ou RS256 attendus)');
}

export function parseAuthData(buf) {
  if (buf.length < 37) throw fail('authenticatorData trop court');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], counter: buf.readUInt32BE(33) };
  out.up = !!(out.flags & 0x01);
  out.uv = !!(out.flags & 0x04);
  if (out.flags & 0x40) {
    const credLen = buf.readUInt16BE(53);
    out.credentialId = buf.subarray(55, 55 + credLen);
    [out.cose] = cborDecode(buf, 55 + credLen);
  }
  return out;
}

function checkClientData(raw, { type, challenge, origin }) {
  let cd;
  try { cd = JSON.parse(raw.toString('utf8')); } catch { throw fail('clientDataJSON illisible'); }
  if (cd.type !== type) throw fail('type inattendu');
  if (cd.challenge !== challenge) throw fail('défi incorrect ou expiré');
  if (cd.origin !== origin) throw fail(`origine ${cd.origin} différente de ${origin}`);
  return cd;
}

function checkAuthData(ad, rpId) {
  if (!crypto.timingSafeEqual(ad.rpIdHash, sha256(Buffer.from(rpId)))) throw fail('domaine (rpId) différent');
  if (!ad.up) throw fail('présence de l\'utilisateur non confirmée');
  if (!ad.uv) throw fail('vérification de l\'utilisateur (code, empreinte…) exigée');
}

export function verifySignature({ alg, jwk }, data, sig) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (alg === -7) return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig);
  if (alg === -8) return crypto.verify(null, data, key, sig);
  if (alg === -257) return crypto.verify('sha256', data, key, sig);
  return false;
}

/** Vérifie une création de passkey ; retourne ce qu'il faut enregistrer. */
export function verifyRegistration(cred, { challenge, origin, rpId }) {
  const resp = cred?.response || {};
  const clientData = fromB64u(resp.clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.create', challenge, origin });
  const [att] = cborDecode(fromB64u(resp.attestationObject));
  const ad = parseAuthData(att.authData);
  checkAuthData(ad, rpId);
  if (!ad.credentialId || !ad.cose) throw fail('clé publique absente');
  const { jwk, alg } = coseToJwk(ad.cose);
  return { id: b64u(ad.credentialId), jwk, alg, counter: ad.counter };
}

/** Vérifie une connexion par passkey avec la clé enregistrée ; retourne le nouveau compteur. */
export function verifyAssertion(cred, stored, { challenge, origin, rpId }) {
  const resp = cred?.response || {};
  const clientData = fromB64u(resp.clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.get', challenge, origin });
  const authData = fromB64u(resp.authenticatorData);
  const ad = parseAuthData(authData);
  checkAuthData(ad, rpId);
  const ok = verifySignature({ alg: stored.alg, jwk: stored.jwk }, Buffer.concat([authData, sha256(clientData)]), fromB64u(resp.signature));
  if (!ok) throw fail('signature invalide');
  if ((ad.counter || stored.counter) && ad.counter <= stored.counter) throw fail('compteur incohérent (authentificateur cloné ?)');
  return ad.counter;
}

/** Défis à usage unique, valables 5 minutes. */
export class Challenges {
  constructor() { this.map = new Map(); }
  issue(data = {}) {
    const now = Date.now();
    for (const [k, c] of this.map) if (c.expires < now) this.map.delete(k);
    // Plafond : /passkey/options est public, il ne doit pas permettre de remplir la mémoire.
    while (this.map.size >= 1000) this.map.delete(this.map.keys().next().value);
    const challenge = b64u(crypto.randomBytes(32));
    const id = b64u(crypto.randomBytes(12));
    this.map.set(id, { ...data, challenge, expires: now + 5 * 60_000 });
    return { id, challenge };
  }
  take(id) {
    const c = this.map.get(String(id || ''));
    this.map.delete(String(id || ''));
    if (!c || c.expires < Date.now()) throw fail('défi expiré, recommencez');
    return c;
  }
}

export { b64u };
