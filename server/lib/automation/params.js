// Paramètres d'un playbook : types validés, et injection ÉCHAPPÉE dans le modèle de commande. Module PUR (aucune dépendance au serveur
// HTTP, ni à Node hors `Error`) : il doit pouvoir être porté tel quel (réécriture Rust envisagée).
//
// Règle d'or : un paramètre n'est jamais « concaténé ». Il est remplacé par sa forme entre quotes simples POSIX, et le modèle est
// REFUSÉ à l'enregistrement si un paramètre se trouverait dans un contexte où ces quotes changeraient de sens (entre quotes, dans un
// heredoc, dans des backticks, dans un commentaire) : sinon `echo '{{x}}'` avec x = a'; rm -rf / ; ' sortirait de ses quotes.

export class PlaybookError extends Error {
  constructor(message, code = 'INVALID') { super(message); this.name = 'PlaybookError'; this.code = code; }
}

export const PARAM_TYPES = ['string', 'int', 'choice', 'host', 'path'];
export const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/i;
export const SECRET_RE = /^[A-Z][A-Z0-9_]{1,31}$/;
const MAX_PARAMS = 20;
const CONTROL = /[\u0000-\u001f\u007f]/; // NUL, retours à la ligne, tabulations, échappements : jamais dans un paramètre

const bad = (m) => new PlaybookError(m);

/** Quotes simples POSIX : 'a'\''b'. */
export function quote(value) {
  const s = String(value);
  if (s.includes('\0')) throw bad('NUL interdit dans un argument shell');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Valide les DÉFINITIONS de paramètres d'un playbook. Retourne une copie normalisée. */
export function validateDefs(defs) {
  if (defs === undefined || defs === null) return [];
  if (!Array.isArray(defs)) throw bad('Paramètres : liste attendue');
  if (defs.length > MAX_PARAMS) throw bad(`Trop de paramètres (maximum ${MAX_PARAMS})`);
  const seen = new Set();
  return defs.map((d, i) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad(`Paramètre ${i + 1} : objet attendu`);
    if (typeof d.name !== 'string' || !NAME_RE.test(d.name)) throw bad(`Paramètre ${i + 1} : nom invalide (lettres, chiffres, « _ », 32 caractères max)`);
    const key = d.name.toLowerCase();
    if (seen.has(key)) throw bad(`Paramètre « ${d.name} » en double`);
    seen.add(key);
    if (!PARAM_TYPES.includes(d.type)) throw bad(`Paramètre « ${d.name} » : type inconnu (${PARAM_TYPES.join(', ')})`);
    const out = { name: d.name, type: d.type, required: d.required !== false };
    if (d.label !== undefined) {
      if (typeof d.label !== 'string' || d.label.length > 100 || CONTROL.test(d.label)) throw bad(`Paramètre « ${d.name} » : libellé invalide`);
      out.label = d.label;
    }
    if (d.type === 'string') out.max = intIn(d.max ?? 256, 1, 4096, `${d.name}.max`);
    if (d.type === 'path') out.max = intIn(d.max ?? 1024, 1, 4096, `${d.name}.max`);
    if (d.type === 'int') {
      out.min = intIn(d.min ?? 0, -1_000_000_000, 1_000_000_000, `${d.name}.min`);
      out.max = intIn(d.max ?? 1_000_000, -1_000_000_000, 1_000_000_000, `${d.name}.max`);
      if (out.min > out.max) throw bad(`Paramètre « ${d.name} » : min > max`);
    }
    if (d.type === 'choice') {
      if (!Array.isArray(d.choices) || !d.choices.length || d.choices.length > 50) throw bad(`Paramètre « ${d.name} » : 1 à 50 choix attendus`);
      out.choices = d.choices.map((c) => {
        if (typeof c !== 'string' || !c || c.length > 64 || CONTROL.test(c)) throw bad(`Paramètre « ${d.name} » : choix invalide`);
        return c;
      });
      if (new Set(out.choices).size !== out.choices.length) throw bad(`Paramètre « ${d.name} » : choix en double`);
    }
    if (d.default !== undefined) out.default = coerceOne(out, d.default, { hostIds: null }); // la valeur par défaut doit être valide
    return out;
  });
}

function intIn(v, min, max, what) {
  if (!Number.isInteger(v) || v < min || v > max) throw bad(`${what} : entier entre ${min} et ${max} attendu`);
  return v;
}

