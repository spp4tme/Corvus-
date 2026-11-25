// Migration automatique des anciennes données JSON (Corvus ≤ 0.1) vers SQLite.
// Exécutée une seule fois, au premier démarrage avec la base. Les fichiers d'origine ne sont pas
// supprimés : ils sont renommés en `*.migrated` (retour arrière possible à la main).
import fs from 'node:fs';
import path from 'node:path';
import { openLegacyVault } from '../lib/vault.js';
import { entryHash, GENESIS } from '../lib/journal.js';
import { logger } from '../lib/log.js';

const log = logger('migration');
const FILES = ['hosts.json', 'sessions.json', 'known_hosts.json', 'services.json', 'push.json', 'vapid.json', 'journal.jsonl', 'secrets.enc.json'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Migration : fichier illisible ${file} (${err.message})`);
  }
}

/**
 * @returns {null | {hosts: number, journal: number, secrets: number}} résumé, null si rien à migrer
 */
export function migrateLegacy({ db, dataDir, vault, hosts, token, passphrase }) {
  if (db.getMeta('legacy.migrated')) return null;
  const present = FILES.filter((f) => fs.existsSync(path.join(dataDir, f)));
  if (!present.length) {
    db.setMeta('legacy.migrated', { at: Date.now(), files: [] });
    return null;
  }
  const p = (f) => path.join(dataDir, f);
  const summary = { hosts: 0, journal: 0, secrets: 0 };

  // Déchiffrement AVANT toute écriture : si la passphrase manque, on s'arrête sans rien toucher.
  const legacySecrets = fs.existsSync(p('secrets.enc.json'))
    ? openLegacyVault(readJson(p('secrets.enc.json')), { token, passphrase }) : {};

  db.tx(() => {
    for (const h of readJson(p('hosts.json'))?.hosts || []) {
      hosts.save({ icon: 'server', group: '', pinned: false, tmux: false, tmuxSession: 'corvus', claudeDir: '', claudeCmd: 'claude', repos: [], ...h }, null);
      summary.hosts++;
    }
    for (const [id, value] of Object.entries(legacySecrets)) {
      vault.set(id, value);
      summary.secrets++;
    }
    for (const [hp, k] of Object.entries(readJson(p('known_hosts.json'))?.hosts || {})) {
      db.run('INSERT OR REPLACE INTO known_hosts (host_port, fingerprint, type, added_at) VALUES (?, ?, ?, ?)', hp, k.fingerprint, k.type || 'inconnu', k.addedAt || Date.now());
    }
    for (const [key, s] of Object.entries(readJson(p('sessions.json'))?.sessions || {})) {
      if (!s.tk || s.expires < Date.now()) continue;
      db.run('INSERT OR IGNORE INTO auth_sessions (key, user_id, token_tag, mfa, created_at, expires_at, ua, ip) VALUES (?, NULL, ?, 0, ?, ?, ?, ?)',
        key, s.tk, s.created || Date.now(), s.expires, s.ua ?? null, s.ip ?? null);
    }
    for (const s of readJson(p('services.json'))?.services || []) {
      db.run('INSERT OR IGNORE INTO services (id, name, url, created_at) VALUES (?, ?, ?, ?)', s.id, s.name, s.url, s.createdAt || Date.now());
    }
    for (const s of readJson(p('push.json'))?.subscriptions || []) {
      db.run('INSERT OR IGNORE INTO push_subscriptions (endpoint, label, created_at) VALUES (?, ?, ?)', s.endpoint, s.label ?? '', s.createdAt || Date.now());
    }
    const vapid = readJson(p('vapid.json'));
    if (vapid?.privateJwk) vault.set('push:vapid', vapid);

    // Journal : l'historique est repris, puis chaîné dans l'ordre chronologique.
    let prev = db.get('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1')?.hash || GENESIS;
    let lines = [];
    try { lines = fs.readFileSync(p('journal.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { /* absent */ }
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const row = {
        ts: Date.parse(e.ts) || Date.now(), type: String(e.type || 'legacy').slice(0, 20), event: String(e.event || '').slice(0, 40),
        ok: e.ok !== false, user_id: null, username: null, host_id: e.hostId ?? null, host_label: e.host ?? null, ip: null,
        detail: e.detail ?? null,
      };
      row.hash = entryHash(prev, row);
      db.run(`INSERT INTO audit (ts, type, event, ok, user_id, username, host_id, host_label, ip, detail, prev_hash, hash)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)`, row.ts, row.type, row.event, row.ok, row.host_id, row.host_label, row.detail, prev, row.hash);
      prev = row.hash;
      summary.journal++;
    }
    db.setMeta('legacy.migrated', { at: Date.now(), files: present, summary });
  });

  for (const f of present) {
    try { fs.renameSync(p(f), p(`${f}.migrated`)); } catch (err) { log.warn(`Renommage impossible : ${f}`, err); }
  }
  log.info(`Anciennes données migrées vers SQLite : ${summary.hosts} hôte(s), ${summary.secrets} secret(s), ${summary.journal} entrée(s) de journal. Originaux renommés en *.migrated.`);
  return summary;
}
