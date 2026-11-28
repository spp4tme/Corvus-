// Assemblage de l'application : HTTP (Express) + WebSocket, sécurité transverse.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { AgentService } from './lib/agents.js';
import { installScript } from './lib/agent-install.js';
import { installScriptWindows } from './lib/agent-install-windows.js';
import { config as baseConfig } from './config.js';
import { Auth, loadToken, originAllowed, isLoopback } from './lib/auth.js';
import { Vault } from './lib/vault.js';
import { HostRegistry } from './lib/hosts.js';
import { KnownHosts } from './lib/knownhosts.js';
import { SshPool } from './lib/ssh.js';
import { Journal } from './lib/journal.js';
import { ClaudeService } from './lib/claude.js';
import { TerminalManager } from './lib/terminal.js';
import { ensureDir } from './lib/store.js';
import { Db } from './db/index.js';
import { migrateLegacy } from './db/migrate-json.js';
import { resolveStorage, StorageMonitor } from './lib/storage.js';
import { Alerts } from './lib/alerts.js';
import { BlobStore } from './lib/blobs.js';
import { BackupService, applyPendingRestore } from './lib/backup.js';
import { Retention } from './lib/retention.js';
import { Recorder } from './lib/recorder.js';
import { HttpError } from './lib/validate.js';
import { logger, setLogLevel } from './lib/log.js';
import { hostRoutes } from './routes/core.js';
import { authRoutes, accountRoutes } from './routes/accounts.js';
import { accessGuard } from './lib/access.js';
import { AutomationService } from './lib/automation/service.js';
import { RequestLimiter, isStrictPath } from './lib/ratelimit.js';
import { Users, publicUser } from './lib/users.js';
import { requestContext } from './lib/context.js';
import { Challenges } from './lib/webauthn.js';
import { extraRoutes, createServices } from './routes/index.js';

const log = logger('http');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function securityHeaders(req, res, next) {
  res.set({
    // Les styles inline sont requis par xterm.js (thème injecté via <style>) ; les scripts restent stricts.
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
  });
  // Navigateur ramené en https pour de bon (derrière tailscale serve ou un proxy de confiance).
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
}

