// Emplacement des données lourdes (base, blobs, sauvegardes) et surveillance de l'espace libre.
//
// CORVUS_DATA    : petit dossier (token d'amorçage, configuration) — peut rester sur la carte SD.
// CORVUS_STORAGE : base SQLite + blobs + sauvegardes — idéalement un SSD externe.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './store.js';
import { logger } from './log.js';

const log = logger('storage');

export function resolveStorage(config) {
  const custom = config.storageDir && path.resolve(config.storageDir) !== path.resolve(config.dataDir);
  const dir = custom ? path.resolve(config.storageDir) : config.dataDir;
  // Un disque externe non monté laisserait un dossier vide sur la carte SD : on refuse de démarrer
  // plutôt que d'écrire au mauvais endroit (et de « perdre » la base au remontage du disque).
  if (custom && !fs.existsSync(dir)) {
    throw new Error(`CORVUS_STORAGE=${dir} est introuvable. Disque externe non monté ? Montez-le (ou créez le dossier) puis relancez Corvus.`);
  }
  ensureDir(dir);
  const out = {
    dir,
    custom,
    dbFile: path.join(dir, 'corvus.db'),
    blobDir: path.join(dir, 'blobs'),
    backupDir: path.join(dir, 'backups'),
  };
  ensureDir(out.blobDir);
  ensureDir(out.backupDir);
  return out;
}

/** Espace disque du système de fichiers qui contient `dir` (octets). */
export function diskSpace(dir) {
  const s = fs.statfsSync(dir);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  return { total, free, percentFree: total ? (100 * free) / total : 100 };
}

/** Taille d'un dossier (récursif, sans suivre les liens). */
export function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) stack.push(p);
      else if (it.isFile()) { try { total += fs.statSync(p).size; } catch { /* supprimé entre-temps */ } }
    }
  }
  return total;
}

/**
 * Vérifie périodiquement l'espace libre ; alerte (une fois par passage sous le seuil) quand il
 * manque de la place. Seuil : CORVUS_MIN_FREE_MB (Mo) ou 5 % du disque, le plus grand des deux.
 */
export class StorageMonitor {
  constructor({ storage, config, alerts }) {
    Object.assign(this, { storage, config, alerts });
    this.low = new Map();
  }

  targets() {
    const t = [{ key: 'storage', label: 'stockage (base, enregistrements, sauvegardes)', dir: this.storage.dir }];
    if (this.storage.custom) t.push({ key: 'data', label: 'données de configuration', dir: this.config.dataDir });
    return t;
  }

  status() {
    const minFree = this.config.minFreeMb * 1024 * 1024;
    return this.targets().map((t) => {
      let space;
      try { space = diskSpace(t.dir); } catch (err) { return { ...t, error: err.message, low: false }; }
      const threshold = Math.max(minFree, space.total * 0.05);
      return { ...t, ...space, threshold, low: space.free < threshold };
    });
  }

  check() {
    const st = this.status();
    for (const s of st) {
      const was = this.low.get(s.key) || false;
      if (s.low && !was) {
        const msg = `Espace disque faible pour le ${s.label} : ${Math.round(s.free / 1048576)} Mo libres (${s.percentFree.toFixed(1)} %) dans ${s.dir}`;
        log.warn(msg);
        this.alerts?.raise({ kind: 'disk-space', severity: 'critical', message: msg, data: { dir: s.dir, free: s.free } });
      }
      this.low.set(s.key, s.low);
    }
    return st;
  }

  start(intervalMs = 10 * 60_000) {
    this.check();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}
