// Sessions de terminal. Une session survit aux déconnexions WebSocket (délai de grâce) et
// conserve un tampon circulaire de sortie : le client se reconnecte et reprend à l'octet près.
// Avec tmux, la session survit en plus à une coupure SSH ou à un redémarrage de Corvus.
import crypto from 'node:crypto';
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { q, shWrap } from './shell.js';
import { logger } from './log.js';

const log = logger('term');
const MAX_SESSIONS = 32;
const OSC_NOTIFY = /\x1b\]777;notify;([^;\x07\x1b]{0,120});([^\x07\x1b]{0,400})(?:\x07|\x1b\\)/g;

class RingBuffer {
  constructor(cap) {
    this.cap = cap;
    this.chunks = [];
    this.size = 0;
    this.total = 0;
  }
  push(buf) {
    this.chunks.push(buf);
    this.size += buf.length;
    this.total += buf.length;
    while (this.size > this.cap && this.chunks.length) {
      const first = this.chunks[0];
      const excess = this.size - this.cap;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }
  get start() {
    return this.total - this.size;
  }
  /** Octets depuis l'offset absolu `since`, ou null s'ils ont été évincés. */
  since(offset) {
    if (offset > this.total) return null;
    if (offset < this.start) return null;
    return Buffer.concat(this.chunks).subarray(offset - this.start);
  }
  all() {
    return Buffer.concat(this.chunks);
  }
}

export function tmuxCommand(sessionName) {
  const s = q(sessionName);
  return shWrap(
    `if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ${s} \\; set-option -q mouse on; ` +
    `else printf '\\r\\n\\033[33m[corvus] tmux introuvable sur cet hôte — shell classique (pas de reprise de session).\\033[0m\\r\\n'; ` +
    `exec "\${SHELL:-/bin/sh}" -l; fi`,
  );
}

export class TerminalManager {
  constructor({ pool, hosts, journal, config, onNotify, claude }) {
    Object.assign(this, { pool, hosts, journal, config, onNotify, claude });
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  view(s) {
    return {
      id: s.id, hostId: s.hostId, title: s.title, tmux: s.tmux, claude: s.claude, createdAt: s.createdAt,
      attached: s.clients.size, exited: s.exited, cols: s.cols, rows: s.rows,
    };
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, 'SESSION_GONE', 'Session de terminal terminée ou expirée');
    return s;
  }

  /**
   * `claude` : { session?, dir? } → ouvre Claude Code dans une session tmux dédiée (voir claude.js).
   * La commande est construite côté serveur ; le client ne fournit que le nom de session et le dossier.
   */
  async create(hostId, { cols = 80, rows = 24, tmux, tmuxSession, claude } = {}) {
    if (this.sessions.size >= MAX_SESSIONS) throw new HttpError(429, 'TOO_MANY', 'Trop de terminaux ouverts');
    const host = this.hosts.get(hostId);
    let useTmux = tmux ?? host.tmux;
    let name = v.tmuxName(tmuxSession ?? host.tmuxSession);
    let command = useTmux ? tmuxCommand(name) : undefined;
    let claudeInfo = null;
    let stream;
    try {
      if (claude) {
        claudeInfo = await this.claude.prepare(hostId, claude);
        useTmux = true;
        name = claudeInfo.name;
        command = claudeInfo.command;
      }
      stream = await this.pool.openPty(hostId, { cols, rows, command });
    } catch (err) {
      this.journal.add({ type: 'terminal', event: 'open', ok: false, host, detail: err.message });
      throw err;
    }
    const s = {
      id: crypto.randomBytes(9).toString('base64url'),
      hostId,
      title: claudeInfo ? `${host.name} · Claude` : host.name,
      tmux: useTmux ? name : null,
      claude: claudeInfo ? name : null,
      createdAt: Date.now(),
      cols, rows,
      stream,
      buffer: new RingBuffer(this.config.termBufferBytes),
      clients: new Set(),
      exited: false,
      graceTimer: null,
      oscTail: '',
    };
    this.sessions.set(s.id, s);
    this.journal.add({
      type: 'terminal', event: claudeInfo ? 'claude-open' : 'open', host,
      detail: claudeInfo ? `${claudeInfo.resumed ? 'reprise' : 'nouvelle'} ${name}${claudeInfo.dangerous ? ' (sans confirmation des outils)' : ''}` : useTmux ? `tmux:${name}` : 'shell',
    });
    log.info(`Terminal ${s.id} ouvert sur ${host.name}${claudeInfo ? ` (Claude, tmux ${name})` : useTmux ? ` (tmux ${name})` : ''}`);

    const onData = (chunk) => {
      s.buffer.push(chunk);
      for (const ws of s.clients) if (ws.readyState === 1) ws.send(chunk, { binary: true });
      this.scanNotify(s, chunk);
    };
    stream.on('data', onData);
    stream.stderr?.on('data', onData);
    stream.on('close', () => {
      s.exited = true;
      const dur = Math.round((Date.now() - s.createdAt) / 1000);
      this.journal.add({ type: 'terminal', event: 'close', host, detail: `durée ${dur} s` });
      for (const ws of s.clients) {
        sendCtl(ws, { t: 'exit' });
        ws.close(4000, 'session terminée');
      }
      this.sessions.delete(s.id);
      clearTimeout(s.graceTimer);
    });
    this.armGrace(s);
    return s;
  }

