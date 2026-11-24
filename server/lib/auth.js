// Authentification : token d'accès unique (généré au 1er lancement), sessions par cookie,
// comparaison timing-safe, limitation des tentatives, vérification d'origine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore, writeFileSecure } from './store.js';
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
  constructor({ dataDir, token, sessionTtlDays }) {
    this.token = token;
    this.ttlMs = sessionTtlDays * 86_400_000;
    this.sessions = new JsonStore(path.join(dataDir, 'sessions.json'), { sessions: {} });
    this.limiter = new FailureLimiter();
    this._pruneSessions();
  }

  _pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of Object.entries(this.sessions.data.sessions)) {
      if (s.expires < now) { delete this.sessions.data.sessions[k]; changed = true; }
    }
    if (changed) this.sessions.save();
  }

  createSession(meta) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const key = sha256(sid).toString('hex');
    this.sessions.data.sessions[key] = {
      created: Date.now(),
      expires: Date.now() + this.ttlMs,
      ua: String(meta.ua || '').slice(0, 160),
      ip: meta.ip,
    };
    this.sessions.save();
    return sid;
  }

  validSession(sid) {
    if (typeof sid !== 'string' || sid.length < 20 || sid.length > 100) return false;
    const s = this.sessions.data.sessions[sha256(sid).toString('hex')];
    return !!s && s.expires > Date.now();
  }

  destroySession(sid) {
    if (typeof sid !== 'string') return;
    const key = sha256(sid).toString('hex');
    if (this.sessions.data.sessions[key]) {
      delete this.sessions.data.sessions[key];
      this.sessions.save();
    }
  }

  revokeAll() {
    this.sessions.data.sessions = {};
    this.sessions.save();
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
