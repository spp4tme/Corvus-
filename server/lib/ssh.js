// Pool de connexions SSH : une connexion multiplexée par hôte (terminaux, SFTP, exec),
// vérification TOFU des host keys, keepalive, fermeture après inactivité.
import ssh2 from 'ssh2';
import { HttpError } from './validate.js';
import { shWrap } from './shell.js';
import { logger } from './log.js';

const { Client } = ssh2;
const log = logger('ssh');

function mapError(err, ctx) {
  if (err instanceof HttpError) return err;
  if (ctx.mismatch) {
    return new HttpError(409, 'HOSTKEY_MISMATCH',
      'L\'empreinte de la clé d\'hôte a CHANGÉ. Possible attaque de l\'homme du milieu, ou machine réinstallée.',
      ctx.mismatch);
  }
  const msg = err?.message || String(err);
  if (err?.level === 'client-authentication' || /authentication/i.test(msg)) {
    return new HttpError(401, 'SSH_AUTH', 'Authentification SSH refusée (identifiants incorrects ?)');
  }
  if (err?.level === 'client-timeout' || /timed out/i.test(msg)) {
    return new HttpError(504, 'SSH_TIMEOUT', 'Délai de connexion SSH dépassé — hôte injoignable ?');
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN'].includes(err?.code)) {
    const labels = {
      ECONNREFUSED: 'connexion refusée (sshd arrêté ou mauvais port)',
      ENOTFOUND: 'nom d\'hôte introuvable (MagicDNS activé ?)',
      EAI_AGAIN: 'résolution DNS impossible',
      EHOSTUNREACH: 'hôte injoignable',
      ENETUNREACH: 'réseau injoignable',
      ECONNRESET: 'connexion réinitialisée',
    };
    return new HttpError(502, 'SSH_UNREACHABLE', `SSH : ${labels[err.code]}`);
  }
  return new HttpError(502, 'SSH_ERROR', `Erreur SSH : ${msg}`);
}

/**
 * Ouvre une connexion SSH avec vérification TOFU.
 * @returns {Promise<{client: import('ssh2').Client, hostKey: object}>}
 */
export function connect(cfg, { knownHosts, readyTimeout }) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const ctx = { mismatch: null, hostKey: null };
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(mapError(err, ctx));
    };
    if (!cfg.password && !cfg.privateKey && !cfg.agent) {
      return reject(new HttpError(400, 'SSH_NO_SECRET', 'Aucun mot de passe ni clé enregistré pour cet hôte'));
    }
    client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => cfg.password || ''));
    });
    client.once('ready', () => {
      if (settled) return;
      settled = true;
      if (ctx.hostKey.status === 'new') {
        knownHosts.remember(cfg.host, cfg.port, ctx.hostKey.fingerprint, ctx.hostKey.type);
        log.info(`Nouvelle host key mémorisée pour ${cfg.host}:${cfg.port} (${ctx.hostKey.type} ${ctx.hostKey.fingerprint})`);
      }
      resolve({ client, hostKey: ctx.hostKey });
    });
    // Écouteur permanent : une erreur après « ready » ne doit jamais faire planter le processus.
    client.on('error', fail);
    client.once('close', () => fail(new Error('Connexion fermée pendant la négociation')));
    try {
      client.connect({
        ...cfg,
        readyTimeout,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
        hostVerifier: (key) => {
          const r = knownHosts.check(cfg.host, cfg.port, key);
          ctx.hostKey = r;
          if (r.status === 'mismatch') {
            ctx.mismatch = { host: `${cfg.host}:${cfg.port}`, expected: r.expected, received: r.fingerprint, type: r.type };
            log.warn(`HOST KEY CHANGÉE pour ${cfg.host}:${cfg.port} — attendu ${r.expected}, reçu ${r.fingerprint}`);
            return false;
          }
          return true;
        },
      });
    } catch (err) {
      fail(err);
    }
  });
}

function runExec(client, command, { timeoutMs = 30_000, maxBytes = 8 * 1024 * 1024, stdin, pty } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, pty ? { pty } : {}, (err, stream) => {
      if (err) return reject(err);
      const out = [];
      const errOut = [];
      let size = 0;
      let truncated = false;
      let code = null;
      let signal = null;
      const timer = setTimeout(() => {
        truncated = true;
        try { stream.signal('KILL'); } catch { /* ignore */ }
        stream.close();
        reject(new HttpError(504, 'EXEC_TIMEOUT', `Commande distante trop longue (> ${Math.round(timeoutMs / 1000)} s)`));
      }, timeoutMs);
      const push = (arr) => (chunk) => {
        if (size + chunk.length > maxBytes) {
          if (!truncated) arr.push(chunk.subarray(0, Math.max(0, maxBytes - size)));
          truncated = true;
          size = maxBytes;
          return;
        }
        size += chunk.length;
        arr.push(chunk);
      };
      stream.on('data', push(out));
      stream.stderr.on('data', push(errOut));
      stream.on('exit', (c, s) => { code = c; signal = s; });
      stream.on('close', (c) => {
        clearTimeout(timer);
        resolve({
          code: code ?? c ?? null,
          signal,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(errOut).toString('utf8'),
          truncated,
        });
      });
      if (stdin !== undefined) stream.end(stdin);
      else stream.end();
    });
  });
}

