// Supervision via SSH : /proc (Linux), ps, kill, Docker. Les deltas (CPU, réseau) sont
// calculés entre deux relevés successifs, mémorisés par hôte.
import { HttpError } from './validate.js';
import { q } from './shell.js';

const STATS_SCRIPT = (doubleSample) => [
  'export LC_ALL=C',
  "echo '##stat'; head -n 1 /proc/stat 2>/dev/null",
  doubleSample ? "sleep 0.5; echo '##stat2'; head -n 1 /proc/stat 2>/dev/null" : '',
  "echo '##meminfo'; cat /proc/meminfo 2>/dev/null",
  "echo '##loadavg'; cat /proc/loadavg 2>/dev/null",
  "echo '##uptime'; cat /proc/uptime 2>/dev/null",
  "echo '##netdev'; cat /proc/net/dev 2>/dev/null",
  "echo '##df'; df -kP 2>/dev/null",
  "echo '##uname'; uname -snrm 2>/dev/null",
  "echo '##nproc'; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null",
  "echo '##temp'; cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null",
  "echo '##end'",
].filter(Boolean).join('\n');

const PSEUDO_FS = /^(tmpfs|devtmpfs|udev|overlay|squashfs|none|efivarfs|shm|cgroup2?|proc|sysfs|run|devfs|map |nsfs)/;
const PSEUDO_MOUNT = /^\/(snap|run|dev|sys|proc)(\/|$)|^\/var\/lib\/docker\//;

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^##(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

function parseCpu(line) {
  if (!line || !line.startsWith('cpu')) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number).filter((x) => Number.isFinite(x));
  if (n.length < 4) return null;
  const idle = n[3] + (n[4] || 0);
  const total = n.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function cpuPercent(a, b) {
  if (!a || !b) return null;
  const dt = b.total - a.total;
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, (100 * (dt - (b.idle - a.idle))) / dt));
}

function parseMem(lines) {
  const kv = {};
  for (const l of lines) {
    const m = /^(\w+):\s+(\d+)/.exec(l);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  if (!kv.MemTotal) return { mem: null, swap: null };
  const available = kv.MemAvailable ?? ((kv.MemFree || 0) + (kv.Buffers || 0) + (kv.Cached || 0));
  const used = kv.MemTotal - available;
  const swap = kv.SwapTotal ? { total: kv.SwapTotal, used: kv.SwapTotal - (kv.SwapFree || 0), percent: (100 * (kv.SwapTotal - (kv.SwapFree || 0))) / kv.SwapTotal } : null;
  return { mem: { total: kv.MemTotal, used, available, percent: (100 * used) / kv.MemTotal }, swap };
}

function parseNet(lines) {
  const ifaces = [];
  for (const l of lines) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(l);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 9 || m[1] === 'lo') continue;
    ifaces.push({ name: m[1], rx: f[0], tx: f[8] });
  }
  return ifaces;
}

function parseDf(lines) {
  const seen = new Set();
  const disks = [];
  for (const l of lines.slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [fs, size, used, avail] = f;
    const mount = f.slice(5).join(' ');
    if (PSEUDO_FS.test(fs) || PSEUDO_MOUNT.test(mount) || seen.has(fs)) continue;
    const s = Number(size) * 1024;
    if (!s) continue;
    seen.add(fs);
    disks.push({ fs, mount, size: s, used: Number(used) * 1024, avail: Number(avail) * 1024, percent: (100 * Number(used)) / Number(size) });
  }
  return disks.slice(0, 20);
}

/** Analyse la sortie de `ps -eo pid=,user=,pcpu=,pmem=,rss=,comm=,args=` ou, à défaut, de `ps -ef`. */
export function parsePs(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const procs = [];
  if (/^\s*(UID|PID|USER)\b/.test(lines[0])) {
    // Format avec en-tête (ps -ef, busybox) : on repère les colonnes PID et commande.
    const head = lines[0].trim().split(/\s+/);
    const pidCol = head.indexOf('PID');
    const userCol = Math.max(head.indexOf('UID'), head.indexOf('USER'));
    const cmdCol = head.findIndex((c) => /^(CMD|COMMAND)$/.test(c));
    for (const l of lines.slice(1)) {
      const f = l.trim().split(/\s+/);
      const pid = Number(f[pidCol]);
      if (!Number.isInteger(pid)) continue;
      const args = f.slice(cmdCol >= 0 ? cmdCol : f.length - 1).join(' ');
      procs.push({ pid, user: userCol >= 0 ? f[userCol] : '', cpu: null, mem: null, rss: null, command: args.split('/').pop().split(' ')[0], args });
    }
    return procs;
  }
  for (const l of lines) {
    const m = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), user: m[2], cpu: Number(m[3]), mem: Number(m[4]), rss: Number(m[5]) * 1024, command: m[6], args: m[7] || m[6] });
  }
  return procs;
}

export class MonitorService {
  constructor({ pool, hosts, journal }) {
    Object.assign(this, { pool, hosts, journal });
    this.prev = new Map();
  }

