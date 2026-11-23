// Routes : authentification, hôtes, terminaux, journal, tailscale.
import { Router } from 'express';
import { COOKIE, parseCookies, tokenMatches } from '../lib/auth.js';
import { tailscalePeers } from '../lib/tailscale.js';
import { HttpError } from '../lib/validate.js';
import * as v from '../lib/validate.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function authRoutes(ctx) {
  const r = Router();
  const { auth, journal, config } = ctx;

  r.get('/status', (req, res) => {
    res.json({ authenticated: !!auth.identify(req), version: ctx.version });
  });

  r.post('/login', async (req, res) => {
    const ip = req.ip;
    const wait = auth.limiter.blockedFor(ip);
    if (wait > 0) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      throw new HttpError(429, 'RATE_LIMITED', `Trop de tentatives. Réessayez dans ${Math.ceil(wait / 60000)} min.`);
    }
    if (!tokenMatches(req.body?.token, auth.token)) {
      const penalty = auth.limiter.fail(ip);
      journal.add({ type: 'auth', event: 'login', ok: false, detail: `échec depuis ${ip}` });
      await sleep(penalty);
      throw new HttpError(401, 'BAD_TOKEN', 'Token invalide');
    }
    auth.limiter.success(ip);
    const sid = auth.createSession({ ua: req.headers['user-agent'], ip });
    journal.add({ type: 'auth', event: 'login', detail: `depuis ${ip}` });
    res.cookie(COOKIE, sid, {
      httpOnly: true,
      sameSite: 'strict',
      // https direct, via tailscale serve (X-Forwarded-Proto) ou origine https déclarée par le navigateur
      secure: req.secure || String(req.headers.origin || '').startsWith('https://'),
      path: '/',
      maxAge: config.sessionTtlDays * 86_400_000,
    });
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    auth.destroySession(parseCookies(req.headers.cookie)[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return r;
}

export function hostRoutes(ctx) {
  const r = Router();
  const { hosts, pool, knownHosts, journal, terminals, config } = ctx;

  r.get('/hosts', (req, res) => {
    res.json({
      hosts: hosts.list().map((h) => ({ ...h, connection: pool.status(h.id), knownHost: knownHosts.get(h.hostname, h.port) })),
    });
  });

  r.post('/hosts', (req, res) => {
    res.status(201).json({ host: hosts.create(req.body) });
  });

  // Test d'une configuration non enregistrée (formulaire d'ajout).
  r.post('/hosts/test', async (req, res) => {
    const draft = hosts.parse(req.body);
    const secrets = hosts.parseSecrets(req.body) || {};
    const result = await pool.test(hosts.connectConfig(draft, secrets));
    journal.add({ type: 'test', event: 'test', host: draft, ok: result.ok });
    res.json(result);
  });

  r.get('/hosts/:id', (req, res) => {
    const h = hosts.get(v.id(req.params.id));
    res.json({ host: { ...hosts.publicView(h), connection: pool.status(h.id), knownHost: knownHosts.get(h.hostname, h.port) } });
  });

  r.patch('/hosts/:id', (req, res) => {
    const id = v.id(req.params.id);
    const connChanged = ['hostname', 'port', 'username', 'authType', 'password', 'privateKey', 'passphrase', 'clearSecrets']
      .some((k) => k in (req.body || {}));
    const host = hosts.update(id, req.body);
    if (connChanged) pool.drop(id);
    res.json({ host });
  });

  r.delete('/hosts/:id', (req, res) => {
    const id = v.id(req.params.id);
    hosts.get(id);
    for (const t of terminals.list()) if (t.hostId === id) terminals.close(t.id);
    pool.drop(id);
    hosts.delete(id);
    res.json({ ok: true });
  });

  r.post('/hosts/:id/test', async (req, res) => {
    const h = hosts.get(v.id(req.params.id));
    try {
      const result = await pool.test(hosts.connectConfig(h));
      journal.add({ type: 'test', event: 'test', host: h, ok: result.ok, detail: result.uname });
      res.json(result);
    } catch (err) {
      journal.add({ type: 'test', event: 'test', host: h, ok: false, detail: err.message });
      throw err;
    }
  });

  r.get('/hosts/:id/hostkey', (req, res) => {
    const h = hosts.get(v.id(req.params.id));
    res.json({ knownHost: knownHosts.get(h.hostname, h.port) });
  });

  // Oublier l'empreinte (après vérification hors-bande d'une réinstallation légitime).
  r.delete('/hosts/:id/hostkey', (req, res) => {
    const h = hosts.get(v.id(req.params.id));
    knownHosts.forget(h.hostname, h.port);
    pool.drop(h.id);
    journal.add({ type: 'test', event: 'hostkey-reset', host: h });
    res.json({ ok: true });
  });

  r.get('/tailscale/peers', async (req, res) => {
    res.json(await tailscalePeers(config.tailscaleBin));
  });

  r.get('/terminals', (req, res) => {
    res.json({ terminals: terminals.list() });
  });

  r.delete('/terminals/:id', (req, res) => {
    const id = v.str(req.params.id, 'id', { min: 8, max: 32 });
    terminals.close(id);
    res.json({ ok: true });
  });

  r.get('/journal', (req, res) => {
    const limit = v.int(req.query.limit, 'limit', { min: 1, max: 2000, def: 200 });
    const type = req.query.type ? v.str(req.query.type, 'type', { max: 20 }) : undefined;
    const hostId = req.query.hostId ? v.id(req.query.hostId) : undefined;
    res.json({ entries: journal.list({ limit, type, hostId }) });
  });

  r.delete('/journal', (req, res) => {
    journal.clear();
    res.json({ ok: true });
  });

  return r;
}