/** Valide UNE valeur selon sa définition. `hostIds` : hôtes autorisés pour un paramètre « host » (null = pas de contrôle, définitions seulement). */
function coerceOne(def, raw, { hostIds }) {
  const name = def.name;
  switch (def.type) {
    case 'string': {
      if (typeof raw !== 'string') throw bad(`« ${name} » : chaîne attendue`);
      if (raw.length > def.max) throw bad(`« ${name} » : ${def.max} caractères au maximum`);
      if (CONTROL.test(raw)) throw bad(`« ${name} » : caractères de contrôle interdits`);
      return raw;
    }
    case 'int': {
      const n = typeof raw === 'string' && /^-?\d{1,12}$/.test(raw) ? Number(raw) : raw;
      if (!Number.isInteger(n) || n < def.min || n > def.max) throw bad(`« ${name} » : entier entre ${def.min} et ${def.max} attendu`);
      return n;
    }
    case 'choice': {
      if (typeof raw !== 'string' || !def.choices.includes(raw)) throw bad(`« ${name} » : valeur hors de la liste (${def.choices.join(', ')})`);
      return raw;
    }
    case 'host': {
      if (typeof raw !== 'string' || !/^[a-z0-9]{8,32}$/i.test(raw)) throw bad(`« ${name} » : identifiant d'hôte invalide`);
      if (hostIds && !hostIds.includes(raw)) throw bad(`« ${name} » : hôte non autorisé pour ce playbook`);
      return raw;
    }
    case 'path': {
      if (typeof raw !== 'string' || !raw) throw bad(`« ${name} » : chemin attendu`);
      if (raw.length > def.max) throw bad(`« ${name} » : ${def.max} caractères au maximum`);
      if (CONTROL.test(raw)) throw bad(`« ${name} » : caractères de contrôle interdits`);
      if (!(raw === '~' || raw.startsWith('/') || raw.startsWith('~/'))) throw bad(`« ${name} » : chemin absolu (ou commençant par ~/) attendu`);
      if (raw.split('/').includes('..')) throw bad(`« ${name} » : « .. » interdit dans un chemin`);
      return raw;
    }
    default: throw bad(`« ${name} » : type inconnu`);
  }
}

/**
 * Valide les valeurs fournies pour un lancement. Inconnu → refusé ; manquant sans défaut → refusé.
 * @returns {{[name: string]: string|number}}
 */
export function coerceValues(defs, input, { hostIds = null } = {}) {
  const given = input === undefined || input === null ? {} : input;
  if (typeof given !== 'object' || Array.isArray(given)) throw bad('Valeurs des paramètres : objet attendu');
  const known = new Map(defs.map((d) => [d.name.toLowerCase(), d]));
  for (const k of Object.keys(given)) if (!known.has(k.toLowerCase())) throw bad(`Paramètre inconnu : « ${String(k).slice(0, 40)} »`);
  const out = {};
  for (const d of defs) {
    const key = Object.keys(given).find((k) => k.toLowerCase() === d.name.toLowerCase());
    if (key === undefined || given[key] === '' || given[key] === null) {
      if (d.default !== undefined) { out[d.name] = d.default; continue; }
      if (d.required) throw bad(`Paramètre « ${d.name} » requis`);
      continue;
    }
    out[d.name] = coerceOne(d, given[key], { hostIds });
  }
  return out;
}

// --- Modèles de commande ------------------------------------------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]{1,70})\s*\}\}/g;

/**
 * Parcourt un script POSIX et donne, pour chaque position, le contexte de quotes. Volontairement CONSERVATEUR : en cas de doute on refuse.
 * Contextes : 'none' (mot nu), 'double', 'single', 'heredoc', 'comment', 'backtick'. `$( … )` ouvre un contexte neuf, empilé.
 * @returns {{ at: number, ctx: string }[]} contexte à chaque `{{…}}` trouvé (dans l'ordre)
 */
