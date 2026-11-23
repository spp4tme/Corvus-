// Validation stricte de toutes les entrées utilisateur.
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const bad = (message, details) => new HttpError(400, 'BAD_REQUEST', message, details);

const ID_RE = /^[a-z0-9]{8,32}$/;
const HOSTNAME_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-_]{0,62})?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-_]{0,62})?)*\.?|\[?[0-9A-Fa-f:.]+(?:%[A-Za-z0-9]+)?\]?)$/;
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._@\\-]{0,63}$/;
const SHA_RE = /^[0-9a-fA-F]{4,64}$/;
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TMUX_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const ICONS = ['server', 'desktop', 'laptop', 'pi', 'cloud', 'database', 'router', 'nas', 'container', 'globe', 'phone', 'shield'];
export const SIGNALS = ['TERM', 'KILL', 'INT', 'HUP', 'STOP', 'CONT'];

export function str(v, name, { min = 0, max = 256, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    if (min === 0 && v === '') return '';
    throw bad(`Champ requis : ${name}`);
  }
  if (typeof v !== 'string') throw bad(`${name} doit être une chaîne`);
  if (v.length < min || v.length > max) throw bad(`${name} : longueur invalide (${min}–${max})`);
  if (v.includes('\0')) throw bad(`${name} : caractère interdit`);
  return v;
}

export function id(v, name = 'id') {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw bad(`Identifiant invalide : ${name}`);
  return v;
}

export function hostname(v) {
  const s = str(v, 'hostname', { min: 1, max: 253 }).trim();
  if (!HOSTNAME_RE.test(s)) throw bad('Nom d\'hôte ou IP invalide');
  return s.replace(/^\[|\]$/g, '');
}

export function port(v) {
  const n = v === undefined || v === '' ? 22 : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad('Port invalide (1–65535)');
  return n;
}

export function username(v) {
  const s = str(v, 'utilisateur', { min: 1, max: 64 });
  if (!USER_RE.test(s)) throw bad('Nom d\'utilisateur invalide');
  return s;
}

export function int(v, name, { min = 0, max = Number.MAX_SAFE_INTEGER, def } = {}) {
  if ((v === undefined || v === '') && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} invalide`);
  return n;
}

export function bool(v, def = false) {
  if (v === undefined) return def;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw bad('Booléen attendu');
}

/** Chemin distant (SFTP ou shell). Pas de NUL ni de saut de ligne. */
export function remotePath(v, name = 'chemin') {
  const s = str(v, name, { min: 1, max: 4096 });
  if (/[\r\n]/.test(s)) throw bad(`${name} : caractères interdits`);
  return s;
}

/** Nom de fichier simple (sans séparateur). */
export function fileName(v) {
  const s = str(v, 'nom', { min: 1, max: 255 });
  if (s === '.' || s === '..' || /[\/\r\n]/.test(s)) throw bad('Nom de fichier invalide');
  return s;
}

/** Nom de référence git — sous-ensemble strict de `git check-ref-format`. */
export function gitRef(v, name = 'branche') {
  const s = str(v, name, { min: 1, max: 200 });
  if (
    !/^[A-Za-z0-9._\/+-]+$/.test(s) ||
    s.startsWith('-') || s.startsWith('/') || s.endsWith('/') || s.endsWith('.') ||
    s.endsWith('.lock') || s.includes('..') || s.includes('//') || s.includes('@{') ||
    s.split('/').some((c) => c.startsWith('.'))
  ) throw bad(`${name} : nom de référence git invalide`);
  return s;
}

export function sha(v) {
  if (typeof v !== 'string' || !SHA_RE.test(v)) throw bad('SHA invalide');
  return v.toLowerCase();
}

export function container(v) {
  if (typeof v !== 'string' || !CONTAINER_RE.test(v)) throw bad('Conteneur invalide');
  return v;
}

export function tmuxName(v) {
  if (v === undefined || v === '') return 'corvus';
  if (typeof v !== 'string' || !TMUX_RE.test(v)) throw bad('Nom de session tmux invalide (A-Z a-z 0-9 _ -)');
  return v;
}

// --- Claude Code -------------------------------------------------------------------------
// La commande Claude est stockée avec l'hôte, jamais fournie par le client au moment du lancement.
// Chaque mot est restreint à un jeu de caractères sans aucun métacaractère shell ; le premier doit
// être exactement `claude`.
const CLAUDE_WORD_RE = /^-{0,2}[A-Za-z0-9][A-Za-z0-9._=:@\/+,-]{0,79}$/;
const CLAUDE_SESSION_RE = /^corvus-claude-[a-z0-9-]{1,24}-\d{1,4}$/;
export const CLAUDE_DANGEROUS_FLAG = '--dangerously-skip-permissions';

/** Retourne la commande normalisée (mots séparés par un espace) ; vide → `claude`. */
export function claudeCmd(v) {
  if (v === undefined || v === null || String(v).trim() === '') return 'claude';
  const s = str(v, 'commande Claude', { max: 300 });
  const words = s.trim().split(/\s+/);
  if (words.length > 12) throw bad('Commande Claude : 12 mots maximum');
  if (words[0] !== 'claude') throw bad('Commande Claude : doit commencer par « claude »');
  for (const w of words) {
    if (!CLAUDE_WORD_RE.test(w)) throw bad(`Commande Claude : « ${w.slice(0, 30)} » n'est pas autorisé (lettres, chiffres et . _ = : @ / + , - seulement)`);
  }
  return words.join(' ');
}

export function claudeDangerous(cmd) {
  return String(cmd || '').split(/\s+/).includes(CLAUDE_DANGEROUS_FLAG);
}

/** Dossier de projet : chemin distant, ou vide pour le dossier personnel. */
export function claudeDir(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '';
  const s = remotePath(String(v).trim(), 'dossier de projet');
  if (/[\x00-\x1f\x7f]/.test(s)) throw bad('Dossier de projet : caractères interdits');
  return s;
}

export function claudeSession(v) {
  if (typeof v !== 'string' || !CLAUDE_SESSION_RE.test(v)) throw bad('Nom de session Claude invalide');
  return v;
}

export function oneOf(v, values, name) {
  if (!values.includes(v)) throw bad(`${name} invalide`);
  return v;
}

export function pathList(v, name = 'fichiers') {
  if (!Array.isArray(v) || !v.length || v.length > 500) throw bad(`${name} : liste invalide`);
  return v.map((p) => remotePath(p, name));
}