  async stats(hostId) {
    const prev = this.prev.get(hostId);
    const fresh = !prev || Date.now() - prev.ts > 30_000;
    const r = await this.pool.exec(hostId, STATS_SCRIPT(fresh), { timeoutMs: 15_000 });
    const s = sections(r.stdout.toString('utf8'));
    if (!s.end) throw new HttpError(502, 'STATS_ERROR', 'Relevé incomplet (shell distant inhabituel ?)');
    const ts = Date.now();
    const cpuNow = parseCpu(s.stat2?.[0] ?? s.stat?.[0]);
    const cpu = fresh ? cpuPercent(parseCpu(s.stat?.[0]), cpuNow) : cpuPercent(prev.cpu, cpuNow);
    const net = parseNet(s.netdev || []);
    const dt = prev ? (ts - prev.ts) / 1000 : 0;
    const prevNet = new Map((prev?.net || []).map((i) => [i.name, i]));
    let rxRate = null;
    let txRate = null;
    if (prev && dt > 0 && net.length) {
      rxRate = 0;
      txRate = 0;
      for (const i of net) {
        const p = prevNet.get(i.name);
        if (!p) continue;
        i.rxRate = Math.max(0, (i.rx - p.rx) / dt);
        i.txRate = Math.max(0, (i.tx - p.tx) / dt);
        rxRate += i.rxRate;
        txRate += i.txRate;
      }
    }
    this.prev.set(hostId, { ts, cpu: cpuNow, net });
    // uname -snrm → « système nom-d'hôte version machine »
    const [sysname, hostname, release, arch] = (s.uname?.[0] || '').trim().split(/\s+/);
    const kernel = sysname ? [sysname, release].filter(Boolean).join(' ') : null;
    const loadParts = (s.loadavg?.[0] || '').trim().split(/\s+/).slice(0, 3).map(Number);
    const tempRaw = Number((s.temp?.[0] || '').trim());
    const { mem, swap } = parseMem(s.meminfo || []);
    return {
      ts,
      hostname: hostname || null,
      kernel,
      arch: arch || null,
      cores: Number((s.nproc?.[0] || '').trim()) || null,
      cpu,
      load: loadParts.every((x) => Number.isFinite(x)) && loadParts.length === 3 ? loadParts : null,
      uptime: Number((s.uptime?.[0] || '').split(' ')[0]) || null,
      mem, swap,
      disks: parseDf(s.df || []),
      net: { ifaces: net, rxRate, txRate },
      temp: Number.isFinite(tempRaw) && tempRaw > 0 ? tempRaw / 1000 : null,
    };
  }

  async processes(hostId) {
    const r = await this.pool.exec(hostId,
      'ps -eo pid=,user=,pcpu=,pmem=,rss=,comm=,args= 2>/dev/null || ps -ef 2>/dev/null || ps',
      { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });
    const procs = parsePs(r.stdout.toString('utf8'));
    procs.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || (b.mem ?? 0) - (a.mem ?? 0) || a.pid - b.pid);
    return { total: procs.length, processes: procs.slice(0, 150).map((p) => ({ ...p, args: p.args.slice(0, 300) })) };
  }

  async kill(hostId, pid, signal) {
    const r = await this.pool.exec(hostId, `kill -s ${signal} ${pid} 2>&1`, { timeoutMs: 10_000 });
    const host = this.hosts.get(hostId);
    if (r.code !== 0) {
      const msg = r.stdout.toString('utf8').trim() || `kill a échoué (code ${r.code})`;
      this.journal.add({ type: 'monitor', event: 'kill', host, ok: false, detail: `${signal} ${pid} : ${msg}` });
      throw new HttpError(400, /not permitted|permission/i.test(msg) ? 'PERMISSION_DENIED' : 'KILL_FAILED',
        /not permitted|permission/i.test(msg) ? `Permission refusée pour le PID ${pid} (processus d'un autre utilisateur ?)` : msg);
    }
    this.journal.add({ type: 'monitor', event: 'kill', host, detail: `${signal} ${pid}` });
    return { ok: true };
  }

  // ---------- Docker ----------
  async docker(hostId, cmd, opts = {}) {
    const r = await this.pool.exec(hostId, `command -v docker >/dev/null 2>&1 || exit 89; ${cmd}`, { timeoutMs: 30_000, ...opts });
    const out = r.stdout.toString('utf8');
    if (r.code === 89) throw new HttpError(404, 'DOCKER_MISSING', 'Docker n\'est pas installé sur cet hôte');
    if (r.code !== 0) {
      const msg = (r.stderr || out).trim();
      if (/permission denied.*docker\.sock/i.test(msg)) {
        throw new HttpError(403, 'DOCKER_PERMISSION', 'Accès au socket Docker refusé : ajoutez l\'utilisateur au groupe docker (sudo usermod -aG docker $USER, puis reconnexion).');
      }
      if (/Cannot connect to the Docker daemon/i.test(msg)) throw new HttpError(502, 'DOCKER_DOWN', 'Le démon Docker ne répond pas');
      throw new HttpError(400, 'DOCKER_ERROR', msg.split('\n').slice(-6).join('\n').slice(0, 1500) || `docker a échoué (code ${r.code})`);
    }
    return out;
  }

  async containers(hostId) {
    const out = await this.docker(hostId, "docker ps -a --no-trunc --format '{{json .}}'");
    const list = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        list.push({
          id: String(c.ID || '').slice(0, 12), name: String(c.Names || '').split(',')[0], image: c.Image, state: c.State,
          status: c.Status, ports: c.Ports || '', created: c.CreatedAt || c.RunningFor || '',
        });
      } catch { /* ligne non JSON ignorée */ }
    }
    list.sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || a.name.localeCompare(b.name));
    return { containers: list };
  }

  async containerAction(hostId, name, action) {
    const host = this.hosts.get(hostId);
    try {
      await this.docker(hostId, `docker ${action} ${q(name)}`, { timeoutMs: 60_000 });
    } catch (err) {
      this.journal.add({ type: 'docker', event: action, host, ok: false, detail: `${name} : ${err.message}` });
      throw err;
    }
    this.journal.add({ type: 'docker', event: action, host, detail: name });
    return { ok: true };
  }

  async containerLogs(hostId, name, tail) {
    const out = await this.docker(hostId, `docker logs --tail ${tail} --timestamps ${q(name)} 2>&1`, { maxBytes: 2 * 1024 * 1024 });
    return { name, logs: out };
  }
}
