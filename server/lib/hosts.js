// Registre des hôtes. Les secrets (mot de passe, clé, passphrase) vivent dans le coffre
// chiffré et ne sont JAMAIS renvoyés au frontend.
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import * as v from './validate.js';
import { effectiveOs } from './hostos.js';

const AUTH_TYPES = ['password', 'key', 'agent'];
export const newId = () => crypto.randomBytes(8).toString('hex');

// Colonnes de la table `hosts` ↔ objet hôte utilisé partout ailleurs.
export function rowToHost(r) {
  const extra = JSON.parse(r.extra || '{}');
  return {
    id: r.id, name: r.name, hostname: r.hostname, port: r.port, username: r.username, authType: r.auth_type,
    icon: r.icon, group: r.grp, pinned: !!r.pinned, tmux: !!r.tmux, tmuxSession: r.tmux_session,
    claudeDir: r.claude_dir, claudeCmd: r.claude_cmd, repos: JSON.parse(r.repos || '[]'),
    ...extra, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const COLUMNS = new Set(['id', 'name', 'hostname', 'port', 'username', 'authType', 'icon', 'group', 'pinned', 'tmux',
  'tmuxSession', 'claudeDir', 'claudeCmd', 'repos', 'createdAt', 'updatedAt']);
function extraOf(host) {
  const out = {};
  for (const [k, val] of Object.entries(host)) if (!COLUMNS.has(k) && val !== undefined) out[k] = val;
  return out;
}

export class HostRegistry {
  constructor({ db, vault }) {
    this.db = db;
    this.vault = vault;
  }

  /** Tous les hôtes (objets « métier », lus depuis la base). */
  get hosts() {
    return this.db.all('SELECT * FROM hosts ORDER BY created_at').map(rowToHost);
  }

  find(id) {
    const row = this.db.get('SELECT * FROM hosts WHERE id = ?', id);
    return row ? rowToHost(row) : null;
  }

  groups() {
    return this.db.all("SELECT DISTINCT grp AS name FROM hosts WHERE grp <> '' ORDER BY grp").map((r) => r.name);
  }

  list() {
    return this.hosts.map((h) => this.publicView(h));
  }

  get(id) {
    const h = this.find(id);
    if (!h) throw new v.HttpError(404, 'NOT_FOUND', 'Hôte introuvable');
    return h;
  }

  publicView(h) {
    const secret = this.vault.get(h.id) || {};
    return {
      ...h,
      osEffective: effectiveOs(h), // posix | windows | null (pas encore sondé) — l'interface s'en sert pour griser
      hasPassword: !!secret.password,
      hasKey: !!secret.privateKey,
      hasPassphrase: !!secret.passphrase,
    };
  }

  /** Valide l'entrée ; `existing` pour une mise à jour partielle. */
  parse(input, existing) {
    if (!input || typeof input !== 'object') throw v.bad('Corps JSON attendu');
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
    const base = existing ? { ...existing } : {
      id: newId(), icon: 'server', group: '', pinned: false, tmux: false, tmuxSession: 'corvus',
      claudeDir: '', claudeCmd: 'claude', repos: [], createdAt: Date.now(),
    };
    if (!existing || has('hostname')) {
      const hostname = v.hostname(input.hostname);
      if (existing && hostname !== existing.hostname) delete base.osDetected; // autre machine : on resondera
      base.hostname = hostname;
    }
    // Système de l'hôte : « auto » (détection), « posix » ou « windows » (réglage de l'administrateur).
    if (has('os')) {
      const os = v.oneOf(input.os ?? 'auto', ['auto', 'posix', 'windows'], 'système');
      if (os === 'auto') delete base.os; else base.os = os;
    }
    if (!existing || has('username')) base.username = v.username(input.username);
    if (!existing || has('port')) base.port = v.port(input.port);
    if (!existing || has('name')) {
      const name = v.str(input.name ?? '', 'alias', { max: 64 }).trim();
      base.name = name || base.hostname;
    }
    if (!existing || has('authType')) base.authType = v.oneOf(input.authType ?? 'password', AUTH_TYPES, 'méthode d\'authentification');
    if (has('icon')) base.icon = v.oneOf(input.icon, v.ICONS, 'icône');
    if (has('group')) base.group = v.str(input.group ?? '', 'groupe', { max: 48 }).trim();
    if (has('pinned')) base.pinned = v.bool(input.pinned);
    if (has('tmux')) base.tmux = v.bool(input.tmux);
    if (has('tmuxSession')) base.tmuxSession = v.tmuxName(input.tmuxSession);
    if (has('claudeDir')) base.claudeDir = v.claudeDir(input.claudeDir);
    if (has('claudeCmd')) base.claudeCmd = v.claudeCmd(input.claudeCmd);
    if (has('repos')) {
      if (!Array.isArray(input.repos) || input.repos.length > 50) throw v.bad('Liste de dépôts invalide');
      base.repos = [...new Set(input.repos.map((r) => v.remotePath(r, 'dépôt').trim()))];
    }
    if (has('tailscale')) {
      base.tailscale = input.tailscale ? { dnsName: v.str(input.tailscale.dnsName ?? '', 'dnsName', { max: 253 }), os: v.str(input.tailscale.os ?? '', 'os', { max: 32 }) } : undefined;
    }
    base.updatedAt = Date.now();
    return base;
  }

  /** Extrait et valide les secrets fournis. Retourne null si aucun changement. */
  parseSecrets(input, previous = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== '' && input[k] !== null;
    const next = { ...previous };
    let changed = false;
    if (input.clearSecrets) { changed = true; for (const k of Object.keys(next)) delete next[k]; }
    if (has('password')) { next.password = v.str(input.password, 'mot de passe', { max: 1024 }); changed = true; }
    if (has('passphrase')) { next.passphrase = v.str(input.passphrase, 'passphrase', { max: 1024 }); changed = true; }
    if (has('privateKey')) {
      const key = v.str(input.privateKey, 'clé privée', { max: 32_768 }).trim() + '\n';
      next.privateKey = key;
      changed = true;
    }
    if (next.privateKey) {
      const parsed = ssh2.utils.parseKey(next.privateKey, next.passphrase);
      if (parsed instanceof Error) {
        throw v.bad(/passphrase|encrypted/i.test(parsed.message)
          ? 'Clé privée chiffrée : passphrase manquante ou incorrecte'
          : `Clé privée invalide : ${parsed.message}`);
      }
    }
    return changed ? next : null;
  }

  /** Écrit l'hôte (insertion ou mise à jour) et ses secrets dans une seule transaction. */
  save(host, secrets) {
    this.db.tx(() => {
      if (host.group) this.db.run('INSERT OR IGNORE INTO host_groups (name, created_at) VALUES (?, ?)', host.group, Date.now());
      this.db.run(`INSERT INTO hosts (id, name, hostname, port, username, auth_type, icon, grp, pinned, tmux, tmux_session,
          claude_dir, claude_cmd, repos, extra, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, hostname = excluded.hostname, port = excluded.port,
          username = excluded.username, auth_type = excluded.auth_type, icon = excluded.icon, grp = excluded.grp,
          pinned = excluded.pinned, tmux = excluded.tmux, tmux_session = excluded.tmux_session,
          claude_dir = excluded.claude_dir, claude_cmd = excluded.claude_cmd, repos = excluded.repos,
          extra = excluded.extra, updated_at = excluded.updated_at`,
      host.id, host.name, host.hostname, host.port, host.username, host.authType, host.icon, host.group || '',
      !!host.pinned, !!host.tmux, host.tmuxSession || 'corvus', host.claudeDir || '', host.claudeCmd || 'claude',
      JSON.stringify(host.repos || []), JSON.stringify(extraOf(host)), host.createdAt || Date.now(), host.updatedAt || Date.now());
      if (secrets) this.vault.set(host.id, secrets);
    });
  }

  /** Mémorise le système détecté (posix|windows) par la sonde du pool SSH. Informatif : voir hostos.js. */
  setDetectedOs(id, os) {
    if (os !== 'posix' && os !== 'windows') return;
    const host = this.find(id);
    if (!host || host.osDetected === os) return;
    this.save({ ...host, osDetected: os }); // updatedAt inchangé : ce n'est pas une modification de l'utilisateur
  }

  create(input) {
    const host = this.parse(input);
    const secrets = this.parseSecrets(input);
    this.save(host, secrets);
    return this.publicView(host);
  }

  update(id, input) {
    const current = this.get(id);
    const next = this.parse(input, current);
    const secrets = this.parseSecrets(input, this.vault.get(id) || {});
    this.save(next, secrets);
    return this.publicView(next);
  }

  delete(id) {
    this.get(id);
    this.db.tx(() => {
      this.db.run('DELETE FROM hosts WHERE id = ?', id);
      this.vault.delete(id);
    });
  }

  /** Construit la configuration ssh2 (avec secrets) — usage interne uniquement. */
  connectConfig(hostOrId, overrideSecrets) {
    const h = typeof hostOrId === 'string' ? this.get(hostOrId) : hostOrId;
    const s = overrideSecrets || this.vault.get(h.id) || {};
    const cfg = { host: h.hostname, port: h.port, username: h.username };
    if (h.authType === 'key') {
      cfg.privateKey = s.privateKey;
      if (s.passphrase) cfg.passphrase = s.passphrase;
      if (s.password) cfg.password = s.password;
    } else if (h.authType === 'agent') {
      cfg.agent = process.env.SSH_AUTH_SOCK;
      if (!cfg.agent) cfg.agentMissing = true;
    } else {
      cfg.password = s.password;
      cfg.tryKeyboard = true;
    }
    return cfg;
  }
}
