// Comptes, mots de passe, TOTP, jetons d'API et droits par hôte / groupe.
//
// Rôles :
//  - admin     : tout (hôtes, comptes, sauvegardes, système), sur tous les hôtes ;
//  - operator  : utilise les hôtes qui lui sont accordés (terminal, fichiers, git, docker…) ;
//  - viewer    : lecture seule sur les hôtes accordés (supervision, fichiers, git, journal).
// Un compte non admin n'a accès qu'aux hôtes accordés (par hôte, par groupe ou « tous »).
import crypto from 'node:crypto';
import { HttpError } from './validate.js';
import * as v from './validate.js';
import * as totp from './totp.js';

export const ROLES = ['admin', 'operator', 'viewer'];
const LEVEL = { viewer: 1, operator: 2, admin: 3 };
const USERNAME_RE = /^[A-Za-z0-9._-]{2,32}$/;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || typeof pw !== 'string') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(got, expected);
}

// Calcul factice pour un identifiant inconnu : même durée de réponse qu'un vrai compte.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 12) throw v.bad('Mot de passe : 12 caractères minimum');
  if (pw.length > 256) throw v.bad('Mot de passe trop long');
  return pw;
}

function publicUser(u) {
  return u && {
    id: u.id, username: u.username, role: u.role, totpEnabled: !!u.totp_enabled, disabled: !!u.disabled,
    mustChangePassword: !!u.must_change_password, createdAt: u.created_at, lastLoginAt: u.last_login_at,
  };
}

export class Users {
  constructor({ db, vault, hosts }) {
    Object.assign(this, { db, vault, hosts });
  }

  count() {
    return this.db.get('SELECT COUNT(*) AS n FROM users').n;
  }

  row(id) {
    return this.db.get('SELECT * FROM users WHERE id = ?', id);
  }

  byName(username) {
    return this.db.get('SELECT * FROM users WHERE username = ?', String(username || ''));
  }

