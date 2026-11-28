// Masquage des secrets dans toute sortie ou ligne de journal d'un playbook. Module PUR (porté tel quel si l'exécuteur est réécrit).
//
// Un secret peut réapparaître sous plusieurs formes dans la sortie d'une commande : brut, entre quotes shell, échappé en JSON, en
// base64 (`echo -n $S | base64`)… On masque chacune. Ce n'est PAS une garantie absolue (une commande peut encoder un secret de mille
// façons : rot13, hexadécimal, découpage) : c'est une défense en profondeur, et la documentation le dit.

export const MASK = '***';
export const MIN_SECRET_LENGTH = 6; // en dessous, masquer abîmerait la sortie (et ne protégerait rien)
export const MAX_SECRET_LENGTH = 512;

/** Formes à masquer pour un secret. */
function variants(secret) {
  const s = String(secret);
  const set = new Set([s]);
  set.add(`'${s.replace(/'/g, `'\\''`)}'`); // quotes shell POSIX
  set.add(JSON.stringify(s).slice(1, -1)); // contenu d'une chaîne JSON
  set.add(encodeURIComponent(s));
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  set.add(b64);
  set.add(b64.replace(/=+$/, ''));
  set.add(Buffer.from(s, 'utf8').toString('base64url'));
  set.add(Buffer.from(s, 'utf8').toString('hex'));
  return [...set].filter((x) => x.length >= MIN_SECRET_LENGTH);
}

/**
 * @param {string[]} secrets valeurs en clair
 * @returns {(text: string|Buffer) => string} fonction de masquage ; les formes les plus longues d'abord (pas de reste d'un secret
 *          dont la forme brute est incluse dans une forme plus longue).
 */
export function createMasker(secrets) {
  const forms = [...new Set((secrets || []).filter((x) => typeof x === 'string' && x.length >= MIN_SECRET_LENGTH).flatMap(variants))]
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '');
    for (const f of forms) if (out.includes(f)) out = out.split(f).join(MASK);
    return out;
  };
}

/** Un secret est-il acceptable ? (une ligne, longueur bornée, pas de NUL) — il voyage ligne par ligne sur l'entrée standard. */
export function checkSecretValue(value) {
  if (typeof value !== 'string') return 'Valeur attendue (texte)';
  if (value.length < MIN_SECRET_LENGTH) return `Secret trop court (${MIN_SECRET_LENGTH} caractères au minimum : en dessous il ne pourrait pas être masqué)`;
  if (value.length > MAX_SECRET_LENGTH) return `Secret trop long (${MAX_SECRET_LENGTH} caractères au maximum)`;
  if (/[\u0000\r\n]/.test(value)) return 'Un secret tient sur une seule ligne, sans caractère nul';
  return null;
}