  scanNotify(s, chunk) {
    if (!this.onNotify) return;
    const text = s.oscTail + chunk.toString('utf8');
    OSC_NOTIFY.lastIndex = 0;
    let m;
    let lastEnd = 0;
    while ((m = OSC_NOTIFY.exec(text))) {
      lastEnd = m.index + m[0].length;
      this.onNotify({ sessionId: s.id, hostId: s.hostId, title: m[1] || s.title, body: m[2] });
    }
    s.oscTail = text.slice(Math.max(lastEnd, text.length - 600));
  }

  armGrace(s) {
    clearTimeout(s.graceTimer);
    if (s.clients.size) return;
    s.graceTimer = setTimeout(() => {
      log.info(`Terminal ${s.id} fermé (aucun client depuis ${this.config.termGraceSec} s)`);
      this.close(s.id);
    }, this.config.termGraceSec * 1000);
    s.graceTimer.unref();
  }

  attach(s, ws, since) {
    clearTimeout(s.graceTimer);
    s.clients.add(ws);
    let replay = since === undefined ? null : s.buffer.since(since);
    const reset = replay === null;
    if (reset) replay = s.buffer.all();
    sendCtl(ws, { t: 'ready', session: this.view(s), reset, offset: s.buffer.total - replay.length });
    if (replay.length) ws.send(replay, { binary: true });
  }

  detach(s, ws) {
    s.clients.delete(ws);
    if (!s.exited) this.armGrace(s);
  }

  input(s, data) {
    if (!s.exited) s.stream.write(data);
  }

  resize(s, cols, rows) {
    if (s.exited) return;
    s.cols = cols;
    s.rows = rows;
    s.stream.setWindow(rows, cols, 0, 0);
  }

  close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    try { s.stream.close(); } catch { /* ignore */ }
    try { s.stream.end(); } catch { /* ignore */ }
    this.sessions.delete(id);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  /** Gestion d'une connexion WebSocket /ws/terminal (déjà authentifiée). */
  async handle(ws, url) {
    const params = url.searchParams;
    let s;
    try {
      if (params.get('session')) {
        s = this.get(params.get('session'));
      } else {
        const hostId = v.id(params.get('host'), 'host');
        s = await this.create(hostId, {
          cols: v.int(params.get('cols') ?? undefined, 'cols', { min: 10, max: 500, def: 80 }),
          rows: v.int(params.get('rows') ?? undefined, 'rows', { min: 4, max: 300, def: 24 }),
          tmux: params.has('tmux') ? params.get('tmux') === '1' : undefined,
          tmuxSession: params.get('tmuxSession') || undefined,
          claude: params.get('claude') === '1'
            ? { session: params.get('claudeSession') || undefined, dir: params.get('claudeDir') ?? undefined }
            : undefined,
        });
      }
    } catch (err) {
      sendCtl(ws, { t: 'error', code: err.code || 'ERROR', message: err.message, details: err.details });
      ws.close(4001, (err.code || 'error').slice(0, 60));
      return;
    }
    if (ws.readyState !== 1) {
      // Le client est parti pendant l'ouverture : la session reste disponible (délai de grâce).
      return;
    }
    const sinceRaw = params.get('since');
    const since = sinceRaw !== null && /^\d{1,15}$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
    this.attach(s, ws, since);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.input(s, raw);
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg.t === 'i' && typeof msg.d === 'string' && msg.d.length <= 65_536) this.input(s, msg.d);
      else if (msg.t === 'r') {
        const cols = Number(msg.c);
        const rows = Number(msg.r);
        if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 10 && cols <= 500 && rows >= 4 && rows <= 300) {
          this.resize(s, cols, rows);
        }
      } else if (msg.t === 'close') this.close(s.id);
      else if (msg.t === 'ping') sendCtl(ws, { t: 'pong' });
    });
    ws.on('close', () => this.detach(s, ws));
  }
}

function sendCtl(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
