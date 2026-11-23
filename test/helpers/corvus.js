// Démarre une instance Corvus isolée (dossier de données temporaire) + client HTTP/WS authentifié.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createCorvus } from '../../server/app.js';

export async function startCorvus(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-data-'));
  const corvus = createCorvus({ dataDir, logLevel: 'warn', port: 0, bind: '127.0.0.1', ...overrides });
  const addr = await corvus.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const client = new CorvusClient(base, corvus.ctx.token);
  return { corvus, base, dataDir, client, token: corvus.ctx.token, close: () => corvus.close() };
}

export class CorvusClient {
  constructor(base, token) {
    this.base = base;
    this.token = token;
    this.cookie = null;
  }

  get origin() {
    return this.base;
  }

  async login(token = this.token) {
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
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
