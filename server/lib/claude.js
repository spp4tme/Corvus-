// Claude Code sur un hôte : toujours lancé dans une session tmux nommée `corvus-claude-<hôte>-<n>`,
// pour survivre aux coupures réseau et à la fermeture de l'application (reprise par
// `tmux new-session -A`). Le script distant est construit ICI à partir de valeurs validées
// (commande stockée avec l'hôte, dossier échappé) : aucune chaîne brute du client n'est exécutée.
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { q, qPath, shWrap } from './shell.js';

export const SESSION_PREFIX = 'corvus-claude-';
export const INSTALL = {
  native: 'curl -fsSL https://claude.ai/install.sh | bash',
  npm: 'npm install -g @anthropic-ai/claude-code',
};
export const TMUX_INSTALL = 'sudo apt install tmux   (ou : brew install tmux)';

// Les shells non interactifs n'ont pas toujours ~/.local/bin (installeur natif) ni le préfixe npm.
const PATH_FIX = 'PATH="$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; export PATH';

/** Fragment du nom de session dérivé de l'alias de l'hôte : [a-z0-9-], 20 caractères maximum. */
export function hostSlug(host) {
  const slug = String(host.name || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/g, '');
  return slug || `h${String(host.id).slice(0, 6)}`;
}

export function sessionName(host, n) {
  return v.claudeSession(`${SESSION_PREFIX}${hostSlug(host)}-${n}`);
}

/** Plus petit numéro libre pour cet hôte. */
export function nextSessionName(host, existing) {
  const taken = new Set(existing);
  for (let n = 1; n < 10_000; n++) {
    const name = sessionName(host, n);
    if (!taken.has(name)) return name;
  }
  throw new HttpError(429, 'TOO_MANY', 'Trop de sessions Claude sur cet hôte');
}

/** `claude --continue` → `'claude' '--continue'` (chaque mot est déjà validé, le quoting est une 2e barrière). */
export function quoteCmd(cmd) {
  return v.claudeCmd(cmd).split(' ').map(q).join(' ');
}

/**
 * Script lancé dans le PTY. tmux est exigé ; si la session n'existe pas encore, `claude` et le
 * dossier sont contrôlés avant de la créer. Si elle existe, on s'y rattache sans rien relancer.
 */
export function launchScript({ session, dir, cmd }) {
  const name = v.claudeSession(session);
  const s = q(name);
  const cwd = dir ? ` -c ${qPath(v.claudeDir(dir))}` : '';
  const inner = [
    PATH_FIX,
    quoteCmd(cmd),
    'rc=$?',
    `if [ "$rc" -ne 0 ]; then printf '\\n[corvus] claude s est arrete (code %s). Entree pour fermer.\\n' "$rc"; read -r _; fi`,
  ].join('\n');
  const script = [
    PATH_FIX,
    `command -v tmux >/dev/null 2>&1 || { printf '\\r\\n[corvus] tmux est introuvable sur cet hote : %s\\r\\n' ${q(TMUX_INSTALL)}; exit 127; }`,
    `if tmux has-session -t ${q(`=${name}`)} 2>/dev/null; then exec tmux new-session -A -s ${s} \\; set-option -q mouse on; fi`,
    `command -v claude >/dev/null 2>&1 || { printf '\\r\\n[corvus] claude est introuvable sur cet hote. Installation : %s\\r\\n' ${q(INSTALL.native)}; exit 127; }`,
    `exec tmux new-session -A -s ${s}${cwd} ${q(shWrap(inner))} \\; set-option -q mouse on`,
  ].join('\n');
  return shWrap(script);
}

/** Script de diagnostic : tmux, claude, dossier, sessions Claude existantes. */
export function statusScript({ dir }) {
  return [
    'export LC_ALL=C',
    PATH_FIX,
    "echo '##tmux'; command -v tmux >/dev/null 2>&1 && echo yes || echo no",
    "echo '##claude'; command -v claude 2>/dev/null | head -n 1",
    "echo '##version'; command -v claude >/dev/null 2>&1 && claude --version 2>/dev/null | head -n 1",
    dir ? `echo '##dir'; [ -d ${qPath(dir)} ] && echo yes || echo no` : '',
    "echo '##sessions'",
    `command -v tmux >/dev/null 2>&1 && tmux list-sessions -F '#{session_name}|#{session_created}|#{session_attached}|#{session_activity}|#{pane_current_path}' 2>/dev/null | grep '^${SESSION_PREFIX}' || true`,
    "echo '##end'",
  ].filter(Boolean).join('\n');
}

