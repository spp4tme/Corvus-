// Assemblage de l'application : HTTP (Express) + WebSocket, sécurité transverse.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
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
import { HttpError } from './lib/validate.js';
import { logger, setLogLevel } from './lib/log.js';
import { authRoutes, hostRoutes } from './routes/core.js';
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
  next();
}

export function createCorvus(overrides = {}) {
  const config = { ...baseConfig, ...overrides, allowedOrigins: [...(overrides.allowedOrigins || baseConfig.allowedOrigins)] };
  setLogLevel(config.logLevel);
  ensureDir(config.dataDir);

  const { token, created } = loadToken(config.dataDir);
  const storage = resolveStorage(config);
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
  const knownHosts = new KnownHosts(db);
  const journal = new Journal(db);
  const pool = new SshPool({ hosts, knownHosts, config });
  const ctx = { config, storage, db, auth, vault, hosts, knownHosts, journal, pool, version: pkg.version, token, tokenCreated: created };
  ctx.alerts = new Alerts({ db, journal, notify: (n) => ctx.push?.notify(n).catch(() => {}) });
  ctx.storageMonitor = new StorageMonitor({ storage, config, alerts: ctx.alerts });
  ctx.claude = new ClaudeService({ pool, hosts, journal });
  ctx.terminals = new TerminalManager({
    pool, hosts, journal, config, claude: ctx.claude,
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

  // Tout le reste exige une authentification.
  api.use((req, res, next) => {
    const kind = auth.identify(req);
    if (!kind) {
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
    if (kind === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['x-corvus'] !== '1') return next(new HttpError(403, 'CSRF', 'En-tête X-Corvus manquant'));
      const origin = req.headers.origin;
      if (origin && !originAllowed(origin, req, { allowedOrigins: config.allowedOrigins, trustForwarded })) {
        return next(new HttpError(403, 'BAD_ORIGIN', 'Origine refusée'));
      }
    }
    req.authKind = kind;
    next();
  });
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
  ctx.mountExtraStatic?.(app);
  app.use(express.static(config.publicDir, {
    index: 'index.html',
    setHeaders(res, file) {
      const base = path.basename(file);
      if (base === 'sw.js' || base === 'index.html' || base.endsWith('.webmanifest')) {
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
  ctx.wsRoutes = { '/ws/terminal': (ws, url) => ctx.terminals.handle(ws, url) };

  server.on('upgrade', (req, socket, head) => {
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let url;
    try { url = new URL(req.url, 'http://corvus.local'); } catch { return reject(400, 'Bad Request'); }
    const handler = ctx.wsRoutes[url.pathname];
    if (!handler) return reject(404, 'Not Found');

    // req.ip n'existe pas hors Express : on reconstruit l'IP pour le limiteur.
    const remote = req.socket.remoteAddress;
    const fwd = isLoopback(remote) && trustForwarded ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const ip = fwd || remote;

    const kind = auth.identify(req);
    if (!kind) {
      if (req.headers.authorization) {
        if (auth.limiter.blockedFor(ip) > 0) return reject(429, 'Too Many Requests');
        auth.limiter.fail(ip);
      }
      return reject(401, 'Unauthorized');
    }
    // Origin check : obligatoire pour un navigateur (cookie). Un client Bearer peut ne pas en envoyer.
    const origin = req.headers.origin;
    if (origin ? !originAllowed(origin, req, { allowedOrigins: config.allowedOrigins, trustForwarded }) : kind !== 'bearer') {
      log.warn(`WebSocket refusé : origine ${origin || '(absente)'} depuis ${ip}`);
      return reject(403, 'Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => {});
      Promise.resolve(handler(ws, url, req)).catch((err) => {
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

  async function listen(port = config.port, host = config.bind) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    ctx.storageMonitor.start();
    return server.address();
  }

  async function close() {
    clearInterval(heartbeat);
    ctx.terminals.closeAll();
    pool.closeAll();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(r));
    ctx.onClose?.();
    ctx.storageMonitor.stop();
    for (const t of ctx.timers || []) clearInterval(t);
    db.close();
  }

  return { app, server, ctx, listen, close, config };
}
