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
  webProxy: bool(env.CORVUS_WEB_PROXY, true),
  proxyAllowPrivate: bool(env.CORVUS_PROXY_ALLOW_PRIVATE, false),
  vapidSubject: env.CORVUS_VAPID_SUBJECT || 'mailto:corvus@localhost',
});
