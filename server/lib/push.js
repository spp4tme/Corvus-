// Notifications Web Push (VAPID, RFC 8292) sans dépendance : le push est envoyé SANS charge
// utile (pas de chiffrement de contenu nécessaire) ; le service worker récupère ensuite le
// détail via /api/push/latest avec le cookie de session.
// Déclencheur : la séquence OSC 777 « notify » émise dans un terminal (voir docs/notifications.md).
import crypto from 'node:crypto';
import https from 'node:https';
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { logger } from './log.js';

const log = logger('push');
// Services de push des navigateurs (anti-SSRF : aucun autre hôte n'est contacté).
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/, /^push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/];

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Clés VAPID conservées dans le coffre chiffré.
function loadKeys(vault) {
  const existing = vault.get('push:vapid');
  if (existing?.privateJwk) return existing;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const keys = {
    privateJwk: privateKey.export({ format: 'jwk' }),
    publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')])),
  };
  vault.set('push:vapid', keys);
  return keys;
}

export class PushService {
  constructor({ db, vault, config, journal }) {
    this.db = db;
    this.keys = loadKeys(vault);
    this.privateKey = crypto.createPrivateKey({ key: this.keys.privateJwk, format: 'jwk' });
    this.subject = config.vapidSubject;
    this.journal = journal;
    this.latest = null;
  }

  get publicKey() {
    return this.keys.publicKey;
  }

  validateEndpoint(endpoint) {
    const s = v.str(endpoint, 'endpoint', { min: 10, max: 1000 });
    let u;
    try { u = new URL(s); } catch { throw v.bad('Endpoint invalide'); }
    if (u.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(u.hostname))) {
      throw v.bad('Service de push non reconnu');
    }
    return u.toString();
  }

  subscribe(body) {
    const endpoint = this.validateEndpoint(body?.endpoint);
    const label = v.str(body?.label ?? '', 'appareil', { max: 80 });
    this.db.tx(() => {
      this.db.run(`INSERT INTO push_subscriptions (endpoint, user_id, label, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET label = excluded.label, user_id = excluded.user_id`, endpoint, body?.userId ?? null, label, Date.now());
      // 20 appareils au plus : les plus anciens sont oubliés.
      this.db.run('DELETE FROM push_subscriptions WHERE endpoint NOT IN (SELECT endpoint FROM push_subscriptions ORDER BY created_at DESC LIMIT 20)');
    });
    return { count: this.count() };
  }

  unsubscribe(endpoint) {
    this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
  }

  count() {
    return this.db.get('SELECT COUNT(*) AS n FROM push_subscriptions').n;
  }

  subscriptions() {
    return this.db.all('SELECT endpoint, user_id AS userId, label FROM push_subscriptions');
  }

  vapidHeader(endpoint) {
    const aud = new URL(endpoint).origin;
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const payload = b64url(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.subject }));
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${payload}.${b64url(sig)}, k=${this.publicKey}`;
  }

  sendOne(endpoint) {
    return new Promise((resolve) => {
      const req = https.request(endpoint, {
        method: 'POST',
        headers: { Authorization: this.vapidHeader(endpoint), TTL: '300', Urgency: 'normal', 'Content-Length': '0' },
        timeout: 10_000,
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(0));
      req.end();
    });
  }

  /** @param {{title: string, body: string, sessionId?: string, hostId?: string}} n */
  async notify(n) {
    this.latest = { title: String(n.title || 'Corvus').slice(0, 120), body: String(n.body || '').slice(0, 400), sessionId: n.sessionId, hostId: n.hostId, ts: Date.now() };
    const subs = this.subscriptions();
    if (!subs.length) return { sent: 0 };
    let sent = 0;
    const dead = [];
    await Promise.all(subs.map(async (s) => {
      const code = await this.sendOne(s.endpoint);
      if (code >= 200 && code < 300) sent++;
      else if (code === 404 || code === 410) dead.push(s.endpoint);
      else log.warn(`push refusé (${code}) pour ${new URL(s.endpoint).hostname}`);
    }));
    if (dead.length) {
      for (const e of dead) this.unsubscribe(e);
    }
    return { sent };
  }

  latestNotification() {
    if (!this.latest) throw new HttpError(404, 'NONE', 'Aucune notification');
    return this.latest;
  }
}
