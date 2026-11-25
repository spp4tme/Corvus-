// Authentification : token d'accès unique (généré au 1er lancement), sessions par cookie,
// comparaison timing-safe, limitation des tentatives, vérification d'origine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileSecure } from './store.js';
import { logger } from './log.js';

const log = logger('auth');
export const COOKIE = 'corvus_sid';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

export function generateToken() {
  return 'cv_' + crypto.randomBytes(32).toString('base64url');
}

/** Charge (ou crée) le token. Retourne { token, created }. */
export function loadToken(dataDir) {
  const file = path.join(dataDir, 'token');
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token.length >= 32) return { token, created: false, file };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const token = generateToken();
  writeFileSecure(file, token + '\n');
  return { token, created: true, file };
}

export function tokenMatches(candidate, token) {
  if (typeof candidate !== 'string' || !candidate) return false;
  // Comparaison sur des empreintes de taille fixe : timing-safe, longueur non divulguée.
  return crypto.timingSafeEqual(sha256(candidate), sha256(token));
}

/** Limiteur des échecs d'authentification, par IP + global. */
export class FailureLimiter {
  constructor({ maxPerIp = 10, windowMs = 15 * 60_000, maxGlobal = 50 } = {}) {
    Object.assign(this, { maxPerIp, windowMs, maxGlobal });
    this.byIp = new Map();
    this.global = [];
  }
  _prune(now) {
    this.global = this.global.filter((t) => now - t < this.windowMs);
    for (const [ip, rec] of this.byIp) {
      rec.times = rec.times.filter((t) => now - t < this.windowMs);
      if (!rec.times.length) this.byIp.delete(ip);
    }
  }
  /** @returns {number} ms avant nouvel essai possible, 0 si autorisé */
  blockedFor(ip) {
    const now = Date.now();
    this._prune(now);
    const rec = this.byIp.get(ip);
    // Blocage par IP uniquement. Un blocage global permettrait à n'importe quel appareil du tailnet
    // d'enfermer dehors le propriétaire ; le volume global ne fait qu'alourdir la pénalité (voir fail).
    if (rec && rec.times.length >= this.maxPerIp) return this.windowMs - (now - rec.times[0]);
    return 0;
  }
  /** Enregistre un échec et retourne le délai de pénalité à appliquer (ms). */
  fail(ip) {
    const now = Date.now();
    // Élagage ici aussi : les échecs Bearer (API, WebSocket) ne passent pas par blockedFor().
    this._prune(now);
    const rec = this.byIp.get(ip) || { times: [] };
    rec.times.push(now);
    this.byIp.set(ip, rec);
    this.global.push(now);
    const perIp = Math.min(250 * 2 ** (rec.times.length - 1), 8000);
    return this.global.length >= this.maxGlobal ? Math.max(perIp, 4000) : perIp;
  }
  success(ip) {
    this.byIp.delete(ip);
  }
}

export class Auth {
  constructor({ db, token, sessionTtlDays }) {
    this.db = db;
    this.token = token;
    // Empreinte du token : une session n'est valide que pour le token qui l'a créée. Ainsi
    // `rotate-token` révoque vraiment tout, même si le serveur encore lancé écrit encore.
    this.tokenTag = sha256(`session-tag:${token}`).toString('hex').slice(0, 16);
    this.ttlMs = sessionTtlDays * 86_400_000;
    this.limiter = new FailureLimiter();
    this.db.run('DELETE FROM auth_sessions WHERE expires_at < ? OR token_tag <> ?', Date.now(), this.tokenTag);
  }

  createSession(meta) {
    const sid = crypto.randomBytes(32).toString('base64url');
    this.db.run(`INSERT INTO auth_sessions (key, user_id, token_tag, mfa, created_at, expires_at, ua, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, sha256(sid).toString('hex'), meta.userId ?? null, this.tokenTag, !!meta.mfa,
    Date.now(), Date.now() + this.ttlMs, String(meta.ua || '').slice(0, 160), meta.ip ?? null);
    return sid;
  }

  /** Session valide → sa ligne, sinon null. */
  session(sid) {
    if (typeof sid !== 'string' || sid.length < 20 || sid.length > 100) return null;
    const s = this.db.get('SELECT * FROM auth_sessions WHERE key = ?', sha256(sid).toString('hex'));
    return s && s.expires_at > Date.now() && s.token_tag === this.tokenTag ? s : null;
  }

  validSession(sid) {
    return !!this.session(sid);
  }

  destroySession(sid) {
    if (typeof sid !== 'string') return;
    this.db.run('DELETE FROM auth_sessions WHERE key = ?', sha256(sid).toString('hex'));
  }

  revokeAll() {
    this.db.run('DELETE FROM auth_sessions');
  }

  /** Identifie la requête : 'bearer', 'cookie' ou null. */
  identify(req) {
    const authz = req.headers.authorization;
    if (authz && authz.startsWith('Bearer ')) {
      return tokenMatches(authz.slice(7).trim(), this.token) ? 'bearer' : null;
    }
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    return this.validSession(sid) ? 'cookie' : null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

/** Hôte « vu par le navigateur », en tenant compte d'un reverse-proxy de confiance. */
export function requestHost(req, trustForwarded) {
  const fwd = trustForwarded ? req.headers['x-forwarded-host'] : undefined;
  return String(fwd || req.headers.host || '').split(',')[0].trim().toLowerCase();
}

/**
 * Vérifie que l'en-tête Origin correspond à Corvus lui-même (ou à une origine autorisée).
 * @returns {boolean}
 */
export function originAllowed(origin, req, { allowedOrigins, trustForwarded }) {
  if (!origin) return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (allowedOrigins.includes(url.origin)) return true;
  const host = url.host.toLowerCase();
  if (host === requestHost(req, trustForwarded)) return true;
  if (host === String(req.headers.host || '').toLowerCase()) return true;
  return false;
}

export function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export { log as authLog };
