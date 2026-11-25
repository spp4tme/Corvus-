// Administration d'un hôte, façon Cockpit : services systemd, journal (journalctl), pare-feu
// (ufw en lecture/écriture, nftables en lecture), utilisateurs, mises à jour de paquets.
//
// Les actions root passent par `sudo -n` (jamais de mot de passe demandé ni stocké) : il faut une
// règle sudoers LIMITÉE, que Corvus génère (`sudoersRule`) et que l'administrateur installe
// lui-même. Sans elle, Corvus affiche un message clair au lieu d'échouer en silence.
import net from 'node:net';
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { q } from './shell.js';

const UNIT_RE = /^[A-Za-z0-9@._:\\-]{1,200}$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i;
const CURSOR_RE = /^[A-Za-z0-9=;_.-]{1,512}$/;

export function unitName(x) {
  if (typeof x !== 'string' || !UNIT_RE.test(x) || x.startsWith('-')) throw v.bad('Nom de service invalide');
  return /\.(service|socket|timer|target|mount|path)$/.test(x) ? x : `${x}.service`;
}

function sudoError(out) {
  if (/a password is required|no tty present|not allowed to execute|may not run sudo|is not in the sudoers/i.test(out)) {
    return new HttpError(403, 'SUDO_REQUIRED', 'Droits sudo manquants pour cette action. Installez la règle sudoers générée par Corvus (onglet « Sudo »).');
  }
  return null;
}

