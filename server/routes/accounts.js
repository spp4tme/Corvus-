// Routes des comptes :
//  - /api/auth/*  (sans session) : premier administrateur, connexion mot de passe + TOTP,
//    enrôlement TOTP, déconnexion, état ;
//  - /api/me/*    : mon compte (mot de passe, jetons d'API) ;
//  - /api/users/* : gestion des comptes et des droits (administrateurs).
import crypto from 'node:crypto';
import { Router } from 'express';
import { COOKIE, parseCookies } from '../lib/auth.js';
import { HttpError } from '../lib/validate.js';
import * as v from '../lib/validate.js';
import { roleGuard } from '../lib/access.js';
import * as totp from '../lib/totp.js';
import { publicUser } from '../lib/users.js';
import { originAllowed } from '../lib/auth.js';
import { verifyRegistration, verifyAssertion, b64u } from '../lib/webauthn.js';

/** Origine et domaine (rpId) de la page qui demande l'opération WebAuthn. */
function relyingParty(req, ctx) {
  const origin = req.headers.origin;
  const trustForwarded = ctx.config.trustProxy !== false && ctx.config.trustProxy !== 'false';
  if (!origin || !originAllowed(origin, req, { allowedOrigins: ctx.config.allowedOrigins, trustForwarded })) {
    throw new HttpError(400, 'BAD_ORIGIN', 'Origine absente ou refusée pour une passkey');
  }
  return { origin, rpId: new URL(origin).hostname };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENROLL_TTL_MS = 10 * 60_000;

export function setSessionCookie(req, res, ctx, sid) {
  res.cookie(COOKIE, sid, {
    httpOnly: true,
    sameSite: 'strict',
    // https direct, via tailscale serve (X-Forwarded-Proto) ou origine https déclarée par le navigateur
    secure: req.secure || String(req.headers.origin || '').startsWith('https://'),
    path: '/',
    maxAge: ctx.config.sessionTtlDays * 86_400_000,
  });
}

export function authRoutes(ctx) {
  const r = Router();
  const { auth, users, journal } = ctx;
  // Enrôlements TOTP en cours (après un mot de passe correct) : jeton → { userId, secret }.
  const enrollments = new Map();

  const rateCheck = (key) => {
    const wait = auth.limiter.blockedFor(key);
    if (wait > 0) throw new HttpError(429, 'RATE_LIMITED', `Trop de tentatives. Réessayez dans ${Math.ceil(wait / 60000)} min.`);
  };
  const failure = async (req, keys, code, message, username) => {
    let penalty = 0;
    for (const k of keys) penalty = Math.max(penalty, auth.limiter.fail(k));
    journal.add({ type: 'auth', event: 'login', ok: false, ip: req.ip, detail: `${code}${username ? ` (${String(username).slice(0, 32)})` : ''}` });
    await sleep(penalty);
    throw new HttpError(401, code, message);
  };
  const startEnroll = (u) => {
    const now = Date.now();
    for (const [k, e] of enrollments) if (e.expires < now) enrollments.delete(k);
    const token = crypto.randomBytes(24).toString('base64url');
    const secret = totp.generateSecret();
    enrollments.set(token, { userId: u.id, secret, expires: now + ENROLL_TTL_MS });
    return { enrollToken: token, secret, uri: totp.otpauthUri({ secret, account: u.username }) };
  };
  const openSession = (req, res, u, method) => {
    const sid = auth.createSession({ userId: u.id, mfa: true, ua: req.headers['user-agent'], ip: req.ip });
    ctx.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), u.id);
    journal.add({ type: 'auth', event: 'login', user: u, ip: req.ip, detail: method });
    setSessionCookie(req, res, ctx, sid);
  };

  r.get('/status', (req, res) => {
    const who = auth.identify(req);
    res.json({
      authenticated: !!who,
      user: who ? { ...publicUser(who.user), grants: users.grants(who.user.id) } : null,
      setupRequired: users.count() === 0,
      passkeys: !!ctx.webauthn,
      version: ctx.version,
    });
  });

  // Premier lancement : le token d'amorçage (affiché dans les logs / `npm run token`) permet de
  // créer le premier administrateur. Ensuite il ne sert plus à se connecter.
  r.post('/setup', async (req, res) => {
    if (users.count() > 0) throw new HttpError(409, 'ALREADY_SETUP', 'Un administrateur existe déjà : connectez-vous.');
    rateCheck(req.ip);
    if (!auth.bootstrapMatches(req.body?.bootstrapToken)) await failure(req, [req.ip], 'BAD_TOKEN', 'Token d\'amorçage invalide');
    const u = users.create({ username: req.body?.username, password: req.body?.password, role: 'admin' });
    journal.add({ type: 'account', event: 'setup', user: u, ip: req.ip, detail: 'premier administrateur' });
    res.status(201).json({ enroll: startEnroll(users.row(u.id)) });
  });

  r.post('/login', async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const keys = [req.ip, `user:${username.toLowerCase()}`];
    for (const k of keys) rateCheck(k);
    const u = users.checkCredentials(username, req.body?.password);
    if (!u) await failure(req, keys, 'BAD_CREDENTIALS', 'Identifiant ou mot de passe incorrect', username);
    // TOTP obligatoire : un compte qui n'en a pas encore doit l'enrôler maintenant.
    if (!u.totp_enabled) return res.json({ enroll: startEnroll(u) });
    if (!users.checkTotp(u, String(req.body?.code ?? ''))) await failure(req, keys, 'BAD_CODE', 'Code à 6 chiffres incorrect (ou déjà utilisé)', username);
    for (const k of keys) auth.limiter.success(k);
    openSession(req, res, u, 'mot de passe + TOTP');
    res.json({ ok: true });
  });

  r.post('/totp/enroll', async (req, res) => {
    rateCheck(req.ip);
    const e = enrollments.get(String(req.body?.enrollToken || ''));
    if (!e || e.expires < Date.now()) { auth.limiter.fail(req.ip); throw new HttpError(400, 'ENROLL_EXPIRED', 'Enrôlement expiré : reconnectez-vous.'); }
    // Le code à 6 chiffres ne doit pas pouvoir être deviné par essais répétés.
    try { users.enableTotp(e.userId, e.secret, String(req.body?.code ?? '')); } catch (err) { await sleep(auth.limiter.fail(req.ip)); throw err; }
    auth.limiter.success(req.ip);
    enrollments.delete(String(req.body.enrollToken));
    const u = users.row(e.userId);
    journal.add({ type: 'account', event: 'totp-enabled', user: u, ip: req.ip });
    openSession(req, res, u, 'mot de passe + TOTP (enrôlement)');
    res.json({ ok: true });
  });

  // ---------- Connexion par passkey (remplace mot de passe + TOTP : vérification exigée sur l'appareil) ----------
  r.post('/passkey/options', (req, res) => {
    const rp = relyingParty(req, ctx);
    const c = ctx.webauthn.issue({ ...rp, purpose: 'login' });
    res.json({ challengeId: c.id, publicKey: { challenge: c.challenge, rpId: rp.rpId, userVerification: 'required', timeout: 120_000, allowCredentials: [] } });
  });

  r.post('/passkey/login', async (req, res) => {
    rateCheck(req.ip);
    const c = ctx.webauthn.take(req.body?.challengeId);
    const cred = req.body?.credential;
    const row = c.purpose === 'login' && typeof cred?.id === 'string' ? ctx.db.get('SELECT * FROM webauthn_credentials WHERE id = ?', cred.id) : null;
    if (!row) await failure(req, [req.ip], 'BAD_PASSKEY', 'Passkey inconnue de Corvus');
    let counter;
    try {
      counter = verifyAssertion(cred, { alg: row.alg, jwk: JSON.parse(row.public_key), counter: row.counter }, c);
    } catch (err) {
      await failure(req, [req.ip], 'BAD_PASSKEY', err.message);
    }
    const u = users.row(row.user_id);
    if (!u || u.disabled) await failure(req, [req.ip], 'BAD_PASSKEY', 'Compte désactivé');
    ctx.db.run('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?', counter, Date.now(), row.id);
    auth.limiter.success(req.ip);
    openSession(req, res, u, `passkey « ${row.name} »`);
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    auth.destroySession(parseCookies(req.headers.cookie)[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' });
    ctx.revalidateTerminals?.();
    res.json({ ok: true });
  });

  return r;
}

export function accountRoutes(ctx) {
  const r = Router();
  const { users, journal, hosts } = ctx;

  r.get('/me', (req, res) => res.json({ user: { ...req.user, grants: users.grants(req.user.id) } }));

  r.post('/me/password', (req, res) => {
    // Un cookie volé ne doit pas permettre de deviner le mot de passe actuel : essais limités, comme à la connexion.
    const key = `pw:${req.user.id}`;
    const wait = ctx.auth.limiter.blockedFor(key);
    if (wait > 0) throw new HttpError(429, 'RATE_LIMITED', `Trop de tentatives. Réessayez dans ${Math.ceil(wait / 60000)} min.`);
    try {
      users.changeOwnPassword(req.user.id, req.body?.current, req.body?.next, req.sessionKey);
    } catch (err) {
      if (err.code === 'BAD_PASSWORD') ctx.auth.limiter.fail(key);
      throw err;
    }
    ctx.auth.limiter.success(key);
    ctx.revalidateTerminals?.();
    journal.add({ type: 'account', event: 'password', user: req.user, ip: req.ip, detail: 'autres sessions coupées' });
    res.json({ ok: true });
  });

  // ---------- Passkeys ----------
  r.get('/me/passkeys', (req, res) => res.json({
    passkeys: ctx.db.all('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at', req.user.id),
  }));
  r.post('/me/passkeys/options', (req, res) => {
    const rp = relyingParty(req, ctx);
    const c = ctx.webauthn.issue({ ...rp, purpose: 'register', userId: req.user.id });
    const existing = ctx.db.all('SELECT id FROM webauthn_credentials WHERE user_id = ?', req.user.id);
    res.json({
      challengeId: c.id,
      publicKey: {
        challenge: c.challenge,
        rp: { id: rp.rpId, name: 'Corvus' },
        user: { id: b64u(Buffer.from(req.user.id)), name: req.user.username, displayName: req.user.username },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: existing.map((x) => ({ type: 'public-key', id: x.id })),
        attestation: 'none',
        timeout: 120_000,
      },
    });
  });
  r.post('/me/passkeys', (req, res) => {
    const c = ctx.webauthn.take(req.body?.challengeId);
    if (c.purpose !== 'register' || c.userId !== req.user.id) throw new HttpError(400, 'BAD_PASSKEY', 'Défi invalide');
    const name = v.str(req.body?.name ?? 'Passkey', 'nom', { min: 1, max: 60 }).trim();
    const k = verifyRegistration(req.body?.credential, c);
    if (ctx.db.get('SELECT id FROM webauthn_credentials WHERE id = ?', k.id)) throw new HttpError(409, 'EXISTS', 'Cette passkey est déjà enregistrée');
    ctx.db.run('INSERT INTO webauthn_credentials (id, user_id, name, public_key, alg, counter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      k.id, req.user.id, name, JSON.stringify(k.jwk), k.alg, k.counter, Date.now());
    journal.add({ type: 'account', event: 'passkey-add', user: req.user, detail: name });
    res.status(201).json({ ok: true });
  });
  r.delete('/me/passkeys/:id', (req, res) => {
    const id = v.str(req.params.id, 'id', { min: 8, max: 2048 });
    if (!ctx.db.run('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?', id, req.user.id).changes) throw new HttpError(404, 'NOT_FOUND', 'Passkey introuvable');
    journal.add({ type: 'account', event: 'passkey-remove', user: req.user });
    res.json({ ok: true });
  });

  r.get('/me/tokens', (req, res) => res.json({ tokens: users.tokens(req.user.id) }));
  r.post('/me/tokens', (req, res) => {
    const t = users.createToken(req.user.id, req.body?.name);
    journal.add({ type: 'account', event: 'api-token', user: req.user, detail: `création ${t.id}` });
    res.status(201).json(t);
  });
  r.delete('/me/tokens/:id', (req, res) => {
    users.revokeToken(req.user.id, v.str(req.params.id, 'id', { min: 12, max: 12 }));
    journal.add({ type: 'account', event: 'api-token', user: req.user, detail: `révocation ${req.params.id}` });
    res.json({ ok: true });
  });

  // ---------- Administration (garde : routes /users réservées aux admins, voir access.js) ----------
  // Seconde barrière : toute route /users exige le rôle administrateur, quoi qu'ait décidé le middleware.
  r.use('/users', roleGuard(ctx, 'admin'));
  const uid = (req) => v.str(req.params.id, 'id', { min: 16, max: 16 });
  r.get('/users', (req, res) => res.json({ users: users.list(), groups: hosts.groups(), hosts: hosts.hosts.map((h) => ({ id: h.id, name: h.name, group: h.group })) }));
  r.post('/users', (req, res) => {
    const u = users.create({ username: req.body?.username, password: req.body?.password, role: req.body?.role ?? 'operator', mustChangePassword: true });
    if (Array.isArray(req.body?.grants)) users.setGrants(u.id, req.body.grants);
    journal.add({ type: 'account', event: 'create', user: req.user, detail: `${u.username} (${u.role})` });
    res.status(201).json({ user: { ...u, grants: users.grants(u.id) } });
  });
  r.patch('/users/:id', (req, res) => {
    const id = uid(req);
    const { role, disabled, password } = req.body || {};
    const u = users.update(id, { role, disabled, password });
    journal.add({ type: 'account', event: 'update', user: req.user, detail: `${u.username} ${JSON.stringify({ role, disabled, password: password ? '(réinitialisé)' : undefined })}` });
    ctx.revalidateTerminals?.();
    res.json({ user: u });
  });
  r.put('/users/:id/grants', (req, res) => {
    const id = uid(req);
    const grants = users.setGrants(id, req.body?.grants);
    journal.add({ type: 'account', event: 'grants', user: req.user, detail: `${users.get(id).username} : ${grants.map((g) => `${g.scope}:${g.target || '*'}=${g.role}`).join(', ') || 'aucun'}` });
    ctx.revalidateTerminals?.();
    res.json({ grants });
  });
  r.post('/users/:id/reset-totp', (req, res) => {
    const id = uid(req);
    users.resetTotp(id);
    journal.add({ type: 'account', event: 'totp-reset', user: req.user, detail: users.get(id).username });
    res.json({ ok: true });
  });
  r.delete('/users/:id', (req, res) => {
    const id = uid(req);
    if (id === req.user.id) throw new HttpError(409, 'SELF', 'Vous ne pouvez pas supprimer votre propre compte');
    const name = users.get(id).username;
    users.remove(id);
    ctx.revalidateTerminals?.();
    journal.add({ type: 'account', event: 'delete', user: req.user, detail: name });
    res.json({ ok: true });
  });
  return r;
}
