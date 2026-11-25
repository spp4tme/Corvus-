// Démarre une instance Corvus isolée (dossier de données temporaire) + client HTTP/WS authentifié.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createCorvus } from '../../server/app.js';
import * as totp from '../../server/lib/totp.js';

export const ADMIN = { username: 'admin', password: 'mot-de-passe-admin-test' };

/** Crée un compte avec TOTP déjà activé (les tests n'ont pas de téléphone). */
export function makeUser(corvus, { username, password, role = 'admin' }) {
  const { users } = corvus.ctx;
  const u = users.create({ username, password, role });
  const secret = totp.generateSecret();
  corvus.ctx.vault.set(`totp:${u.id}`, { secret });
  corvus.ctx.db.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', u.id);
  return { ...u, password, secret };
}

/** Code TOTP valide ; le compteur anti-rejeu est remis à zéro (plusieurs connexions par test). */
export function freshCode(corvus, user) {
  corvus.ctx.db.run('UPDATE users SET totp_last_step = -1 WHERE id = ?', user.id);
  return totp.codeAt(user.secret, totp.stepAt());
}

export async function startCorvus(overrides = {}, { setup = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-data-'));
  // Tâches de fond coupées par défaut (activées par les tests qui les vérifient).
  const corvus = createCorvus({ dataDir, logLevel: 'warn', port: 0, bind: '127.0.0.1', hostProbeSec: 0, metricsIntervalSec: 0, ...overrides });
  const addr = await corvus.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const admin = setup ? makeUser(corvus, { ...ADMIN, role: 'admin' }) : null;
  // `token` : jeton d'API personnel de l'admin (Bearer), comme l'ancien token unique.
  const token = admin ? corvus.ctx.users.createToken(admin.id, 'tests').token : null;
  const client = new CorvusClient(base, { corvus, user: admin });
  return { corvus, base, dataDir, client, admin, token, bootstrapToken: corvus.ctx.token, close: () => corvus.close() };
}

export class CorvusClient {
  constructor(base, { corvus, user } = {}) {
    this.base = base;
    this.corvus = corvus;
    this.user = user;
    this.cookie = null;
  }

  get origin() {
    return this.base;
  }

  /** Connexion mot de passe + TOTP. `creds` remplace les valeurs par défaut (tests d'échec). */
  async login(creds = {}) {
    const u = this.user;
    const body = { username: u?.username, password: u?.password, code: u ? freshCode(this.corvus, u) : '', ...creds };
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return res;
  }

  async raw(method, url, { body, headers = {}, csrf = true } = {}) {
    const h = {};
    if (this.cookie) h.cookie = this.cookie;
    if (csrf) { h['x-corvus'] = '1'; h.origin = this.origin; }
    Object.assign(h, headers);
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return fetch(this.base + url, { method, headers: h, body: payload });
  }

  async api(method, url, body, opts = {}) {
    const res = await this.raw(method, url, { body, ...opts });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }

  /** Ouvre un WebSocket et collecte la sortie du terminal. */
  terminal(query, { origin = this.origin } = {}) {
    const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws/terminal?${new URLSearchParams(query)}`, {
      headers: { cookie: this.cookie || '', origin },
    });
    const t = { ws, output: '', ctl: [], closed: false };
    ws.on('message', (data, isBinary) => {
      if (isBinary) t.output += data.toString('utf8');
      else t.ctl.push(JSON.parse(data.toString('utf8')));
    });
    ws.on('close', () => { t.closed = true; });
    t.opened = new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
      ws.once('error', reject);
    });
    t.send = (d) => ws.send(JSON.stringify({ t: 'i', d }));
    t.waitFor = (pred, timeout = 15000) => waitFor(() => pred(t), timeout);
    t.ready = () => t.waitFor((x) => x.ctl.find((c) => c.t === 'ready' || c.t === 'error'));
    return t;
  }
}

export async function waitFor(fn, timeout = 15000, step = 50) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor : délai dépassé');
    await new Promise((r) => setTimeout(r, step));
  }
}