function contexts(template) {
  const found = [];
  const stack = []; // contextes englobants (pile pour $( ))
  let ctx = 'none';
  let i = 0;
  const s = template;
  const atWordStart = (k) => k === 0 || /[\s;|&(]/.test(s[k - 1]);
  while (i < s.length) {
    const c = s[i];
    if (c === '{' && s[i + 1] === '{') {
      const m = /^\{\{\s*[A-Za-z0-9_.]{1,70}\s*\}\}/.exec(s.slice(i));
      if (m) { found.push({ at: i, ctx }); i += m[0].length; continue; }
    }
    if (ctx === 'comment') { if (c === '\n') ctx = stack.length ? 'none' : 'none'; i += 1; continue; }
    if (ctx === 'single') { if (c === "'") ctx = stack.pop() ?? 'none'; i += 1; continue; }
    if (ctx === 'backtick') { if (c === '`') ctx = stack.pop() ?? 'none'; else if (c === '\\') i += 1; i += 1; continue; }
    // none ou double
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { stack.push(ctx); ctx = 'backtick'; i += 1; continue; }
    if (c === '$' && s[i + 1] === '(') { stack.push(ctx); ctx = 'none'; i += 2; if (s[i] === '(') i += 1; continue; }
    if (c === ')' && ctx === 'none' && stack.length) { ctx = stack.pop(); i += 1; continue; }
    if (ctx === 'double') { if (c === '"') ctx = 'none'; i += 1; continue; }
    if (c === "'") { stack.push(ctx); ctx = 'single'; i += 1; continue; }
    if (c === '"') { ctx = 'double'; i += 1; continue; }
    if (c === '#' && atWordStart(i)) { ctx = 'comment'; i += 1; continue; }
    i += 1;
  }
  return found;
}

/**
 * Analyse un modèle de commande : liste des paramètres et des secrets référencés, et REFUS de tout contexte dangereux.
 * @returns {{ params: string[], secrets: string[] }}
 */
export function scanTemplate(template, { allowedParams, label = 'commande' } = {}) {
  if (typeof template !== 'string') throw bad(`${label} : texte attendu`);
  if (template.includes('\0')) throw bad(`${label} : NUL interdit`);
  const params = new Set();
  const secrets = new Set();
  const names = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);
  // Syntaxe `{{` restante qui n'est pas un marqueur valide : refusée (jamais ignorée en silence).
  const stripped = template.replace(PLACEHOLDER, '');
  if (/\{\{/.test(stripped) && /\}\}/.test(stripped)) throw bad(`${label} : marqueur « {{ }} » invalide`);
  if (!names.length) return { params: [], secrets: [] };
  if (/<<-?\s*["']?\w/.test(template)) throw bad(`${label} : un heredoc (<<) est interdit dans une commande qui contient des paramètres ou des secrets`);
  const ctxs = contexts(template);
  if (ctxs.length !== names.length) throw bad(`${label} : marqueur « {{ }} » mal placé`);
  names.forEach((n, k) => {
    const where = ctxs[k].ctx;
    if (n.startsWith('secret.')) {
      const sn = n.slice(7);
      if (!SECRET_RE.test(sn)) throw bad(`${label} : nom de secret invalide « ${n.slice(0, 40)} »`);
      if (where !== 'none' && where !== 'double') throw bad(`${label} : le secret « ${sn} » ne peut pas se trouver entre quotes simples, dans un backtick ou un commentaire`);
      secrets.add(sn);
      return;
    }
    if (!NAME_RE.test(n)) throw bad(`${label} : nom de paramètre invalide « ${n.slice(0, 40)} »`);
    if (allowedParams && !allowedParams.some((p) => p.toLowerCase() === n.toLowerCase())) throw bad(`${label} : paramètre « ${n} » non déclaré`);
    if (where !== 'none') {
      throw bad(`${label} : le paramètre « ${n} » ne doit pas être placé entre quotes, dans un backtick ou un commentaire (Corvus l'entoure déjà de quotes : écrivez {{${n}}} nu)`);
    }
    params.add(n);
  });
  return { params: [...params], secrets: [...secrets] };
}

/** Variable d'environnement qui porte un secret dans la commande distante (jamais sa valeur). */
export const secretEnv = (name) => `CORVUS_SECRET_${name}`;

/**
 * Rend le modèle : paramètres → valeur ENTRE QUOTES ; secrets → référence `$CORVUS_SECRET_X` (la valeur voyage sur l'entrée standard,
 * jamais dans la ligne de commande, donc jamais visible dans `ps` sur l'hôte).
 */
export function render(template, defs, values) {
  const byName = new Map(defs.map((d) => [d.name.toLowerCase(), d]));
  const ctxs = contexts(template);
  let k = 0;
  return template.replace(PLACEHOLDER, (_m, n) => {
    const where = ctxs[k++]?.ctx;
    if (n.startsWith('secret.')) {
      const ref = secretEnv(n.slice(7));
      return where === 'double' ? `\${${ref}}` : `"\${${ref}}"`;
    }
    const d = byName.get(n.toLowerCase());
    if (!d) throw bad(`Paramètre « ${n} » non déclaré`);
    if (!(d.name in values)) {
      if (d.required) throw bad(`Paramètre « ${d.name} » sans valeur`);
      return "''";
    }
    return quote(values[d.name]);
  });
}