export class SshPool {
  constructor({ hosts, knownHosts, config }) {
    this.hosts = hosts;
    this.knownHosts = knownHosts;
    this.config = config;
    this.conns = new Map();
    this.pending = new Map();
    this.reaper = setInterval(() => this.reap(), 60_000);
    this.reaper.unref();
  }

  async get(hostId) {
    const existing = this.conns.get(hostId);
    if (existing && !existing.closed) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (this.pending.has(hostId)) return this.pending.get(hostId);
    const p = (async () => {
      const cfg = this.hosts.connectConfig(hostId);
      const { client, hostKey } = await connect(cfg, {
        knownHosts: this.knownHosts,
        readyTimeout: this.config.sshReadyTimeoutMs,
      });
      const conn = { hostId, client, hostKey, lastUsed: Date.now(), channels: 0, closed: false, sftpP: null };
      client.on('close', () => {
        conn.closed = true;
        if (this.conns.get(hostId) === conn) this.conns.delete(hostId);
        log.debug(`Connexion fermée : ${cfg.host}`);
      });
      client.on('error', (err) => log.warn(`Erreur de connexion ${cfg.host}`, err));
      this.conns.set(hostId, conn);
      log.info(`Connecté à ${cfg.username}@${cfg.host}:${cfg.port}`);
      return conn;
    })();
    this.pending.set(hostId, p);
    try {
      return await p;
    } finally {
      this.pending.delete(hostId);
    }
  }

  /** Exécute un script POSIX (encapsulé dans sh -c) ; réessaie une fois si la connexion était morte. */
  async exec(hostId, script, opts = {}) {
    const command = opts.raw ? script : shWrap(script);
    for (let attempt = 0; ; attempt++) {
      const conn = await this.get(hostId);
      conn.channels++;
      try {
        return await runExec(conn.client, command, opts);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (attempt === 0 && /not connected|channel open failure|no response|closed/i.test(err.message)) {
          this.drop(hostId);
          continue;
        }
        throw mapError(err, {});
      } finally {
        conn.channels--;
        conn.lastUsed = Date.now();
      }
    }
  }

  /** Session SFTP partagée par hôte. */
  async sftp(hostId) {
    const conn = await this.get(hostId);
    conn.lastUsed = Date.now();
    if (!conn.sftpP) {
      conn.sftpP = new Promise((resolve, reject) => {
        conn.client.sftp((err, sftp) => {
          if (err) {
            conn.sftpP = null;
            return reject(new HttpError(502, 'SFTP_UNAVAILABLE', `SFTP indisponible : ${err.message}`));
          }
          sftp.on('close', () => { conn.sftpP = null; });
          resolve(sftp);
        });
      });
    }
    return conn.sftpP;
  }

  /** Ouvre un canal interactif avec PTY (shell, ou commande si fournie). */
  async openPty(hostId, { cols, rows, command }) {
    const conn = await this.get(hostId);
    const pty = { term: 'xterm-256color', cols, rows };
    const stream = await new Promise((resolve, reject) => {
      const cb = (err, s) => (err ? reject(mapError(err, {})) : resolve(s));
      if (command) conn.client.exec(command, { pty }, cb);
      else conn.client.shell(pty, cb);
    });
    conn.channels++;
    stream.on('close', () => {
      conn.channels--;
      conn.lastUsed = Date.now();
    });
    return stream;
  }

  /** Test de connexion indépendant du pool (configuration éventuellement non enregistrée). */
  async test(cfg) {
    const started = Date.now();
    const { client, hostKey } = await connect(cfg, {
      knownHosts: this.knownHosts,
      readyTimeout: this.config.sshReadyTimeoutMs,
    });
    const latencyMs = Date.now() - started;
    try {
      const r = await runExec(client, shWrap('echo __corvus_ok__; uname -srm 2>/dev/null || true; command -v tmux >/dev/null 2>&1 && echo __tmux__ || true'), { timeoutMs: 10_000 });
      const out = r.stdout.toString('utf8');
      return {
        ok: out.includes('__corvus_ok__'),
        latencyMs,
        uname: out.split('\n').find((l) => l && !l.startsWith('__'))?.trim() || null,
        tmux: out.includes('__tmux__'),
        hostKey: { fingerprint: hostKey.fingerprint, type: hostKey.type, firstSeen: hostKey.status === 'new' },
      };
    } finally {
      client.end();
    }
  }

  drop(hostId) {
    const conn = this.conns.get(hostId);
    if (conn) {
      this.conns.delete(hostId);
      conn.client.end();
    }
  }

  reap() {
    const now = Date.now();
    for (const [id, conn] of this.conns) {
      if (conn.channels <= 0 && now - conn.lastUsed > this.config.sshIdleMs) {
        log.debug(`Fermeture pour inactivité : ${id}`);
        this.drop(id);
      }
    }
  }

  status(hostId) {
    const c = this.conns.get(hostId);
    return c && !c.closed ? { connected: true, channels: c.channels } : { connected: false };
  }

  closeAll() {
    clearInterval(this.reaper);
    for (const id of [...this.conns.keys()]) this.drop(id);
  }
}
