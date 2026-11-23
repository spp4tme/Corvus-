// Échappement shell POSIX. Toute commande construite côté serveur passe par ici.

/** Entoure une valeur de quotes simples POSIX : 'a'\''b'. */
export function q(value) {
  const s = String(value);
  if (s.includes('\0')) throw new Error('NUL interdit dans un argument shell');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Chemin distant pouvant commencer par ~ : ~ est développé hors des quotes. */
export function qPath(p) {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/${q(p.slice(2))}`;
  return q(p);
}

/**
 * Encapsule un script POSIX pour exécution distante quel que soit le shell de connexion
 * de l'utilisateur (bash, zsh, fish…) : `sh -c '<script>'`.
 */
export function shWrap(script) {
  return `sh -c ${q(script)}`;
}
