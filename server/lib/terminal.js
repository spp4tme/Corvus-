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
// Un processus distant ne doit pas pouvoir inonder le journal et les appareils de notifications.
const NOTIFY_MIN_INTERVAL_MS = 3000;
// Contre-pression : au-delà de HIGH octets en attente côté WebSocket, on suspend la lecture SSH.
const WS_HIGH_WATER = 1024 * 1024;
const WS_LOW_WATER = 256 * 1024;
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
  constructor({ pool, hosts, journal, config, onNotify, claude, requireHost, recorder, accountOk, sessionOk }) {
    Object.assign(this, { pool, hosts, journal, config, onNotify, claude, requireHost, recorder, accountOk, sessionOk });
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  view(s) {
    return {
      id: s.id, hostId: s.hostId, title: s.title, tmux: s.tmux, claude: s.claude, createdAt: s.createdAt,
      ownerId: s.owner?.id ?? null, owner: s.owner?.username ?? null,
      shares: [...s.shares.entries()].map(([userId, x]) => ({ userId, username: x.username, mode: x.mode })),
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
  async create(hostId, { cols = 80, rows = 24, tmux, tmuxSession, claude, user = null } = {}) {
    if (this.sessions.size >= MAX_SESSIONS) throw new HttpError(429, 'TOO_MANY', 'Trop de terminaux ouverts');
    // Ouvrir un shell exige le rôle « operator » sur l'hôte.
    if (this.requireHost && user) this.requireHost(user, hostId, 'operator');
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
      this.journal.add({ type: 'terminal', event: 'open', ok: false, host, user, detail: err.message });
      throw err;
    }
    const s = {
      id: crypto.randomBytes(9).toString('base64url'),
      hostId,
      title: claudeInfo ? `${host.name} · Claude` : host.name,
      tmux: useTmux ? name : null,
      claude: claudeInfo ? name : null,
      createdAt: Date.now(),
      owner: user ? { id: user.id, username: user.username } : null,
      cols, rows,
      stream,
      buffer: new RingBuffer(this.config.termBufferBytes),
      clients: new Set(),
      exited: false,
      graceTimer: null,
      shares: new Map(), // userId → { mode: 'view' | 'control', username }
      oscTail: '',
    };
    this.sessions.set(s.id, s);
    this.recorder?.start(s, host);
    this.journal.add({
      type: 'terminal', event: claudeInfo ? 'claude-open' : 'open', host, user: s.owner,
      detail: claudeInfo ? `${claudeInfo.resumed ? 'reprise' : 'nouvelle'} ${name}${claudeInfo.dangerous ? ' (sans confirmation des outils)' : ''}` : useTmux ? `tmux:${name}` : 'shell',
    });
    log.info(`Terminal ${s.id} ouvert sur ${host.name}${claudeInfo ? ` (Claude, tmux ${name})` : useTmux ? ` (tmux ${name})` : ''}`);

    const onData = (chunk) => {
      s.buffer.push(chunk);
      this.recorder?.output(s, chunk);
      let slow = false;
      for (const ws of s.clients) {
        if (ws.readyState !== 1) continue;
        ws.send(chunk, { binary: true });
        if (ws.bufferedAmount > WS_HIGH_WATER) slow = true;
      }
      this.scanNotify(s, chunk);
      if (slow) this.pauseUntilDrained(s);
    };
    stream.on('data', onData);
    stream.stderr?.on('data', onData);
    stream.on('close', () => {
      this.recorder?.finish(s);
      s.exited = true;
      const dur = Math.round((Date.now() - s.createdAt) / 1000);
      this.journal.add({ type: 'terminal', event: 'close', host, user: s.owner, ip: null, detail: `durée ${dur} s` });
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
      const now = Date.now();
      if (now - (s.lastNotify || 0) < NOTIFY_MIN_INTERVAL_MS) continue;
      s.lastNotify = now;
      this.onNotify({ sessionId: s.id, hostId: s.hostId, owner: s.owner, title: m[1] || s.title, body: m[2] });
    }
    s.oscTail = text.slice(Math.max(lastEnd, text.length - 600));
  }

  /** Suspend la lecture du canal SSH tant qu'un client WebSocket n'a pas écoulé son retard (évite la mémoire sans limite). */
  pauseUntilDrained(s) {
    if (s.paused || s.exited) return;
    s.paused = true;
    s.stream.pause();
    const timer = setInterval(() => {
      const behind = [...s.clients].some((ws) => ws.readyState === 1 && ws.bufferedAmount > WS_LOW_WATER);
      if (behind && !s.exited) return;
      clearInterval(timer);
      s.paused = false;
      if (!s.exited) s.stream.resume();
    }, 50);
    timer.unref();
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
    this.recorder?.resize(s, cols, rows);
  }

  close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    try { s.stream.close(); } catch { /* ignore */ }
    try { s.stream.end(); } catch { /* ignore */ }
    this.sessions.delete(id);
  }

  /** Partage décidé par le propriétaire (son accord explicite), révocable à tout moment. */
  share(id, owner, guest, mode) {
    const s = this.get(id);
    if (s.owner?.id !== owner.id) throw new HttpError(403, 'FORBIDDEN', 'Seul le propriétaire peut partager ce terminal');
    if (guest.id === owner.id) throw new HttpError(400, 'BAD_REQUEST', 'Choisissez un autre compte');
    s.shares.set(guest.id, { mode, username: guest.username });
    this.journal.add({ type: 'share', event: 'invite', user: owner, host: this.hosts.find(s.hostId), detail: `${guest.username} (${mode === 'control' ? 'co-pilote' : 'spectateur'})` });
    return this.view(s);
  }

  unshare(id, owner, guestId) {
    const s = this.get(id);
    if (s.owner?.id !== owner.id) throw new HttpError(403, 'FORBIDDEN', 'Seul le propriétaire peut retirer un partage');
    const g = s.shares.get(guestId);
    s.shares.delete(guestId);
    for (const ws of s.clients) {
      if (ws.userId === guestId) { sendCtl(ws, { t: 'error', code: 'UNSHARED', message: 'Le propriétaire a arrêté le partage' }); ws.close(4001, 'UNSHARED'); }
    }
    if (g) this.journal.add({ type: 'share', event: 'revoke', user: owner, host: this.hosts.find(s.hostId), detail: g.username });
    return this.view(s);
  }

  /** Terminaux partagés avec ce compte. */
  sharedWith(userId) {
    return [...this.sessions.values()].filter((s) => s.shares.has(userId)).map((s) => ({ ...this.view(s), mode: s.shares.get(userId).mode }));
  }

  /**
   * Revérifie les droits des connexions déjà ouvertes : un compte désactivé ou supprimé, une session
   * fermée (déconnexion, jetons révoqués) ou un hôte qui n'est plus accessible ne gardent PAS un shell ouvert.
   * Une connexion refusée est coupée ; une session dont le propriétaire a perdu ses droits est fermée.
   */
  revalidate() {
    for (const s of [...this.sessions.values()]) {
      if (s.owner && this.accountOk && !this.accountOk(s.owner.id, s.hostId, 'operator')) {
        this.journal.add({ type: 'terminal', event: 'revoked', host: this.hosts.find(s.hostId), user: s.owner, detail: 'droits retirés : session fermée' });
        for (const ws of s.clients) { sendCtl(ws, { t: 'error', code: 'REVOKED', message: 'Accès retiré' }); ws.close(4001, 'REVOKED'); }
        this.close(s.id);
        continue;
      }
      for (const ws of [...s.clients]) {
        const guest = s.owner && ws.userId !== undefined && ws.userId !== s.owner.id;
        const stillGuest = !guest || s.shares.has(ws.userId);
        const accountFine = ws.userId === undefined || !this.accountOk || this.accountOk(ws.userId, s.hostId, guest ? 'none' : 'operator');
        const sessionFine = !ws.sessionKey || !this.sessionOk || this.sessionOk(ws.sessionKey);
        if (!stillGuest || !accountFine || !sessionFine) { sendCtl(ws, { t: 'error', code: 'REVOKED', message: 'Accès retiré' }); ws.close(4001, 'REVOKED'); }
      }
    }
  }

  closeAll() {
    // Arrêt du serveur : les enregistrements sont sauvegardés avant la fermeture de la base.
    for (const s of this.sessions.values()) this.recorder?.finish(s);
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  /** Gestion d'une connexion WebSocket /ws/terminal (déjà authentifiée). */
  async handle(ws, url, req = {}) {
    const params = url.searchParams;
    const user = req.user || null;
    let s;
    try {
      if (params.get('session')) {
        s = this.get(params.get('session'));
        // Se rattacher à un terminal : réservé à son propriétaire (le partage passe par une invitation).
        if (user && s.owner && s.owner.id !== user.id) {
          // Invité : seulement sur invitation du propriétaire (« regarder » ou « co-piloter »).
          const share = s.shares.get(user.id);
          if (!share) throw new HttpError(403, 'FORBIDDEN', 'Ce terminal appartient à un autre compte');
          ws.guest = share.mode;
        }
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
          user,
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
    ws.userId = user?.id;
    ws.sessionKey = req.sessionKey;
    this.attach(s, ws, since);
    if (ws.guest) {
      this.journal.add({ type: 'share', event: 'join', user, host: this.hosts.find(s.hostId), detail: `${ws.guest === 'control' ? 'co-pilote' : 'spectateur'} du terminal de ${s.owner?.username}` });
      for (const c of s.clients) if (c !== ws) sendCtl(c, { t: 'guest', user: user.username, mode: ws.guest, joined: true });
    }
    const canType = ws.guest !== 'view';

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (canType) this.input(s, raw);
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg.t === 'i' && typeof msg.d === 'string' && msg.d.length <= 65_536) { if (canType) this.input(s, msg.d); }
      else if (msg.t === 'r' && !ws.guest) {
        const cols = Number(msg.c);
        const rows = Number(msg.r);
        if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 10 && cols <= 500 && rows >= 4 && rows <= 300) {
          this.resize(s, cols, rows);
        }
      } else if (msg.t === 'close' && !ws.guest) this.close(s.id);
      else if (msg.t === 'ping') sendCtl(ws, { t: 'pong' });
    });
    ws.on('close', () => this.detach(s, ws));
  }
}

function sendCtl(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
