// Configuration centralisée — tout passe par des variables d'environnement.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(v, def) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
}
function list(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}
/** Entier >= 1, sinon la valeur par défaut : un plafond ne peut pas être désactivé (0, négatif, texte). */
function positive(v, def) {
  const n = int(v, def);
  return n >= 1 ? n : def;
}
function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export const config = Object.freeze({
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  port: int(env.PORT, 7680),
  // 127.0.0.1 par défaut : Corvus n'est JAMAIS exposé sans action explicite.
  bind: env.BIND || '127.0.0.1',
  allowPublicBind: bool(env.CORVUS_ALLOW_PUBLIC_BIND, false),
  dataDir: path.resolve(env.CORVUS_DATA || path.join(ROOT, 'data')),
  // Données lourdes (base SQLite, blobs, sauvegardes) : ex. un SSD externe. Vide = CORVUS_DATA.
  storageDir: env.CORVUS_STORAGE ? path.resolve(env.CORVUS_STORAGE) : '',
  minFreeMb: int(env.CORVUS_MIN_FREE_MB, 2048),
  // Limiteur de débit des routes authentifiées de /api (requêtes par minute). Généreux : seul l'abus l'atteint.
  // Plafond par compte, par IP, et plafond plus strict (par compte ET par IP) pour les sauvegardes.
  rateAccountPerMin: positive(env.CORVUS_RATE_ACCOUNT_PER_MIN, 1200),
  rateIpPerMin: positive(env.CORVUS_RATE_IP_PER_MIN, 2400),
  rateBackupPerMin: positive(env.CORVUS_RATE_BACKUP_PER_MIN, 10),
  // Tâches de fond (0 = désactivé) : sonde d'état des hôtes, collecte des métriques.
  hostProbeSec: int(env.HOST_PROBE_SEC, 60),
  hostDownAlertMin: int(env.HOST_DOWN_ALERT_MIN, 5),
  metricsIntervalSec: int(env.METRICS_INTERVAL_SEC, 30),
  recordSessions: bool(env.RECORD_SESSIONS, true),
  recordingMaxBytes: int(env.RECORDING_MAX_MB, 50) * 1024 * 1024,
  // Rétention (jours) : métriques détaillées, agrégats horaires, enregistrements de session.
  retention: {
    metricsRawDays: int(env.RETENTION_METRICS_RAW_DAYS, 7),
    metricsHourlyDays: int(env.RETENTION_METRICS_HOURLY_DAYS, 365),
    recordingsDays: int(env.RETENTION_RECORDINGS_DAYS, 90),
    undoDays: int(env.RETENTION_UNDO_DAYS, 30),
    // Historique des fichiers des hôtes (rembobinage) : événements et contenus conservés ce nombre de jours.
    rewindDays: int(env.RETENTION_REWIND_DAYS, 90),
  },
  // Empreinte du normal : durée d'apprentissage d'un hôte avant de signaler les nouveautés.
  behaviorLearnDays: int(env.BEHAVIOR_LEARN_DAYS, 14),
  masterPassphrase: env.CORVUS_MASTER_PASSPHRASE || '',
  allowedOrigins: list(env.CORVUS_ALLOWED_ORIGINS),
  // 'loopback' : on fait confiance à X-Forwarded-* uniquement depuis 127.0.0.1 (tailscale serve)
  trustProxy: env.TRUST_PROXY ?? 'loopback',
  logLevel: env.LOG_LEVEL || 'info',
  sessionTtlDays: int(env.SESSION_TTL_DAYS, 30),
  termGraceSec: int(env.TERM_GRACE_SEC, 300),
  termBufferBytes: int(env.TERM_BUFFER_KB, 256) * 1024,
  sshReadyTimeoutMs: int(env.SSH_READY_TIMEOUT_MS, 15000),
  sshIdleMs: int(env.SSH_IDLE_MIN, 10) * 60_000,
  tailscaleBin: env.TAILSCALE_BIN || 'tailscale',
  maxEditBytes: 2 * 1024 * 1024,
  maxPreviewBytes: int(env.MAX_PREVIEW_MB, 20) * 1024 * 1024,
  maxUploadBytes: int(env.MAX_UPLOAD_MB, 1024) * 1024 * 1024,
  // Copie d'hôte à hôte : taille totale, nombre de fichiers (dossier) et débit maximal (0 = illimité).
  copyMaxBytes: int(env.COPY_MAX_MB, 2048) * 1024 * 1024,
  copyMaxFiles: int(env.COPY_MAX_FILES, 5000),
  copyMaxBps: int(env.COPY_MAX_MBPS, 0) * 1024 * 1024,
  webProxy: bool(env.CORVUS_WEB_PROXY, true),
  proxyAllowPrivate: bool(env.CORVUS_PROXY_ALLOW_PRIVATE, false),
  vapidSubject: env.CORVUS_VAPID_SUBJECT || 'mailto:corvus@example.com',
});
