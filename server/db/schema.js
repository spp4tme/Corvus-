// Migrations versionnées. Règle : on n'édite JAMAIS une migration publiée, on en ajoute une.
// Conventions : dates en millisecondes Unix (INTEGER), booléens 0/1, listes/objets en JSON (TEXT).
export const MIGRATIONS = [
  {
    version: 1,
    name: 'schéma initial',
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Comptes et accès ------------------------------------------------------------------------
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  totp_secret TEXT,                 -- chiffré par le coffre
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
-- Droits par hôte ou par groupe. Sans ligne : le rôle global s'applique à tous les hôtes
-- (admin), ou à aucun (opérateur / lecture seule n'ont accès qu'aux hôtes accordés).
CREATE TABLE grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('host', 'group', 'all')),
  target TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('operator', 'viewer')),
  PRIMARY KEY (user_id, scope, target)
);
CREATE TABLE auth_sessions (
  key TEXT PRIMARY KEY,             -- sha256 de l'identifiant de session
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  token_tag TEXT NOT NULL,
  mfa INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT, ip TEXT
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,              -- identifiant de la passkey (base64url)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,         -- clé publique au format JWK (JSON)
  alg INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Hôtes, secrets, empreintes ------------------------------------------------------------
CREATE TABLE host_groups (name TEXT PRIMARY KEY COLLATE NOCASE, created_at INTEGER NOT NULL);
CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'server',
  grp TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  tmux INTEGER NOT NULL DEFAULT 0,
  tmux_session TEXT NOT NULL DEFAULT 'corvus',
  claude_dir TEXT NOT NULL DEFAULT '',
  claude_cmd TEXT NOT NULL DEFAULT 'claude',
  repos TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',  -- champs secondaires (tailscale, sudo…)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,              -- ex. 'host:<id>', 'totp:<user>'
  iv TEXT NOT NULL, tag TEXT NOT NULL, ct TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE known_hosts (
  host_port TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  type TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE host_status (
  host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  state TEXT NOT NULL,              -- 'up' | 'down' | 'unknown'
  since INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  latency_ms INTEGER,
  error TEXT
);

-- Journal d'audit (chaîné par hash) ------------------------------------------------------
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  event TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  user_id TEXT, username TEXT,
  host_id TEXT, host_label TEXT,
  ip TEXT,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_type ON audit(type, seq);
CREATE INDEX audit_host ON audit(host_id, seq);

-- Sessions de terminal (métadonnées) et enregistrements -----------------------------------
CREATE TABLE blobs (
  sha TEXT PRIMARY KEY,             -- sha256 du contenu en clair
  size INTEGER NOT NULL,            -- taille en clair
  stored_size INTEGER NOT NULL,     -- taille compressée + chiffrée sur disque
  kind TEXT NOT NULL,
  refs INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE term_sessions (
  id TEXT PRIMARY KEY,
  host_id TEXT,
  user_id TEXT,
  username TEXT,
  host_label TEXT,
  title TEXT,
  tmux TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  cols INTEGER, rows INTEGER,
  recording_sha TEXT REFERENCES blobs(sha),
  recording_bytes INTEGER,
  duration_ms INTEGER
);
CREATE INDEX term_sessions_started ON term_sessions(started_at);

-- Alertes, métriques -------------------------------------------------------------------
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  host_id TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
  message TEXT NOT NULL,
  data TEXT,
  ack_at INTEGER, ack_by TEXT
);
CREATE INDEX alerts_ts ON alerts(ts);
CREATE TABLE metrics_raw (
  host_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (host_id, metric, ts)
) WITHOUT ROWID;
CREATE INDEX metrics_raw_ts ON metrics_raw(ts);
CREATE TABLE metrics_hourly (
  host_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  hour INTEGER NOT NULL,            -- début de l'heure (ms)
  min REAL NOT NULL, avg REAL NOT NULL, max REAL NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (host_id, metric, hour)
) WITHOUT ROWID;

-- Productivité -----------------------------------------------------------------------------
CREATE TABLE snippets (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  host_id TEXT REFERENCES hosts(id) ON DELETE CASCADE,  -- NULL : tous les hôtes
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE command_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL,
  user_id TEXT,
  cwd TEXT,
  command TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'bar'  -- 'bar' (barre Corvus), 'hook' (crochet shell), 'osc' (marqueurs)
);
CREATE INDEX command_history_host ON command_history(host_id, ts);
CREATE TABLE undo_ops (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  user_id TEXT,
  ts INTEGER NOT NULL,
  command TEXT NOT NULL,
  files TEXT NOT NULL,              -- [{path, existed, sha, mode, uid, gid, type}]
  state TEXT NOT NULL DEFAULT 'ready', -- 'ready' | 'undone' | 'failed'
  undone_at INTEGER
);

-- Push, services web --------------------------------------------------------------------
CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT, label TEXT, created_at INTEGER NOT NULL);
CREATE TABLE services (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL);

-- Agent (étapes 1, 6, 7 : remplies depuis le Pi) --------------------------------------------
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  public_key TEXT NOT NULL,
  version TEXT,
  capabilities TEXT NOT NULL DEFAULT '{}',
  enrolled_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE agent_enrollments (token_hash TEXT PRIMARY KEY, host_id TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  host_id TEXT,
  agent_seq INTEGER NOT NULL,       -- numéro côté agent : renvoi idempotent après coupure
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE (agent_id, agent_seq)
);
CREATE INDEX agent_events_host ON agent_events(host_id, ts);
CREATE TABLE behavior_profile (
  host_id TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'process' | 'listen' | 'dest' | 'hour'
  item TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (host_id, kind, item)
) WITHOUT ROWID;
`,
  },
  {
    version: 2,
    name: 'comptes : anti-rejeu TOTP, fin des sessions sans compte',
    sql: `
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT -1;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
-- Les sessions ouvertes avec l'ancien token unique ne correspondent à aucun compte.
DELETE FROM auth_sessions WHERE user_id IS NULL;
`,
  },
  {
    version: 3,
    name: 'rembobinage : versions de fichiers reçues des agents',
    sql: `
-- Un contenu (blob chiffré, adressé par SHA-256) par hôte et par empreinte ; une référence dans la table blobs par ligne.
CREATE TABLE agent_versions (
  host_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, sha256)
) WITHOUT ROWID;
CREATE INDEX agent_events_type ON agent_events(host_id, type, ts);
`,
  },
  {
    version: 4,
    name: 'agents : plateforme annoncée (linux, windows, macos) — informative, jamais une décision de sécurité',
    sql: `