export function parseStatus(text) {
  const sec = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^##(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; sec[cur] = []; continue; }
    if (cur && line.trim()) sec[cur].push(line.trim());
  }
  const sessions = (sec.sessions || []).map((l) => {
    const [name, created, attached, activity, ...cwd] = l.split('|');
    if (!/^corvus-claude-[a-z0-9-]+-\d+$/.test(name)) return null;
    return {
      name,
      createdAt: Number(created) * 1000 || null,
      attached: Number(attached) || 0,
      activityAt: Number(activity) * 1000 || null,
      cwd: cwd.join('|') || null,
    };
  }).filter(Boolean);
  return {
    tmux: sec.tmux?.[0] === 'yes',
    claude: { installed: !!sec.claude?.[0], path: sec.claude?.[0] || null, version: sec.version?.[0] || null },
    dirOk: sec.dir ? sec.dir[0] === 'yes' : null,
    sessions,
  };
}

export class ClaudeService {
  constructor({ pool, hosts, journal }) {
    Object.assign(this, { pool, hosts, journal });
  }

  /** Réglages de l'hôte (valeurs par défaut pour les hôtes créés avant cette fonction). */
  settings(host) {
    const cmd = host.claudeCmd || 'claude';
    return { cmd, dir: host.claudeDir || '', dangerous: v.claudeDangerous(cmd) };
  }

  async status(hostId, { dir } = {}) {
    const host = this.hosts.get(hostId);
    const cfg = this.settings(host);
    const effectiveDir = dir === undefined ? cfg.dir : v.claudeDir(dir);
    const r = await this.pool.exec(hostId, statusScript({ dir: effectiveDir }), { timeoutMs: 15_000, maxBytes: 262_144 });
    const st = parseStatus(r.stdout.toString('utf8'));
    return { ...st, settings: { ...cfg, dir: effectiveDir }, install: INSTALL, tmuxInstall: TMUX_INSTALL };
  }

  /**
   * Prépare l'ouverture d'un terminal Claude : contrôles clairs avant de créer le PTY, nom de
   * session (nouvelle ou reprise) et script à exécuter.
   */
  async prepare(hostId, { session, dir } = {}) {
    const host = this.hosts.get(hostId);
    const st = await this.status(hostId, { dir });
    const name = session ? v.claudeSession(session) : nextSessionName(host, st.sessions.map((s) => s.name));
    const resumed = st.sessions.some((s) => s.name === name);
    if (!st.tmux) {
      throw new HttpError(412, 'TMUX_MISSING', `tmux est requis pour Claude Code mais il est absent de cet hôte. Installation : ${TMUX_INSTALL}`, { install: TMUX_INSTALL });
    }
    if (!resumed) {
      if (!st.claude.installed) {
        throw new HttpError(412, 'CLAUDE_MISSING',
          `Claude Code n'est pas installé sur cet hôte. Installation : ${INSTALL.native}  (ou : ${INSTALL.npm})`, { install: INSTALL });
      }
      if (st.settings.dir && st.dirOk === false) {
        throw new HttpError(412, 'CLAUDE_DIR_MISSING', `Le dossier de projet « ${st.settings.dir} » n'existe pas sur cet hôte.`, { dir: st.settings.dir });
      }
    }
    return {
      name, resumed, dangerous: st.settings.dangerous,
      command: launchScript({ session: name, dir: st.settings.dir, cmd: st.settings.cmd }),
    };
  }

  async kill(hostId, name) {
    const host = this.hosts.get(hostId);
    const session = v.claudeSession(name);
    const r = await this.pool.exec(hostId, `command -v tmux >/dev/null 2>&1 && tmux kill-session -t ${q(`=${session}`)}`, { timeoutMs: 10_000 });
    const ok = r.code === 0;
    this.journal.add({ type: 'terminal', event: 'claude-kill', host, ok, detail: session });
    if (!ok) throw new HttpError(404, 'SESSION_GONE', 'Session Claude introuvable (déjà terminée ?)');
    return { ok: true };
  }
}