  get(id) {
    const u = this.row(id);
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'Compte introuvable');
    return publicUser(u);
  }

  list() {
    return this.db.all('SELECT * FROM users ORDER BY username').map((u) => ({ ...publicUser(u), grants: this.grants(u.id) }));
  }

  create({ username, password, role = 'operator', mustChangePassword = false }) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw v.bad('Identifiant : 2 à 32 caractères (lettres, chiffres, . _ -)');
    checkPassword(password);
    v.oneOf(role, ROLES, 'rôle');
    if (this.byName(username)) throw new HttpError(409, 'EXISTS', 'Cet identifiant existe déjà');
    const id = crypto.randomBytes(8).toString('hex');
    this.db.run(`INSERT INTO users (id, username, password_hash, role, created_at, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?)`, id, username, hashPassword(password), role, Date.now(), mustChangePassword);
    return this.get(id);
  }

  adminCount() {
    return this.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n;
  }

  update(id, { role, disabled, password }) {
    const u = this.row(id);
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'Compte introuvable');
    const losesAdmin = u.role === 'admin' && !u.disabled && ((role && role !== 'admin') || disabled === true);
    if (losesAdmin && this.adminCount() <= 1) throw new HttpError(409, 'LAST_ADMIN', 'Impossible : c\'est le dernier administrateur actif');
    this.db.tx(() => {
      if (role !== undefined) this.db.run('UPDATE users SET role = ? WHERE id = ?', v.oneOf(role, ROLES, 'rôle'), id);
      if (disabled !== undefined) {
        this.db.run('UPDATE users SET disabled = ? WHERE id = ?', v.bool(disabled), id);
        if (disabled) this.revokeSessions(id);
      }
      if (password !== undefined) {
        this.db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hashPassword(checkPassword(password)), id);
        this.revokeSessions(id);
      }
    });
    return this.get(id);
  }

  remove(id) {
    const u = this.row(id);
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'Compte introuvable');
    if (u.role === 'admin' && !u.disabled && this.adminCount() <= 1) throw new HttpError(409, 'LAST_ADMIN', 'Impossible : c\'est le dernier administrateur actif');
    this.db.tx(() => {
      this.db.run('DELETE FROM users WHERE id = ?', id);
      this.vault.delete(`totp:${id}`);
    });
  }

  /** Change son mot de passe ; les AUTRES sessions du compte sont coupées (celle de `keepSessionKey` reste). */
  changeOwnPassword(id, current, next, keepSessionKey = null) {
    const u = this.row(id);
    if (!u || !verifyPassword(current, u.password_hash)) throw new HttpError(403, 'BAD_PASSWORD', 'Mot de passe actuel incorrect');
    this.db.tx(() => {
      this.db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(checkPassword(next)), id);
      this.db.run('DELETE FROM auth_sessions WHERE user_id = ? AND key <> ?', id, keepSessionKey ?? '');
    });
  }

  revokeSessions(id) {
    this.db.run('DELETE FROM auth_sessions WHERE user_id = ?', id);
  }

  /**
   * Vérifie identifiant + mot de passe (temps constant, que le compte existe ou non).
   * @returns {object|null} la ligne du compte
   */
  checkCredentials(username, password) {
    const u = this.byName(username);
    const ok = verifyPassword(typeof password === 'string' ? password : '', u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok || u.disabled) return null;
    return u;
  }

  // ---------- TOTP ----------
  totpSecret(id) {
    return this.vault.get(`totp:${id}`)?.secret || null;
  }

  /** Vérifie un code et enregistre son pas de temps (un code ne sert qu'une fois). */
  checkTotp(u, code) {
    const secret = this.totpSecret(u.id);
    if (!secret || !u.totp_enabled) return false;
    const step = totp.verify(secret, code, { afterStep: u.totp_last_step });
    if (step === null) return false;
    this.db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, u.id);
    return true;
  }

  /** Active le TOTP avec un secret proposé au client, après vérification d'un code. */
  enableTotp(id, secret, code) {
    if (typeof secret !== 'string' || !/^[A-Z2-7]{32}$/.test(secret)) throw v.bad('Secret TOTP invalide');
    const step = totp.verify(secret, code);
    if (step === null) throw new HttpError(400, 'BAD_CODE', 'Code incorrect : vérifiez l\'heure du téléphone et réessayez');
    this.db.tx(() => {
      this.vault.set(`totp:${id}`, { secret });
      this.db.run('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?', step, id);
    });
  }

  resetTotp(id) {
    this.get(id);
    this.db.tx(() => {
      this.vault.delete(`totp:${id}`);
      this.db.run('UPDATE users SET totp_enabled = 0, totp_last_step = -1 WHERE id = ?', id);
      this.revokeSessions(id);
    });
  }

  // ---------- Jetons d'API (clients sans navigateur) ----------
  createToken(userId, name) {
    const token = `cvu_${crypto.randomBytes(32).toString('base64url')}`;
    const id = crypto.randomBytes(6).toString('hex');
    this.db.run('INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      id, userId, v.str(name ?? '', 'nom', { min: 1, max: 60 }).trim(), sha256hex(token), Date.now());
    return { id, token };
  }

  tokens(userId) {
    return this.db.all('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE user_id = ? ORDER BY created_at', userId);
  }

  revokeToken(userId, id) {
    if (!this.db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', id, userId).changes) throw new HttpError(404, 'NOT_FOUND', 'Jeton introuvable');
  }

  /** @returns {object|null} ligne du compte propriétaire du jeton */
  userForToken(token) {
    if (typeof token !== 'string' || !token.startsWith('cvu_') || token.length > 100) return null;
    const t = this.db.get('SELECT id, user_id FROM api_tokens WHERE token_hash = ?', sha256hex(token));
    if (!t) return null;
    const u = this.row(t.user_id);
    if (!u || u.disabled) return null;
    this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', Date.now(), t.id);
    return u;
  }

  // ---------- Droits ----------
  grants(userId) {
    return this.db.all('SELECT scope, target, role FROM grants WHERE user_id = ? ORDER BY scope, target', userId);
  }

  setGrants(userId, list) {
    this.get(userId);
    if (!Array.isArray(list) || list.length > 500) throw v.bad('Liste de droits invalide');
    const clean = list.map((g) => ({
      scope: v.oneOf(g?.scope, ['host', 'group', 'all'], 'portée'),
      target: g.scope === 'all' ? '' : v.str(g.target, 'cible', { min: 1, max: 64 }),
      role: v.oneOf(g?.role, ['operator', 'viewer'], 'rôle'),
    }));
    this.db.tx(() => {
      this.db.run('DELETE FROM grants WHERE user_id = ?', userId);
      for (const g of clean) this.db.run('INSERT OR REPLACE INTO grants (user_id, scope, target, role) VALUES (?, ?, ?, ?)', userId, g.scope, g.target, g.role);
    });
    return this.grants(userId);
  }

  /** Rôle effectif d'un compte sur un hôte : 'admin' | 'operator' | 'viewer' | null. */
  hostRole(user, host) {
    if (!user || !host) return null;
    if (user.role === 'admin') return 'admin';
    let best = null;
    for (const g of this.grants(user.id)) {
      const match = g.scope === 'all' || (g.scope === 'host' && g.target === host.id) || (g.scope === 'group' && host.group && g.target.toLowerCase() === host.group.toLowerCase());
      if (!match) continue;
      // Le rôle d'un droit ne dépasse jamais le rôle du compte (un « viewer » reste en lecture seule).
      const role = LEVEL[g.role] > LEVEL[user.role] ? user.role : g.role;
      if (!best || LEVEL[role] > LEVEL[best]) best = role;
    }
    return best;
  }

  /** Identifiants des hôtes accessibles (null = tous, pour un admin). */
  allowedHostIds(user) {
    if (!user) return [];
    if (user.role === 'admin') return null;
    return this.hosts.hosts.filter((h) => this.hostRole(user, h)).map((h) => h.id);
  }

  static atLeast(role, needed) {
    return !!role && LEVEL[role] >= LEVEL[needed];
  }
}

export { publicUser };
