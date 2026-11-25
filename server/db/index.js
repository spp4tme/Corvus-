// Couche d'accès unique à la base SQLite (module `node:sqlite` intégré à Node ≥ 22.13 :
// aucune dépendance native). Toutes les requêtes passent par cette classe : paramètres liés
// (jamais de concaténation de valeurs dans le SQL), requêtes préparées mises en cache,
// transactions imbriquables, migrations versionnées.
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';
import { logger } from '../lib/log.js';

const log = logger('db');

export class Db {
  /** @param {string} file chemin du fichier (':memory:' pour les tests) */
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    // WAL : lectures pendant les écritures, et beaucoup moins d'écritures sur la carte SD.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.cache = new Map();
    this.depth = 0;
    this.migrate();
  }

  prep(sql) {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }

  /** INSERT / UPDATE / DELETE. Retourne { changes, lastInsertRowid }. */
  run(sql, ...params) {
    return this.prep(sql).run(...params.map(bind));
  }

  /** Première ligne ou undefined. */
  get(sql, ...params) {
    return this.prep(sql).get(...params.map(bind));
  }

  all(sql, ...params) {
    return this.prep(sql).all(...params.map(bind));
  }

  /** Exécute `fn` dans une transaction (les appels imbriqués rejoignent la transaction en cours). */
  tx(fn) {
    if (this.depth > 0) {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  /** Lecture / écriture de la table clé → valeur JSON `meta`. */
  getMeta(key, def = null) {
    const row = this.get('SELECT value FROM meta WHERE key = ?', key);
    return row ? JSON.parse(row.value) : def;
  }

  setMeta(key, value) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  get version() {
    return this.get('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
  }

  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
    const current = this.version;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, Date.now());
      });
      log.info(`Migration ${m.version} appliquée : ${m.name}`);
    }
  }

  /** Copie cohérente de la base, à chaud (sauvegarde). */
  backupTo(file) {
    this.run('VACUUM INTO ?', file);
  }

  close() {
    this.cache.clear();
    try { this.db.close(); } catch { /* déjà fermée */ }
  }
}

// node:sqlite n'accepte ni booléens ni undefined : conversion explicite.
function bind(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