export function parseUnits(text) {
  const [unitsPart, filesPart = ''] = text.split('##files');
  const enabled = new Map();
  for (const l of filesPart.split('\n')) {
    const [name, state] = l.trim().split(/\s+/);
    if (name && state) enabled.set(name, state);
  }
  const out = [];
  for (const l of unitsPart.split('\n')) {
    const m = /^\s*●?\s*(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(l);
    if (!m) continue;
    out.push({ name: m[1], load: m[2], active: m[3], sub: m[4], description: m[5].trim(), enabled: enabled.get(m[1]) || null });
  }
  // Services installés mais jamais chargés (désactivés) : visibles aussi.
  for (const [name, state] of enabled) {
    if (name.endsWith('.service') && !name.includes('@') && !out.some((u) => u.name === name)) {
      out.push({ name, load: 'not-loaded', active: 'inactive', sub: 'dead', description: '', enabled: state });
    }
  }
  return out.sort((a, b) => (a.active === 'failed' ? -1 : 0) - (b.active === 'failed' ? -1 : 0) || a.name.localeCompare(b.name));
}

export function parseJournal(text) {
  const entries = [];
  let cursor = null;
  for (const l of text.split('\n')) {
    if (!l.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    let msg = e.MESSAGE;
    if (Array.isArray(msg)) msg = Buffer.from(msg).toString('utf8');
    entries.push({
      ts: Math.floor(Number(e.__REALTIME_TIMESTAMP) / 1000) || null,
      priority: Number(e.PRIORITY ?? 6),
      unit: e._SYSTEMD_UNIT || e.UNIT || null,
      ident: e.SYSLOG_IDENTIFIER || e._COMM || null,
      pid: e._PID ? Number(e._PID) : null,
      message: String(msg ?? '').slice(0, 4000),
    });
    cursor = e.__CURSOR || cursor;
  }
  return { entries, cursor };
}

export function parseUfw(text) {
  const active = /Status:\s+active/i.test(text);
  const rules = [];
  for (const l of text.split('\n')) {
    const m = /^\[\s*(\d+)\]\s+(.*)$/.exec(l.trim());
    if (m) rules.push({ num: Number(m[1]), text: m[2].replace(/\s{2,}/g, '  ') });
  }
  return { active, rules };
}

export function parsePasswd(passwd, group) {
  const groups = new Map();
  for (const l of group.split('\n')) {
    const [name, , gid, members = ''] = l.split(':');
    if (!name) continue;
    for (const m of members.split(',').filter(Boolean)) {
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(name);
    }
    groups.set(`#${gid}`, name);
  }
  const users = [];
  for (const l of passwd.split('\n')) {
    const [name, , uid, gid, gecos, home, shell] = l.split(':');
    if (!name || uid === undefined) continue;
    const u = Number(uid);
    const human = u === 0 || (u >= 1000 && u < 60000);
    users.push({
      name, uid: u, gid: Number(gid), gecos: (gecos || '').split(',')[0], home, shell,
      human, login: !/(nologin|false)$/.test(shell || ''),
      groups: [groups.get(`#${gid}`), ...(groups.get(name) || [])].filter(Boolean),
      admin: (groups.get(name) || []).some((g) => g === 'sudo' || g === 'wheel' || g === 'admin') || u === 0,
    });
  }
  return users.sort((a, b) => (b.human - a.human) || a.uid - b.uid);
}

export function parseUpdates(manager, text) {
  const out = [];
  for (const l of text.split('\n')) {
    let m;
    if (manager === 'apt' && (m = /^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)(?:\s+\[upgradable from: ([^\]]+)\])?/.exec(l))) {
      out.push({ name: m[1], version: m[3], from: m[5] || null, source: m[2], security: /security/.test(m[2]) });
    } else if (manager === 'dnf' && (m = /^(\S+)\.(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(l)) && !/^(Last|Obsoleting|Security)/.test(l)) {
      out.push({ name: m[1], version: m[3], from: null, source: m[4], security: false });
    } else if (manager === 'pacman' && (m = /^(\S+)\s+(\S+)\s+->\s+(\S+)/.exec(l))) {
      out.push({ name: m[1], version: m[3], from: m[2], source: null, security: false });
    } else if (manager === 'apk' && (m = /^(\S+?)-(\d\S*)\s+<\s+(\S+)/.exec(l))) {
      out.push({ name: m[1], version: m[3], from: m[2], source: null, security: false });
    }
  }
  return out;
}

const DETECT = "for t in systemctl journalctl ufw nft usermod apt-get dnf pacman apk; do p=$(command -v $t 2>/dev/null) && echo \"$t=$p\"; done; echo \"user=$(id -un)\"";

export class HostAdmin {
  constructor({ pool, hosts, journal }) {
    Object.assign(this, { pool, hosts, journal });
  }

  async run(hostId, script, opts = {}) {
    // ufw, nft, usermod sont souvent dans /usr/sbin, absent du PATH d'un compte ordinaire.
    const withSbin = `PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"; export PATH\n${script}`;
    return this.pool.exec(hostId, withSbin, { timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024, ...opts });
  }

  async tools(hostId) {
    const r = await this.run(hostId, DETECT, { timeoutMs: 10_000 });
    const t = {};
    for (const l of r.stdout.toString('utf8').split('\n')) {
      const i = l.indexOf('=');
      if (i > 0) t[l.slice(0, i)] = l.slice(i + 1).trim();
    }
    return t;
  }

  /** Action root via `sudo -n` ; journalisée. */
  async sudo(hostId, argv, { event, detail, timeoutMs = 60_000 } = {}) {
    const host = this.hosts.get(hostId);
    const r = await this.run(hostId, `sudo -n ${argv.map(q).join(' ')} 2>&1`, { timeoutMs });
    const out = r.stdout.toString('utf8').trim();
    const ok = r.code === 0;
    this.journal.add({ type: 'admin', event, host, ok, detail: `${detail}${ok ? '' : ` : ${out.split('\n').slice(-2).join(' ').slice(0, 200)}`}` });
    if (!ok) throw sudoError(out) || new HttpError(400, 'ADMIN_FAILED', out.split('\n').slice(-6).join('\n').slice(0, 1500) || `échec (code ${r.code})`);
    return { ok: true, output: out.slice(-4000) };
  }

  // ---------- Services ----------
  async services(hostId) {
    const r = await this.run(hostId, 'command -v systemctl >/dev/null 2>&1 || exit 89; LC_ALL=C systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null; echo "##files"; LC_ALL=C systemctl list-unit-files --type=service --no-pager --no-legend 2>/dev/null');
    if (r.code === 89) throw new HttpError(404, 'NO_SYSTEMD', 'systemd est absent de cet hôte (services non gérés)');
    return { services: parseUnits(r.stdout.toString('utf8')) };
  }

  serviceAction(hostId, unit, action) {
    const name = unitName(unit);
    v.oneOf(action, ['start', 'stop', 'restart', 'reload', 'enable', 'disable'], 'action');
    return this.sudo(hostId, ['systemctl', action, '--', name], { event: `service-${action}`, detail: name });
  }

  // ---------- Journal ----------
  async logs(hostId, { unit, lines = 200, priority, cursor } = {}) {
    const args = ['journalctl', '--no-pager', '-o', 'json', '-n', String(lines)];
    if (unit) args.push('-u', unitName(unit));
    if (priority !== undefined) args.push('-p', String(v.int(priority, 'priorité', { min: 0, max: 7 })));
    if (cursor) {
      if (!CURSOR_RE.test(cursor)) throw v.bad('Curseur invalide');
      args.push(`--after-cursor=${cursor}`);
    }
    const r = await this.run(hostId, `command -v journalctl >/dev/null 2>&1 || exit 89; ${args.map(q).join(' ')} 2>&1`, { maxBytes: 16 * 1024 * 1024 });
    if (r.code === 89) throw new HttpError(404, 'NO_JOURNAL', 'journalctl est absent de cet hôte');
    const text = r.stdout.toString('utf8');
    const out = parseJournal(text);
    if (/insufficient permissions|not seeing messages from other users/i.test(text)) {
      out.hint = 'Journal partiel : ajoutez le compte SSH au groupe systemd-journal (sudo usermod -aG systemd-journal <utilisateur>, puis reconnexion).';
    }
    return out;
  }

  // ---------- Pare-feu ----------
  async firewall(hostId) {
    const script = [
      'if command -v ufw >/dev/null 2>&1; then echo "##ufw"; sudo -n ufw status numbered 2>&1; echo "##ufwcode $?"; fi',
      'if command -v nft >/dev/null 2>&1; then echo "##nft"; sudo -n nft list ruleset 2>&1; echo "##nftcode $?"; fi',
      'echo "##end"',
    ].join('\n');
    const text = (await this.run(hostId, script)).stdout.toString('utf8');
    const part = (name) => {
      const m = new RegExp(`##${name}\\n([\\s\\S]*?)##${name}code (\\d+)`).exec(text);
      return m ? { out: m[1].trim(), code: Number(m[2]) } : null;
    };
    const u = part('ufw');
    const n = part('nft');
    return {
      ufw: u ? { available: true, ...(u.code === 0 ? parseUfw(u.out) : { error: sudoError(u.out)?.message || u.out.slice(0, 500) }) } : { available: false },
      nft: n ? { available: true, ...(n.code === 0 ? { ruleset: n.out.slice(0, 200_000) } : { error: sudoError(n.out)?.message || n.out.slice(0, 500) }) } : { available: false },
    };
  }

  /** ufw allow / deny (port, protocole, source facultative) ou suppression d'une règle numérotée. */
  async ufw(hostId, body) {
    const host = this.hosts.get(hostId);
    const action = v.oneOf(body?.action, ['allow', 'deny', 'delete'], 'action');
    if (action === 'delete') {
      const num = v.int(body?.num, 'numéro', { min: 1, max: 10_000 });
      return this.sudo(hostId, ['ufw', '--force', 'delete', String(num)], { event: 'ufw-delete', detail: `règle ${num}` });
    }
    const port = String(body?.port ?? '');
    if (!/^\d{1,5}(:\d{1,5})?$/.test(port) || port.split(':').some((x) => Number(x) < 1 || Number(x) > 65535)) throw v.bad('Port invalide (ex. 443 ou 8000:8100)');
    const proto = v.oneOf(body?.proto ?? 'tcp', ['tcp', 'udp', 'any'], 'protocole');
    if (port.includes(':') && proto === 'any') throw v.bad('Une plage de ports exige tcp ou udp');
    // Garde-fou : ne jamais se couper soi-même l'accès SSH utilisé par Corvus.
    if (action === 'deny' && !body?.from && (port === String(host.port) || (port.includes(':') && Number(port.split(':')[0]) <= host.port && host.port <= Number(port.split(':')[1])))) {
      throw new HttpError(409, 'LOCKOUT', `Refusé : bloquer le port ${host.port} couperait l'accès SSH de Corvus à cet hôte.`);
    }
    const argv = ['ufw', action];
    if (body?.from) {
      const from = String(body.from);
      if (!net.isIP(from.split('/')[0])) throw v.bad('Adresse source invalide');
      argv.push('from', from, 'to', 'any', 'port', port);
      if (proto !== 'any') argv.push('proto', proto);
    } else {
      argv.push(proto === 'any' ? port : `${port}/${proto}`);
    }
    return this.sudo(hostId, argv, { event: `ufw-${action}`, detail: argv.slice(2).join(' ') });
  }

  // ---------- Utilisateurs ----------
  async users(hostId) {
    const r = await this.run(hostId, '(getent passwd || cat /etc/passwd) 2>/dev/null; echo "##group"; (getent group || cat /etc/group) 2>/dev/null');
    const [p, g = ''] = r.stdout.toString('utf8').split('##group');
    return { users: parsePasswd(p, g) };
  }

  async lockUser(hostId, name, lock) {
    const host = this.hosts.get(hostId);
    if (typeof name !== 'string' || !USER_RE.test(name)) throw v.bad('Nom d\'utilisateur invalide');
    if (name === host.username && lock) throw new HttpError(409, 'LOCKOUT', 'Refusé : c\'est le compte SSH utilisé par Corvus sur cet hôte.');
    return this.sudo(hostId, ['usermod', lock ? '-L' : '-U', '--', name], { event: lock ? 'user-lock' : 'user-unlock', detail: name });
  }

  // ---------- Mises à jour ----------
  async updates(hostId) {
    const t = await this.tools(hostId);
    let manager = null;
    let cmd = null;
    if (t['apt-get']) { manager = 'apt'; cmd = 'LC_ALL=C apt list --upgradable 2>/dev/null'; } else if (t.dnf) { manager = 'dnf'; cmd = 'dnf -q check-update 2>/dev/null; true'; } else if (t.pacman) { manager = 'pacman'; cmd = '(checkupdates 2>/dev/null || pacman -Qu 2>/dev/null); true'; } else if (t.apk) { manager = 'apk'; cmd = 'apk version -l "<" 2>/dev/null'; }
    if (!manager) return { manager: null, updates: [] };
    const r = await this.run(hostId, `${cmd}; [ -f /var/run/reboot-required ] && echo "##reboot"`, { timeoutMs: 120_000 });
    const text = r.stdout.toString('utf8');
    const commands = {
      apt: { refresh: ['apt-get', 'update'], upgrade: 'sudo apt-get upgrade' },
      dnf: { refresh: ['dnf', '-q', 'makecache'], upgrade: 'sudo dnf upgrade' },
      pacman: { refresh: null, upgrade: 'sudo pacman -Syu' },
      apk: { refresh: ['apk', 'update'], upgrade: 'sudo apk upgrade' },
    }[manager];
    return { manager, updates: parseUpdates(manager, text), rebootRequired: text.includes('##reboot'), canRefresh: !!commands.refresh, upgradeCommand: commands.upgrade };
  }

  async refreshUpdates(hostId) {
    const { manager } = await this.updates(hostId);
    const argv = { apt: ['apt-get', 'update'], dnf: ['dnf', '-q', 'makecache'], apk: ['apk', 'update'] }[manager];
    if (!argv) throw new HttpError(400, 'UNSUPPORTED', 'Rafraîchissement non pris en charge pour ce gestionnaire de paquets');
    return this.sudo(hostId, argv, { event: 'packages-refresh', detail: manager, timeoutMs: 300_000 });
  }

  // ---------- Règle sudoers limitée ----------
  async sudoersRule(hostId) {
    const host = this.hosts.get(hostId);
    const t = await this.tools(hostId);
    const user = t.user || host.username;
    const lines = [];
    const alias = [];
    const add = (name, cmds) => { if (cmds.length) { lines.push(`Cmnd_Alias ${name} = ${cmds.join(', \\\n    ')}`); alias.push(name); } };
    if (t.systemctl) add('CORVUS_SERVICES', ['start', 'stop', 'restart', 'reload', 'enable', 'disable'].map((a) => `${t.systemctl} ${a} -- *`));
    if (t.ufw) add('CORVUS_UFW', [`${t.ufw} status numbered`, `${t.ufw} allow *`, `${t.ufw} deny *`, `${t.ufw} --force delete *`]);
    if (t.nft) add('CORVUS_NFT', [`${t.nft} list ruleset`]);
    if (t.usermod) add('CORVUS_USERS', [`${t.usermod} -L -- *`, `${t.usermod} -U -- *`]);
    const pkg = [];
    if (t['apt-get']) pkg.push(`${t['apt-get']} update`);
    if (t.dnf) pkg.push(`${t.dnf} -q makecache`);
    if (t.apk) pkg.push(`${t.apk} update`);
    add('CORVUS_PACKAGES', pkg);
    if (!alias.length) {
      return { user, text: '', install: null, notes: ['Aucun outil d\'administration détecté sur cet hôte (systemctl, ufw, nft, usermod, gestionnaire de paquets) : aucune règle nécessaire.'] };
    }
    const text = [
      `# /etc/sudoers.d/corvus — généré par Corvus pour ${user}@${host.hostname}`,
      '# Droits root LIMITÉS aux actions de l\'onglet « Admin » de Corvus. Aucun shell, aucun éditeur,',
      '# ni journalctl/less (évasion possible vers un shell root via le pager).',
      ...lines,
      `${user} ALL=(root) NOPASSWD: ${alias.join(', ')}`,
      '',
    ].join('\n');
    return {
      user, text,
      install: `sudo install -m 0440 /dev/stdin /etc/sudoers.d/corvus <<'EOF'\n${text}EOF\nsudo visudo -cf /etc/sudoers.d/corvus`,
      notes: [
        'Journal complet sans sudo : sudo usermod -aG systemd-journal ' + user + ' (puis reconnexion).',
        'Installation des mises à jour : dans un terminal Corvus (affichage en direct, interaction possible).',
      ],
    };
  }
}