export function createCorvus(overrides = {}) {
  const config = { ...baseConfig, ...overrides, allowedOrigins: [...(overrides.allowedOrigins || baseConfig.allowedOrigins)] };
  setLogLevel(config.logLevel);
  ensureDir(config.dataDir);

  const storage = resolveStorage(config);
  // Restauration préparée depuis l'interface : appliquée avant d'ouvrir la base et de lire le token.
  const restoredFrom = applyPendingRestore(storage, config.dataDir);
  const { token, created } = loadToken(config.dataDir);
  const db = new Db(storage.dbFile);
  let vault;
  try {
    vault = new Vault(db, { token, passphrase: config.masterPassphrase });
  } catch (err) {
    db.close();
    throw err;
  }
  const hosts = new HostRegistry({ db, vault });
  migrateLegacy({ db, dataDir: config.dataDir, vault, hosts, token, passphrase: config.masterPassphrase });
  const auth = new Auth({ db, token, sessionTtlDays: config.sessionTtlDays });
  const users = new Users({ db, vault, hosts });
  const webauthn = new Challenges();
  auth.users = users;
  const knownHosts = new KnownHosts(db);
  const journal = new Journal(db);
  const pool = new SshPool({ hosts, knownHosts, config });
  const ctx = { config, storage, db, auth, users, webauthn, vault, hosts, knownHosts, journal, pool, version: pkg.version, token, tokenCreated: created };
  ctx.alerts = new Alerts({ db, journal, notify: (n) => ctx.push?.notify(n).catch(() => {}) });
  ctx.storageMonitor = new StorageMonitor({ storage, config, alerts: ctx.alerts });
  ctx.restoredFrom = restoredFrom;
  ctx.blobs = new BlobStore({ db, vault, dir: storage.blobDir });
  ctx.backups = new BackupService({ db, storage, config, journal });
  ctx.retention = new Retention({ db, blobs: ctx.blobs, config });
  ctx.recorder = new Recorder({ db, blobs: ctx.blobs, maxBytes: config.recordingMaxBytes, enabled: config.recordSessions });
  ctx.claude = new ClaudeService({ pool, hosts, journal });
  ctx.agents = new AgentService({ db, vault, journal, hosts, alerts: ctx.alerts, blobs: ctx.blobs });
  // Automatisation (playbooks) : DÉSACTIVÉE par défaut (`automation.enabled` faux) tant qu'un administrateur ne l'active pas.
  ctx.automation = new AutomationService({ db, hosts, vault, journal, agents: ctx.agents, alerts: ctx.alerts });
  ctx.terminals = new TerminalManager({
    pool, hosts, journal, config, claude: ctx.claude,
    requireHost: (user, hostId, level) => ctx.requireHost(user, hostId, level),
    recorder: ctx.recorder,
    // Revalidation des terminaux ouverts : compte actif, rôle suffisant sur l'hôte, session toujours valide.
    accountOk: (userId, hostId, level) => {
      const u = ctx.users.row(userId);
      if (!u || u.disabled) return false;
      if (level === 'none') return true;
      const host = ctx.hosts.find(hostId);
      const role = host && ctx.users.hostRole(publicUser(u), host);
      return !!role && Users.atLeast(role, level);
    },
    sessionOk: (key) => !!db.get('SELECT 1 AS ok FROM auth_sessions WHERE key = ? AND expires_at > ?', key, Date.now()),
    onNotify: (n) => ctx.notify?.(n),
  });
  createServices(ctx);

  const trustForwarded = config.trustProxy !== false && config.trustProxy !== 'false';
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 'false' ? false : config.trustProxy);
  app.set('etag', false);
  // Proxy web : monté AVANT les en-têtes globaux (il impose sa propre CSP « sandbox »).
  if (config.webProxy) app.use('/proxy/:cap', ctx.proxy.handler());
  app.use(securityHeaders);

  // --- API ---------------------------------------------------------------
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: '4mb' }));
  api.get('/health', (req, res) => res.json({ ok: true }));
  api.use('/auth', authRoutes(ctx));
  // Script d'installation de l'agent : public (il ne contient aucun secret, le jeton est passé en argument).
  api.get('/agent/install.sh', (req, res) => {
    res.type('text/x-shellscript; charset=utf-8').send(installScript(ctx.version));
  });
  api.get('/agent/install.ps1', (req, res) => {
    res.type('text/plain; charset=utf-8').send(installScriptWindows(ctx.version));
  });
  // Enrôlement d'un agent : public, protégé par le jeton à usage unique (et le limiteur d'échecs par IP).
  api.post('/agent/enroll', (req, res, next) => {
    const wait = auth.limiter.blockedFor(req.ip);
    if (wait > 0) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      return next(new HttpError(429, 'RATE_LIMITED', 'Trop de tentatives'));
    }
    try {
      res.json(ctx.agents.enroll(req.body || {}));
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) auth.limiter.fail(req.ip);
      next(err);
    }
  });

  // Limiteur de débit des routes authentifiées : par compte ET par IP, plafond plus strict pour les sauvegardes.
  const limiter = new RequestLimiter({ accountPerMin: config.rateAccountPerMin, ipPerMin: config.rateIpPerMin, strictPerMin: config.rateBackupPerMin });
  ctx.requestLimiter = limiter;
  const enforceRate = (req, res) => {
    const strict = isStrictPath(req.path);
    const r = limiter.check({ accountId: req.user.id, ip: req.ip, strict });
    if (r.ok) return null;
    res.set('Retry-After', String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))));
    // Une entrée de journal par minute et par compte/IP (jamais une par requête refusée : le journal reste inondable sinon).
    const key = r.scope === 'account' ? req.user.id : req.ip;
    if (limiter.shouldReport(r.scope, r.strict, key)) {
      journal.add({ type: 'ratelimit', event: 'exceeded', user: req.user, ip: req.ip, ok: false,
        detail: `plafond ${r.strict ? 'sauvegardes' : 'global'} par ${r.scope === 'account' ? 'compte' : 'IP'} dépassé (${req.method})` });
    }
    return new HttpError(429, 'RATE_LIMITED', 'Trop de requêtes : réessayez dans quelques instants');
  };

  // Tout le reste exige une authentification.
  api.use((req, res, next) => {
    const who = auth.identify(req);
    if (!who) {
      if (req.headers.authorization) {
        const wait = auth.limiter.blockedFor(req.ip);
        if (wait > 0) {
          res.set('Retry-After', String(Math.ceil(wait / 1000)));
          return next(new HttpError(429, 'RATE_LIMITED', 'Trop de tentatives d\'authentification'));
        }
        const penalty = auth.limiter.fail(req.ip);
        return setTimeout(() => next(new HttpError(401, 'UNAUTHENTICATED', 'Authentification requise')), penalty);
      }
      return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentification requise'));
    }
    // Protection CSRF pour les sessions cookie : en-tête personnalisé + origine identique.
    if (who.kind === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['x-corvus'] !== '1') return next(new HttpError(403, 'CSRF', 'En-tête X-Corvus manquant'));
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin, req, { allowedOrigins: config.allowedOrigins, trustForwarded })) {
        return next(new HttpError(403, 'BAD_ORIGIN', 'Origine refusée'));
      }
    }
    req.authKind = who.kind;
    req.user = publicUser(who.user);
    req.sessionKey = who.sessionKey;
    const tooMany = enforceRate(req, res);
    if (tooMany) return next(tooMany);
    // Mot de passe provisoire (créé par un admin) : seul le changement de mot de passe est permis.
    if (req.user.mustChangePassword && !/^\/(me|me\/password|auth(\/.*)?)$/.test(req.path)) {
      return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Changez votre mot de passe provisoire (Réglages → Mon compte).'));
    }
    req.allowedHostIds = () => {
      const ids = ctx.users.allowedHostIds(req.user);
      if (ids) ids.userId = req.user.id;
      return ids;
    };
    requestContext.run({ user: req.user, ip: req.ip }, next);
  });
  api.use(accessGuard(ctx));
  api.use(accountRoutes(ctx));
  api.use(hostRoutes(ctx));
  api.use(extraRoutes(ctx));
  api.use((req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route inconnue')));
  app.use('/api', api);

  // --- Fichiers statiques -------------------------------------------------
  const vendor = (file) => path.join(config.root, 'node_modules', file);
  const vendorMap = {
    'xterm.js': vendor('@xterm/xterm/lib/xterm.js'),
    'xterm.css': vendor('@xterm/xterm/css/xterm.css'),
    'addon-fit.js': vendor('@xterm/addon-fit/lib/addon-fit.js'),
  };
  app.get('/vendor/:file', (req, res, next) => {
    const f = vendorMap[req.params.file];
    if (!f) return next();
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(f);
  });
  // Le service worker intercepte « Partager vers Corvus » (POST /share-target). Sans lui (navigateur qui n'a pas encore
  // installé la dernière version), on ne lit ni ne garde rien : simple redirection vers l'écran d'explication.
  app.post('/share-target', (req, res) => {
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 1024 * 1024) req.destroy(); }); // le corps est jeté, au plus 1 Mo lu
    res.redirect(303, '/#/share?unavailable=1');
  });
  ctx.mountExtraStatic?.(app);
  app.use(express.static(config.publicDir, {
    index: 'index.html',
    setHeaders(res, file) {
      const base = path.basename(file);
      if (base === 'sw.js' || base.startsWith('sw-') || base === 'index.html' || base.endsWith('.webmanifest')) {
        res.set('Cache-Control', 'no-cache');
      } else {
        res.set('Cache-Control', 'public, max-age=3600');
      }
      if (base.endsWith('.webmanifest')) res.type('application/manifest+json');
    },
  }));

  app.use((req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'Introuvable')));

  // --- Erreurs ------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') err = new HttpError(413, 'TOO_LARGE', 'Requête trop volumineuse');
    if (err?.type === 'entity.parse.failed') err = new HttpError(400, 'BAD_JSON', 'JSON invalide');
    if (!(err instanceof HttpError)) {
      log.error(`${req.method} ${req.path}`, err);
      err = new HttpError(500, 'INTERNAL', 'Erreur interne');
    }
    if (res.headersSent) return res.end();
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  });

  // --- Serveur HTTP + WebSocket ------------------------------------------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  ctx.wsRoutes = { '/ws/terminal': (ws, url, req) => ctx.terminals.handle(ws, url, req) };
  // Routes WebSocket sans session navigateur : l'authentification y est le défi signé (Ed25519) de l'agent.
  ctx.wsPublic = { '/agent': (ws, url, req) => ctx.agents.handle(ws, url, req) };

  server.on('upgrade', (req, socket, head) => {
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let url;
    try { url = new URL(req.url, 'http://corvus.local'); } catch { return reject(400, 'Bad Request'); }
    const publicHandler = ctx.wsPublic[url.pathname];
    const handler = publicHandler || ctx.wsRoutes[url.pathname];
    if (!handler) return reject(404, 'Not Found');

    // req.ip n'existe pas hors Express : on reconstruit l'IP pour le limiteur.
    const remote = req.socket.remoteAddress;
    const fwd = isLoopback(remote) && trustForwarded ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const ip = fwd || remote;

    let who = null;
    if (!publicHandler) {
      who = auth.identify(req);
      if (!who) {
        if (req.headers.authorization) {
          if (auth.limiter.blockedFor(ip) > 0) return reject(429, 'Too Many Requests');
          auth.limiter.fail(ip);
        }
        return reject(401, 'Unauthorized');
      }
      // Origin check : obligatoire pour un navigateur (cookie). Un client Bearer peut ne pas en envoyer.
      const origin = req.headers.origin;
      if (origin ? !originAllowed(origin, req, { allowedOrigins: config.allowedOrigins, trustForwarded }) : who.kind !== 'bearer') {
        log.warn(`WebSocket refusé : origine ${origin || '(absente)'} depuis ${ip}`);
        return reject(403, 'Forbidden');
      }
    } else if (req.headers.origin) {
      // Un agent n'est pas un navigateur : une origine présente trahit une page web qui tente sa chance.
      return reject(403, 'Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => {});
      req.user = who ? publicUser(who.user) : null;
      req.sessionKey = who?.sessionKey;
      req.clientIp = ip;
      Promise.resolve(requestContext.run({ user: req.user, ip }, () => handler(ws, url, req))).catch((err) => {
        log.error('WebSocket', err);
        ws.close(1011, 'erreur interne');
      });
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25_000);
  heartbeat.unref();
  // Filet de sécurité : les droits des terminaux ouverts sont revérifiés régulièrement (et à chaque changement de compte).
  const revalidation = setInterval(() => ctx.terminals.revalidate(), 10_000);
  revalidation.unref();
  ctx.revalidateTerminals = () => ctx.terminals.revalidate();

  async function listen(port = config.port, host = config.bind) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    ctx.storageMonitor.start();
    ctx.retention.start();
    if (config.hostProbeSec > 0) { ctx.hostStatus.start(); ctx.agents.start(); ctx.automationScheduler?.start(); }
    if (config.metricsIntervalSec > 0) ctx.metrics.start();
    return server.address();
  }

  async function close() {
    clearInterval(heartbeat);
    clearInterval(revalidation);
    ctx.terminals.closeAll();
    ctx.agents.closeAll();
    pool.closeAll();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(r));
    ctx.onClose?.();
    ctx.storageMonitor.stop();
    ctx.retention.stop();
    ctx.hostStatus.stop();
    ctx.automationScheduler?.stop();
    ctx.agents.stop();
    ctx.metrics.stop();
    for (const t of ctx.timers || []) clearInterval(t);
    db.close();
  }

  return { app, server, ctx, listen, close, config };
}
