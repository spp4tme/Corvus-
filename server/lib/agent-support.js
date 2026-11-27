// Ce que l'agent d'un hôte sait faire, pour que l'interface MASQUE ou GRISE (avec une explication) les fonctions
// indisponibles au lieu de les proposer puis d'échouer.
//
// IMPORTANT — ce module INFORME, il ne décide jamais d'une autorisation : `platform` et `capabilities` sont annoncés
// par l'agent (donc par l'hôte), le serveur ne leur fait pas confiance pour la sécurité. Les droits de l'utilisateur
// (rôles, droits par hôte, `confirm: true`) sont vérifiés ailleurs ; l'agent valide à son tour chaque action.

export const PLATFORMS = ['linux', 'windows', 'macos'];
/** Plateformes dont l'agent n'a été validé sur aucune vraie machine : l'interface l'indique. */
export const EXPERIMENTAL_PLATFORMS = new Set(['macos']);

const PLATFORM_LABEL = { linux: 'Linux', windows: 'Windows', macos: 'macOS', unknown: 'plateforme inconnue' };
export const platformLabel = (p) => PLATFORM_LABEL[p] || PLATFORM_LABEL.unknown;

/**
 * `platform` absent (agents 1.0/1.1, protocole inchangé) = linux. Une valeur présente mais inconnue devient
 * « unknown » (affichée telle quelle, jamais interprétée) : elle n'ouvre aucune fonction supplémentaire.
 */
export function normalizePlatform(value) {
  if (value === undefined || value === null) return 'linux';
  if (typeof value !== 'string') return 'unknown';
  const v = value.trim().toLowerCase();
  return PLATFORMS.includes(v) ? v : 'unknown';
}

/** Action nommée → fonction d'interface qui en dépend. */
export const ACTION_FEATURE = {
  'file.restore': 'restore', 'file.remove': 'restore',
  'preview.run': 'preview', 'preview.apply': 'preview',
  'xray.live': 'xray',
  'proc.freeze': 'procActions', 'proc.thaw': 'procActions', 'proc.kill': 'procActions',
  'net.status': 'isolation', 'net.isolate': 'isolation', 'net.release': 'isolation',
};

const has = (caps, ...names) => Array.isArray(caps?.actions) && names.every((n) => caps.actions.includes(n));

/** Fonction → vrai si l'agent l'annonce. */
const CHECKS = {
  history: (c) => c?.files === true,
  restore: (c) => c?.files === true && has(c, 'file.restore', 'file.remove'),
  xray: (c) => c?.xray === true && has(c, 'xray.live'),
  procActions: (c) => has(c, 'proc.freeze', 'proc.thaw', 'proc.kill'),
  ransom: (c) => c?.ransom === true,
  isolation: (c) => c?.isolation === true && has(c, 'net.isolate', 'net.release', 'net.status'),
  preview: (c) => c?.preview === true && has(c, 'preview.run', 'preview.apply'),
  exactWriter: (c) => c?.fanotify === true,
};

export const FEATURES = Object.keys(CHECKS);

const GENERIC = {
  history: 'La surveillance de fichiers n\'est pas active sur cet agent.',
  restore: 'Cet agent ne propose pas la restauration de fichiers.',
  xray: 'Cet agent ne propose pas la lecture des processus.',
  procActions: 'Cet agent ne propose pas de geler, dégeler ou arrêter un processus.',
  ransom: 'La détection de ransomware n\'est pas active sur cet agent.',
  isolation: 'L\'isolement réseau exige un agent aux droits complets (root) et nftables sur l\'hôte.',
  preview: 'La prévisualisation exige un agent aux droits complets (root, --allow-preview) et les espaces de noms Linux.',
  exactWriter: 'L\'écrivain exact d\'un fichier exige fanotify (Linux, droits complets) : l\'agent propose des candidats par balayage.',
};

// Explications propres à une plateforme : ce que l'agent n'y fait PAS, dit franchement.
const BY_PLATFORM = {
  windows: {
    restore: 'La restauration de fichiers n\'existe pas encore pour l\'agent Windows : il surveille et signale les changements, sans rien réécrire.',
    procActions: 'Geler, dégeler ou arrêter un processus n\'est pas proposé par l\'agent Windows (liste des processus en lecture seule).',
    isolation: 'L\'isolement réseau repose sur nftables (Linux) : il n\'existe pas pour l\'agent Windows.',
    preview: 'La prévisualisation repose sur les espaces de noms Linux : elle n\'existe pas pour l\'agent Windows.',
    ransom: 'La détection de ransomware (entropie, fichiers pièges) n\'existe pas encore pour l\'agent Windows.',
    exactWriter: 'Windows ne désigne pas l\'écrivain exact d\'un fichier (pas de fanotify) : le changement est vu, pas son auteur.',
  },
  macos: {
    restore: 'La restauration de fichiers n\'existe pas pour l\'agent macOS (expérimental).',
    procActions: 'Geler, dégeler ou arrêter un processus n\'est pas proposé par l\'agent macOS (expérimental).',
    isolation: 'L\'isolement réseau repose sur nftables (Linux) : il n\'existe pas pour l\'agent macOS.',
    preview: 'La prévisualisation repose sur les espaces de noms Linux : elle n\'existe pas pour l\'agent macOS.',
    ransom: 'La détection de ransomware n\'existe pas pour l\'agent macOS (expérimental).',
    exactWriter: 'macOS ne désigne pas l\'écrivain exact d\'un fichier (FSEvents) : le changement est vu, pas son auteur.',
  },
};

/**
 * @param {string} platform  valeur déjà normalisée (normalizePlatform)
 * @param {object} caps      capacités annoncées par l'agent
 * @returns {{[feature: string]: {ok: boolean, reason: string|null}}}
 */
export function agentSupport(platform, caps) {
  const out = {};
  for (const f of FEATURES) {
    const ok = !!CHECKS[f](caps);
    out[f] = ok ? { ok: true, reason: null } : { ok: false, reason: BY_PLATFORM[platform]?.[f] || GENERIC[f] };
  }
  return out;
}

/** Raison pour laquelle une action nommée n'est pas proposée par l'agent, ou null si elle l'est (ou si on ne sait pas). */
export function unsupportedReason(platform, caps, action) {
  // Un agent qui n'annonce pas de liste d'actions (très ancien) : on ne bloque rien, l'agent tranchera.
  if (!Array.isArray(caps?.actions)) return null;
  if (caps.actions.includes(action)) return null;
  const feature = ACTION_FEATURE[action];
  return (feature && agentSupport(platform, caps)[feature]?.reason) || 'Cette action n\'est pas proposée par l\'agent de cet hôte.';
}
