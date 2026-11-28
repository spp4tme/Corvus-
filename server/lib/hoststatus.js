// État des hôtes en arrière-plan : « en ligne (23 ms) » ou « injoignable depuis 12 min ».
//
// Sonde légère : une connexion TCP sur le port SSH (pas d'authentification, donc ni journal
// rempli ni fail2ban déclenché côté serveur). Une connexion SSH déjà ouverte suffit à dire « en
// ligne ». Les hôtes injoignables sont re-testés de plus en plus rarement (1 → 15 min), et une
// alerte est levée s'ils le restent plus de `downAlertMin` minutes.
import net from 'node:net';
import { logger } from './log.js';

const log = logger('status');
const MAX_PARALLEL = 4;

export function tcpProbe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    const done = (ok, error) => {
      sock.destroy();
      resolve({ ok, latencyMs: ok ? Date.now() - started : null, error: error || null });
    };
    sock.setTimeout(timeoutMs, () => done(false, 'délai dépassé'));
    sock.once('connect', () => done(true));
    sock.once('error', (err) => done(false, err.code || err.message));
  });
}

export class HostStatus {
  constructor({ db, hosts, pool, alerts, intervalSec = 60, downAlertMin = 5, probe = tcpProbe }) {
    Object.assign(this, { db, hosts, pool, alerts, intervalSec, downAlertMin, probe });
    this.failures = new Map();
    this.nextAt = new Map();
    this.running = false;
  }

  get(hostId) {
    const r = this.db.get('SELECT * FROM host_status WHERE host_id = ?', hostId);
    return r ? { state: r.state, since: r.since, checkedAt: r.checked_at, latencyMs: r.latency_ms, error: r.error } : null;
  }

  record(hostId, result) {
    const now = Date.now();
    const state = result.ok ? 'up' : 'down';
    const prev = this.get(hostId);
    const since = prev && prev.state === state ? prev.since : now;
    this.db.run(`INSERT INTO host_status (host_id, state, since, checked_at, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET state = excluded.state, since = excluded.since, checked_at = excluded.checked_at,
        latency_ms = excluded.latency_ms, error = excluded.error`, hostId, state, since, now, result.latencyMs, result.error);
    if (prev && prev.state !== state) log.info(`${hostId} : ${prev.state} → ${state}`);
    if (state === 'down' && now - since >= this.downAlertMin * 60_000) {
      const host = this.hosts.find(hostId);
      this.alerts?.raise({
        kind: 'host-down', severity: 'warn', hostId,
        message: `${host?.name || hostId} est injoignable depuis ${Math.round((now - since) / 60_000)} min (${result.error || 'pas de réponse'})`,
      });
    }
    return this.get(hostId);
  }

  async check(host) {
    // Hôte « agent seul » : pas d'adresse SSH à sonder (et jamais « injoignable » : sa présence, c'est l'agent qui la dit).
    if (host.authType === 'none') { this.nextAt.set(host.id, Date.now() + this.intervalSec * 1000); return null; }
    let result;
    if (this.pool.status(host.id).connected) result = { ok: true, latencyMs: null, error: null };
    else result = await this.probe(host.hostname, host.port);
    const fails = result.ok ? 0 : (this.failures.get(host.id) || 0) + 1;
    this.failures.set(host.id, fails);
    // Re-test espacé pour un hôte injoignable : 1, 2, 4, 8, 15 min.
    const delay = fails ? Math.min(60_000 * 2 ** (fails - 1), 15 * 60_000) : this.intervalSec * 1000;
    this.nextAt.set(host.id, Date.now() + delay);
    return this.record(host.id, result);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const due = this.hosts.hosts.filter((h) => (this.nextAt.get(h.id) || 0) <= now);
      for (let i = 0; i < due.length; i += MAX_PARALLEL) {
        await Promise.all(due.slice(i, i + MAX_PARALLEL).map((h) => this.check(h).catch(() => {})));
      }
    } finally {
      this.running = false;
    }
  }

  start() {
    this.first = setTimeout(() => this.tick(), 2000);
    this.first.unref();
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }
}
