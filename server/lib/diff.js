// Comparaison de fichiers texte en JavaScript pur (algorithme de Myers, O(ND)), sans dépendance.
// Sert à « Comparer » une configuration entre hôtes. Tout est borné : nombre de lignes, taille d'une ligne, écart maximal.
import { HttpError } from './validate.js';

export const MAX_LINES = 20000;     // lignes par fichier
export const MAX_LINE_CHARS = 2000; // une ligne plus longue est tronquée à l'affichage
export const MAX_EDIT = 2000;       // écart maximal (insertions + suppressions) avant d'abandonner
export const MAX_ROWS = 4000;       // lignes de résultat renvoyées au navigateur

/** Découpe en lignes en acceptant « \n » et « \r\n » ; un « \n » final ne crée pas de ligne vide. */
export function splitLines(text) {
  if (!text) return [];
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Vrai si le texte contient des fins de ligne Windows (information, la comparaison les ignore). */
export const hasCrlf = (text) => text.includes('\r\n');

/**
 * Suite d'opérations pour passer de `a` à `b` : [{ op: '=' | '-' | '+', a?: index, b?: index }].
 * Les préfixes et suffixes communs sont retirés d'abord (cas courant : fichiers presque identiques).
 */
export function diffOps(a, b) {
  if (a.length > MAX_LINES || b.length > MAX_LINES) throw new HttpError(413, 'TOO_MANY_LINES', `Plus de ${MAX_LINES} lignes : comparaison refusée`);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: '=', a: i, b: i });
  for (const o of myers(a, b, start, endA, endB)) ops.push(o);
  for (let k = 0; endA + k < a.length; k++) ops.push({ op: '=', a: endA + k, b: endB + k });
  return ops;
}

function myers(a, b, s, endA, endB) {
  const n = endA - s;
  const m = endB - s;
  if (n === 0) return Array.from({ length: m }, (_, i) => ({ op: '+', b: s + i }));
  if (m === 0) return Array.from({ length: n }, (_, i) => ({ op: '-', a: s + i }));
  const max = Math.min(n + m, MAX_EDIT);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[s + x] === b[s + y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, offset, s);
    }
  }
  throw new HttpError(413, 'TOO_DIFFERENT', 'Fichiers trop différents pour être comparés ligne à ligne');
}

function backtrack(trace, dEnd, n, m, offset, s) {
  const out = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; out.push({ op: '=', a: s + x, b: s + y }); }
    if (x === prevX) { y--; out.push({ op: '+', b: s + y }); } else { x--; out.push({ op: '-', a: s + x }); }
  }
  while (x > 0 && y > 0) { x--; y--; out.push({ op: '=', a: s + x, b: s + y }); }
  return out.reverse();
}

const clip = (t) => (t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}…` : t);

/**
 * Mise en page « côte à côte » : lignes { k: '=' | '-' | '+' | '~' | '…', a, b, n }.
 *   '=' identique, '-' seulement dans A, '+' seulement dans B, '~' modifiée (A et B), '…' bloc identique replié (n lignes).
 * `shownA` / `shownB` : texte à afficher (éventuellement masqué), même longueur que les lignes comparées.
 */
export function sideBySide(a, b, { shownA = a, shownB = b, context = 3 } = {}) {
  const ops = diffOps(a, b);
  const raw = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i].op === '=') { raw.push({ k: '=', a: clip(shownA[ops[i].a]), b: clip(shownB[ops[i].b]) }); i++; continue; }
    const dels = [];
    const adds = [];
    while (i < ops.length && ops[i].op !== '=') { (ops[i].op === '-' ? dels : adds).push(ops[i]); i++; }
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) raw.push({ k: '~', a: clip(shownA[dels[p].a]), b: clip(shownB[adds[p].b]) });
    for (let p = pairs; p < dels.length; p++) raw.push({ k: '-', a: clip(shownA[dels[p].a]) });
    for (let p = pairs; p < adds.length; p++) raw.push({ k: '+', b: clip(shownB[adds[p].b]) });
  }
  const changed = raw.filter((r) => r.k !== '=').length;
  // Repli des blocs identiques : on garde `context` lignes autour de chaque différence.
  const rows = [];
  for (let i = 0; i < raw.length;) {
    if (raw[i].k !== '=') { rows.push(raw[i++]); continue; }
    let j = i;
    while (j < raw.length && raw[j].k === '=') j++;
    const run = j - i;
    const head = i === 0 ? 0 : context;
    const tail = j === raw.length ? 0 : context;
    if (run > head + tail + 1) {
      for (let p = 0; p < head; p++) rows.push(raw[i + p]);
      rows.push({ k: '…', n: run - head - tail });
      for (let p = j - tail; p < j; p++) rows.push(raw[p]);
    } else {
      for (let p = i; p < j; p++) rows.push(raw[p]);
    }
    i = j;
  }
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS, changed, identical: changed === 0 };
}

// ---------- Masquage des valeurs sensibles ----------
const SENSITIVE_KEY = /(pass(?:word|wd|phrase)?|secret|token|api[-_ ]?key|private[-_ ]?key|credential|auth[-_ ]?key|\bkey\b|[-_]key\b)/i;
// Un réglage « PasswordAuthentication no » n'est pas un secret : on garde les valeurs de type interrupteur.
const HARMLESS_VALUE = /^(yes|no|true|false|on|off|enabled?|disabled?|none|null|0|1|prohibit-password|without-password|forced-commands-only|ask|auto|default)$/i;
const BEGIN_KEY = /-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|SECRET)[A-Z0-9 ]*-----/;
const END_KEY = /-----END [A-Z0-9 ]*-----/;
export const MASK = '••••••';

/** Remplace la valeur des lignes sensibles (mot de passe, jeton, clé privée…) ; la comparaison reste faite sur le vrai texte. */
export function maskLines(lines) {
  const out = [];
  let inKey = false;
  for (const line of lines) {
    if (inKey) { out.push(MASK); if (END_KEY.test(line)) inKey = false; continue; }
    if (BEGIN_KEY.test(line)) { out.push(MASK); if (!END_KEY.test(line.replace(BEGIN_KEY, ''))) inKey = true; continue; }
    out.push(maskLine(line));
  }
  return out;
}

function maskLine(line) {
  const t = line.trimStart();
  if (!t || t.startsWith('#') || t.startsWith(';') || t.startsWith('//')) return line;
  // « clé = valeur », « clé: valeur », « clé valeur », « export CLE=valeur »
  const m = /^(\s*(?:export\s+)?)([A-Za-z0-9_.\-[\]"]+)(\s*[=:]\s*|\s+)(.+)$/.exec(line);
  if (!m) return line;
  const [, lead, key, sep, rest] = m;
  if (!SENSITIVE_KEY.test(key)) return line;
  const value = rest.trim().replace(/^["']|["']$/g, '');
  if (HARMLESS_VALUE.test(value)) return line;
  return `${lead}${key}${sep}${MASK}`;
}
