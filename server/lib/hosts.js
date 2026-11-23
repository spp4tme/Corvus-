// Registre des hôtes. Les secrets (mot de passe, clé, passphrase) vivent dans le coffre
// chiffré et ne sont JAMAIS renvoyés au frontend.
import crypto from 'node:crypto';
import path from 'node:path';
import ssh2 from 'ssh2';
import { JsonStore } from './store.js';
import * as v from './validate.js';

const AUTH_TYPES = ['password', 'key', 'agent'];
export const newId = () => crypto.randomBytes(8).toString('hex');

export class HostRegistry {
  constructor({ dataDir, vault }) {
    this.vault = vault;
    this.store = new JsonStore(path.join(dataDir, 'hosts.json'), { hosts: [] });
  }

  get hosts() {
    return this.store.data.hosts;
  }

  list() {
    return this.hosts.map((h) => this.publicView(h));
  }

  get(id) {
    const h = this.hosts.find((x) => x.id === id);
    if (!h) throw new v.HttpError(404, 'NOT_FOUND', 'Hôte introuvable');
    return h;
  }

  publicView(h) {
    const secret = this.vault.get(h.id) || {};
    return {
      ...h,
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
      repos: [], createdAt: Date.now(),
    };
    if (!existing || has('hostname')) base.hostname = v.hostname(input.hostname);
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

  create(input) {
    const host = this.parse(input);
    const secrets = this.parseSecrets(input);
    this.hosts.push(host);
    this.store.save();
    if (secrets) this.vault.set(host.id, secrets);
    return this.publicView(host);
  }

  update(id, input) {
    const current = this.get(id);
    const next = this.parse(input, current);
    const secrets = this.parseSecrets(input, this.vault.get(id) || {});
    Object.assign(current, next);
    this.store.save();
    if (secrets) this.vault.set(id, secrets);
    return this.publicView(current);
  }

  delete(id) {
    this.get(id);
    this.store.data.hosts = this.hosts.filter((h) => h.id !== id);
    this.store.save();
    this.vault.delete(id);
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
    } else {
      cfg.password = s.password;
      cfg.tryKeyboard = true;
    }
    return cfg;
  }
}