-- NULL = agent antérieur à 1.2 (protocole inchangé) : traité comme linux.
ALTER TABLE agents ADD COLUMN platform TEXT;
`,
  },
  {
    version: 5,
    name: 'playbooks : définitions versionnées, exécutions et sorties par hôte (automatisation désactivée par défaut)',
    sql: `
-- Un playbook : script NOMMÉ exécuté sur l'hôte cible par SSH. Le risque est CALCULÉ par le serveur. auto_authorized = faux par défaut.
CREATE TABLE playbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  risk TEXT NOT NULL,
  auto_authorized INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Historique : une ligne par version (qui, quand). Jamais modifiée ni supprimée tant que le playbook existe.
CREATE TABLE playbook_versions (
  playbook_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL,
  risk TEXT NOT NULL,
  auto_authorized INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (playbook_id, version)
) WITHOUT ROWID;
-- Exécutions : le nom du playbook est recopié (l'historique survit à la suppression du playbook). Aucune valeur de secret.
CREATE TABLE playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT,
  playbook_name TEXT NOT NULL,
  playbook_version INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  actor TEXT,
  user_id TEXT,
  status TEXT NOT NULL,
  dry INTEGER NOT NULL DEFAULT 0,
  params TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT
);
CREATE INDEX playbook_runs_ts ON playbook_runs(started_at DESC);
CREATE INDEX playbook_runs_pb ON playbook_runs(playbook_id, started_at DESC);
-- Sortie (masquée, bornée) par hôte et par commande.
CREATE TABLE playbook_run_steps (
  run_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  host_label TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  code INTEGER,
  output TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (run_id, host_id, idx)
) WITHOUT ROWID;
CREATE INDEX playbook_run_steps_host ON playbook_run_steps(host_id, started_at DESC);
`,
  },
  {
    version: 6,
    name: 'playbooks : planifications, déclencheurs d\'alerte (liste blanche + coupe-circuit), webhooks entrants (jeton, HMAC, anti-rejeu)',
    sql: `
-- Planification : expression cron + fuseau EXPLICITE (jamais de valeur par défaut) + fenêtre de maintenance facultative.
CREATE TABLE automation_schedules (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  tz TEXT NOT NULL,
  win TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_at INTEGER,
  last_at INTEGER,
  last_status TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX automation_schedules_due ON automation_schedules(enabled, next_at);
-- Déclencheur alerte → playbook : LISTE D'AUTORISATIONS explicite (un type d'alerte, un playbook), limitée en fréquence, avec coupe-circuit.
CREATE TABLE automation_alert_triggers (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  alert_kind TEXT NOT NULL,
  min_severity TEXT NOT NULL DEFAULT 'warn',
  host_id TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  max_runs INTEGER NOT NULL DEFAULT 3,
  window_min INTEGER NOT NULL DEFAULT 60,
  cooldown_sec INTEGER NOT NULL DEFAULT 120,
  tripped_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE automation_trigger_events (
  trigger_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX automation_trigger_events_idx ON automation_trigger_events(trigger_id, ts);
-- Webhook entrant : un jeton (haché) limité à UN playbook ; le secret HMAC est dans le coffre ; anti-rejeu par signature.
CREATE TABLE automation_hooks (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE automation_hook_replays (
  hook_id TEXT NOT NULL,
  sig TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (hook_id, sig)
) WITHOUT ROWID;
`,
  },
];
