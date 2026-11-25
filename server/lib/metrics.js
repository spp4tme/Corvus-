// Collecte de fond des métriques (toutes les 30 s par défaut) et lecture de l'historique.
// Sans agent : relevé par SSH (/proc). L'agent (étape 1) pourra écrire dans la même table.
import { logger } from './log.js';

const log = logger('metrics');
const H = 3600_000;
const D = 24 * H;

// Plages proposées dans l'interface : durée, table source, largeur d'un point.
export const RANGES = {
  '1h': { span: H, table: 'raw', bucket: 30_000 },
  '24h': { span: D, table: 'raw', bucket: 5 * 60_000 },
  '7d': { span: 7 * D, table: 'raw', bucket: H },
  '1y': { span: 365 * D, table: 'hourly', bucket: D },
};

/** Transforme un relevé en lignes { metric, value } (valeurs nulles ignorées). */
export function flatten(s) {
  const out = [];
  const add = (metric, value) => { if (value !== null && value !== undefined && Number.isFinite(value)) out.push({ metric, value }); };
  add('cpu', s.cpu);
  (s.cpuCores || []).forEach((v, i) => add(`cpu.${i}`, v));
  add('mem', s.mem?.percent);
  add('swap', s.swap?.percent);
  add('load1', s.load?.[0]);
  add('temp', s.temp);
  add('net.rx', s.net?.rxRate);
  add('net.tx', s.net?.txRate);
  add('disk.read', s.disk?.readBps);
  add('disk.write', s.disk?.writeBps);
  add('disk.riops', s.disk?.readIops);
  add('disk.wiops', s.disk?.writeIops);
  add('tcp.estab', s.tcp?.established);
  add('tcp.retrans', s.tcp?.retransPerSec);
  for (const d of s.disks || []) add(`df:${d.mount}`, d.percent);
  return out;
}

export class MetricsCollector {
  constructor({ db, hosts, monitor, hostStatus, intervalSec = 30 }) {
    Object.assign(this, { db, hosts, monitor, hostStatus, intervalSec });
    this.running = false;
  }

  store(hostId, stats) {
    const rows = flatten(stats);
    this.db.tx(() => {
      for (const r of rows) {
        this.db.run('INSERT OR REPLACE INTO metrics_raw (host_id, metric, ts, value) VALUES (?, ?, ?, ?)', hostId, r.metric, stats.ts, r.value);
      }
    });
    return rows.length;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const h of this.hosts.hosts) {
        // Un hôte injoignable n'est pas interrogé : aucune attente inutile, aucune file bloquée.
        if (this.hostStatus?.get(h.id)?.state === 'down') continue;
        try {
          const st = await this.monitor.stats(h.id, { key: 'collector', maxAgeMs: this.intervalSec * 3000 });
          this.store(h.id, st);
        } catch (err) {
          log.debug(`Collecte impossible pour ${h.name} : ${err.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Historique : [{ t, values: { metric: moyenne } }] regroupé par intervalle, plus min / max.
   * @param {string[]} metrics
   */
  history(hostId, metrics, range = '1h', now = Date.now()) {
    const r = RANGES[range] || RANGES['1h'];
    const from = now - r.span;
    const ph = metrics.map(() => '?').join(',');
    const rows = r.table === 'raw'
      ? this.db.all(`SELECT metric, (ts / ${r.bucket}) * ${r.bucket} AS t, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max
          FROM metrics_raw WHERE host_id = ? AND ts >= ? AND metric IN (${ph}) GROUP BY metric, t ORDER BY t`, hostId, from, ...metrics)
      : this.db.all(`SELECT metric, (hour / ${r.bucket}) * ${r.bucket} AS t, SUM(avg * n) / SUM(n) AS avg, MIN(min) AS min, MAX(max) AS max
          FROM metrics_hourly WHERE host_id = ? AND hour >= ? AND metric IN (${ph}) GROUP BY metric, t ORDER BY t`, hostId, from, ...metrics);
    const byT = new Map();
    for (const row of rows) {
      if (!byT.has(row.t)) byT.set(row.t, { t: row.t, values: {}, min: {}, max: {} });
      const p = byT.get(row.t);
      p.values[row.metric] = row.avg;
      p.min[row.metric] = row.min;
      p.max[row.metric] = row.max;
    }
    return { range, bucketMs: r.bucket, from, to: now, points: [...byT.values()].sort((a, b) => a.t - b.t) };
  }

  /** Métriques disponibles pour un hôte (ex. cœurs, points de montage). */
  available(hostId) {
    return this.db.all('SELECT DISTINCT metric FROM metrics_raw WHERE host_id = ? AND ts > ?', hostId, Date.now() - D).map((r) => r.metric);
  }

  start() {
    this.first = setTimeout(() => this.tick(), 10_000);
    this.first.unref();
    this.timer = setInterval(() => this.tick(), this.intervalSec * 1000);
    this.timer.unref();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }
}
