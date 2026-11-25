// Proxy web vers des services privés du tailnet, servis sous /proxy/<jeton>/.
// Sécurité :
//  - cibles limitées aux adresses Tailscale / loopback (privées sur option), vérifiées APRÈS
//    résolution DNS (anti DNS-rebinding) ;
//  - accès par jeton aléatoire à durée limitée (pas de cookie Corvus transmis) ;
//  - réponses servies avec `CSP: sandbox` SANS allow-same-origin : la page proxifiée a une
//    origine opaque et ne peut ni lire ni piloter l'API Corvus.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { classifyAddress } from './netcheck.js';
import { logger } from './log.js';

const log = logger('proxy');
const CAP_TTL_MS = 12 * 3600_000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie']);
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox';

export class ProxyService {
  constructor({ db, journal, config }) {
    this.db = db;
    this.caps = new Map();
    this.journal = journal;
    this.config = config;
  }

  list() {
    return this.db.all('SELECT id, name, url, created_at AS createdAt FROM services ORDER BY name');
  }

  get(id) {
    const s = this.list().find((x) => x.id === id);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Service introuvable');
    return s;
  }

  parseUrl(raw) {
    const s = v.str(raw, 'URL', { min: 8, max: 500 }).trim();
    let u;
    try { u = new URL(s); } catch { throw v.bad('URL invalide'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw v.bad('Seuls http:// et https:// sont acceptés');
    if (u.username || u.password) throw v.bad('Identifiants dans l\'URL interdits');
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  }

  create(body) {
    const svc = {
      id: crypto.randomBytes(6).toString('hex'),
      name: v.str(body?.name ?? '', 'nom', { min: 1, max: 60 }).trim(),
      url: this.parseUrl(body?.url),
      createdAt: Date.now(),
    };
    this.db.run('INSERT INTO services (id, name, url, created_at) VALUES (?, ?, ?, ?)', svc.id, svc.name, svc.url, svc.createdAt);
    return svc;
  }

  delete(id) {
    this.get(id);
    this.db.run('DELETE FROM services WHERE id = ?', id);
    for (const [cap, c] of this.caps) if (c.serviceId === id) this.caps.delete(cap);
  }

  /** Vérifie que la cible résout vers une adresse autorisée. */
  async checkTarget(url) {
    const { hostname } = new URL(url);
    const host = hostname.replace(/^\[|\]$/g, '');
    let addrs;
    try {
      addrs = await dns.lookup(host, { all: true, verbatim: true });
    } catch {
      throw new HttpError(502, 'DNS', `Nom introuvable : ${host} (MagicDNS activé ?)`);
    }
    const allowed = new Set(['tailscale', 'loopback', ...(this.config.proxyAllowPrivate ? ['private'] : [])]);
    const bad = addrs.find((a) => !allowed.has(classifyAddress(a.address)));
    if (bad || !addrs.length) {
      throw new HttpError(403, 'TARGET_FORBIDDEN',
        `Cible refusée : ${host} → ${bad?.address || '?'}. Seules les adresses Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) et locales sont autorisées${this.config.proxyAllowPrivate ? ' (+ réseaux privés)' : ' (CORVUS_PROXY_ALLOW_PRIVATE=1 pour le LAN)'}.`);
    }
    return addrs[0].address;
  }

  async open(id) {
    const svc = this.get(id);
    await this.checkTarget(svc.url);
    const now = Date.now();
    for (const [k, c] of this.caps) if (c.expires < now) this.caps.delete(k); // liens expirés jamais rouverts
    const cap = crypto.randomBytes(18).toString('base64url');
    this.caps.set(cap, { serviceId: id, expires: Date.now() + CAP_TTL_MS });
    this.journal.add({ type: 'proxy', event: 'open', detail: `${svc.name} (${svc.url})` });
    return { url: `/proxy/${cap}/`, expiresIn: CAP_TTL_MS / 1000 };
  }

  resolveCap(cap) {
    const c = this.caps.get(cap);
    if (!c || c.expires < Date.now()) {
      this.caps.delete(cap);
      return null;
    }
    c.expires = Date.now() + CAP_TTL_MS; // expiration glissante
    const svc = this.list().find((s) => s.id === c.serviceId);
    return svc || null;
  }

  /** Middleware Express monté sur /proxy/:cap. */
  handler() {
    return async (req, res) => {
      const cap = req.params.cap;
      const svc = typeof cap === 'string' && cap.length === 24 ? this.resolveCap(cap) : null;
      if (!svc) {
        res.status(404).set({ 'Content-Security-Policy': "default-src 'none'", 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Lien de proxy expiré ou invalide : rouvrez le service depuis Corvus.');
        return;
      }
      const base = new URL(svc.url);
      // Monté via app.use('/proxy/:cap') : req.url ne contient plus le préfixe.
      let target;
      try {
        target = buildTarget(base, req.url);
      } catch (err) {
        res.status(err.status || 400).type('text/plain').end(err.message);
        return;
      }
      let address;
      try {
        address = await this.checkTarget(target.toString());
      } catch (err) {
        res.status(err.status || 502).type('text/plain').end(err.message);
        return;
      }
      const headers = {};
      for (const [k, val] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('x-forwarded-') && k !== 'x-corvus') headers[k] = val;
      headers.host = base.host;
      headers['x-forwarded-proto'] = req.protocol;
      headers['x-forwarded-prefix'] = `/proxy/${cap}`;
      delete headers.origin;
      delete headers.referer;
      // Un token Corvus ne doit jamais partir vers un service tiers.
      if (/^Bearer\s+cv_/i.test(String(headers.authorization || ''))) delete headers.authorization;
      const lib = target.protocol === 'https:' ? https : http;
      const upstream = lib.request({
        protocol: target.protocol,
        hostname: address,
        servername: base.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: target.pathname + target.search,
        headers,
        timeout: 30_000,
        // Les services du tailnet ont souvent des certificats auto-signés ; le transport est déjà chiffré par WireGuard.
        rejectUnauthorized: false,
      }, (up) => {
        const out = {};
        for (const [k, val] of Object.entries(up.headers)) {
          if (HOP.has(k) || k === 'set-cookie' || k === 'content-security-policy' || k === 'x-frame-options' || k === 'strict-transport-security') continue;
          out[k] = val;
        }
        if (out.location) out.location = rewriteLocation(out.location, base, cap);
        out['content-security-policy'] = SANDBOX;
        out['referrer-policy'] = 'no-referrer';
        out['x-content-type-options'] = 'nosniff';
        out['cache-control'] = out['cache-control'] || 'no-store';
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('délai dépassé')));
      upstream.on('error', (err) => {
        log.warn(`${svc.name} : ${err.message}`);
        if (!res.headersSent) res.status(502).type('text/plain').end(`Service injoignable : ${err.message}`);
        else res.destroy();
      });
      req.pipe(upstream);
    };
  }
}

/**
 * Construit l'URL amont à partir du service enregistré et du chemin demandé au proxy.
 * Le résultat reste TOUJOURS sur l'origine du service et sous son préfixe : un chemin comme
 * `//127.0.0.1:7680/x` ou `/\\autre-hote/x` serait sinon interprété par `new URL` comme un autre hôte.
 */
export function buildTarget(base, reqUrl) {
  const raw = String(reqUrl || '/');
  const qi = raw.indexOf('?');
  const rest = qi < 0 ? raw : raw.slice(0, qi);
  const search = qi < 0 ? '' : raw.slice(qi);
  const basePath = base.pathname.replace(/\/$/, '');
  const target = new URL(`${basePath}/${rest.replace(/^[\\/]+/, '')}`, base);
  target.search = search;
  if (target.origin !== base.origin || (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))) {
    throw new HttpError(400, 'BAD_PATH', 'Chemin refusé : il sort du service enregistré');
  }
  return target;
}

export function rewriteLocation(loc, base, cap) {
  const prefix = `/proxy/${cap}`;
  try {
    const u = new URL(loc, base);
    if (u.origin !== base.origin) return loc;
    const basePath = base.pathname.replace(/\/$/, '');
    const p = u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) : u.pathname;
    return `${prefix}${p.startsWith('/') ? p : `/${p}`}${u.search}`;
  } catch {
    return loc;
  }
}
