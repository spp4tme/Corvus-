// TOTP (RFC 6238) : codes à 6 chiffres renouvelés toutes les 30 s, compatibles avec toutes les
// applications d'authentification (Aegis, Google Authenticator, 1Password, Bitwarden…).
// Implémentation directe avec node:crypto (HMAC-SHA1), sans dépendance.
import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SEC = 30;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Secret TOTP invalide');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Nouveau secret aléatoire (160 bits, recommandation de la RFC 4226). */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function stepAt(timeMs = Date.now()) {
  return Math.floor(timeMs / 1000 / STEP_SEC);
}

/** Code à 6 chiffres pour un pas de temps donné. */
export function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(bin).padStart(6, '0');
}

/**
 * Vérifie un code (tolérance ±1 pas pour les horloges décalées).
 * @returns {number|null} le pas de temps reconnu (à mémoriser contre le rejeu), ou null
 */
export function verify(secret, code, { timeMs = Date.now(), window = 1, afterStep = -1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
  const now = stepAt(timeMs);
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (step <= afterStep) continue; // déjà utilisé : rejeu refusé
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code.trim()))) return step;
  }
  return null;
}

export function otpauthUri({ secret, account, issuer = 'Corvus' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SEC}`;
}
