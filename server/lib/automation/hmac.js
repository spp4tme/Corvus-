// Signature HMAC-SHA256 des webhooks (entrants et sortants). Module PUR.
//   en-têtes : X-Corvus-Timestamp (secondes Unix) et X-Corvus-Signature: sha256=<hex>
//   signé    : HMAC(secret, `${timestamp}.${corps brut}`) — le corps est signé tel qu'il est reçu, jamais ré-encodé.
// Le jeu d'en-têtes, l'horodatage et la comparaison à temps constant protègent de la falsification et du rejeu (voir triggers.js).
import crypto from 'node:crypto';

export const SIG_PREFIX = 'sha256=';
export const MAX_SKEW_S = 300; // écart d'horloge toléré : 5 minutes
export const REPLAY_TTL_S = 600; // une signature vue est mémorisée 10 minutes (au moins le double de la tolérance)

export function sign(secret, timestamp, body) {
  const h = crypto.createHmac('sha256', String(secret)).update(`${timestamp}.`).update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body).digest('hex');
  return `${SIG_PREFIX}${h}`;
}

/** Comparaison à temps constant ; faux (jamais d'exception) pour toute entrée mal formée. */
export function verify(secret, timestamp, body, signature) {
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Horodatage acceptable : entier en secondes, à moins de MAX_SKEW_S de maintenant (dans les deux sens). */
export function freshTimestamp(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || !/^\d{9,12}$/.test(value)) return false;
  return Math.abs(Math.floor(nowMs / 1000) - Number(value)) <= MAX_SKEW_S;
}
