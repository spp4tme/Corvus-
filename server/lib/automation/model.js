// Définition d'un playbook : validation, normalisation et niveau de risque. Module PUR (aucune dépendance au serveur HTTP ni à la base ;
// seul `risk.js`, lui aussi pur, est importé).
//
// Un playbook est un script NOMMÉ qui s'exécute SUR L'HÔTE CIBLE par SSH (jamais dans le processus Corvus) :
//   { name, description, params: [définitions], steps: [étapes], targets: { hostIds, groups }, strategy: { hosts, maxParallel }, autoAutorise }
// Étape : { name, run: '<commande>', timeoutSec?, continueOnError? }
//      ou { name, agent: { action, args? } }            (action NOMMÉE de l'agent : jamais une nouvelle action)
//      ou { name, parallel: [ { name, run }, … ] }       (commandes simultanées sur le MÊME hôte, concurrence bornée)
import { analyze } from '../risk.js';
import { validateDefs, scanTemplate, PlaybookError } from './params.js';

export const LIMITS = Object.freeze({
  maxSteps: 50, maxParallelGroup: 8, maxCommandChars: 8192, maxHostsPerPlaybook: 200, maxGroups: 20,
  defaultTimeoutSec: 300, maxTimeoutSec: 3600, maxDescription: 500,
});

/** Actions d'agent qu'un playbook peut appeler (nommées, existantes) → niveau de risque. Un playbook n'en crée jamais de nouvelle. */
export const AGENT_ACTIONS = Object.freeze({
  'xray.live': 'safe', 'net.status': 'safe', 'preview.run': 'safe', 'net.release': 'caution', 'net.isolate': 'danger',
});

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const ID_RE = /^[a-z0-9]{8,32}$/i;
const LEVELS = ['safe', 'caution', 'danger'];
const bad = (m) => new PlaybookError(m);

const maxLevel = (a, b) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

function checkText(value, what, max) {
  if (typeof value !== 'string') throw bad(`${what} : texte attendu`);
  if (value.length > max) throw bad(`${what} : ${max} caractères au maximum`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw bad(`${what} : caractères de contrôle interdits`);
  return value;
}

/** Niveau de risque d'un modèle de commande : les marqueurs sont remplacés par des valeurs inoffensives avant l'analyse. */
export function commandRisk(template) {
  const neutral = template.replace(/\{\{\s*secret\.[A-Z0-9_]+\s*\}\}/g, '"$S"').replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, "'x'");
  const a = analyze(neutral);
  return { level: a.level, reasons: a.reasons, sudo: a.sudo, dynamic: a.dynamic };
}

// Types de paramètres que celui qui LANCE le playbook peut remplir librement : jamais combinés à un secret dans la même commande.
const FREE_TYPES = new Set(['string', 'path', 'host']);

function validateRunStep(raw, where, defs, used) {
  const paramNames = defs.map((d) => d.name);
  const command = checkText(raw.run, `${where} : commande`, LIMITS.maxCommandChars);
  if (!command.trim()) throw bad(`${where} : commande vide`);
  const { params, secrets } = scanTemplate(command, { allowedParams: paramNames, label: where });
  // AUDIT 1.3, point 1 (haute) : `curl -H {{secret.TOKEN}} {{url}}` — l'opérateur qui lance le playbook choisissait l'URL, donc la destination
  // du secret. Une commande qui porte un secret n'accepte aucun paramètre libre ; seuls restent possibles ceux que l'administrateur a bornés
  // d'avance (liste de choix, entier).
  if (secrets.length) {
    const libre = params.find((n) => FREE_TYPES.has(defs.find((d) => d.name.toLowerCase() === n.toLowerCase())?.type));
    if (libre) {
      throw bad(`${where} : le secret « ${secrets[0]} » ne peut pas être utilisé dans une commande qui contient le paramètre libre « ${libre} » (texte, chemin ou hôte) : celui qui lance le playbook pourrait envoyer le secret où il veut. Mettez ce paramètre dans une autre commande, ou faites-en une liste de choix.`);
    }
  }
  params.forEach((p) => used.params.add(p));
  secrets.forEach((s) => used.secrets.add(s));
  const risk = commandRisk(command);
  const timeoutSec = raw.timeoutSec === undefined ? LIMITS.defaultTimeoutSec : raw.timeoutSec;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > LIMITS.maxTimeoutSec) throw bad(`${where} : délai entre 1 et ${LIMITS.maxTimeoutSec} s`);
  if (raw.continueOnError !== undefined && typeof raw.continueOnError !== 'boolean') throw bad(`${where} : continueOnError doit être un booléen`);
  return { step: { name: '', run: command, timeoutSec, continueOnError: raw.continueOnError === true }, risk };
}

/**
 * Valide et normalise un playbook. Les champs inconnus sont REFUSÉS (jamais ignorés en silence). Le risque est CALCULÉ ici, jamais fourni.
 * @returns {{ name, description, definition: object, risk: 'safe'|'caution'|'danger', riskReasons: string[], autoAutorise: boolean, secrets: string[] }}
 */
export function validatePlaybook(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Playbook : objet attendu');
  const allowed = new Set(['name', 'description', 'params', 'steps', 'targets', 'strategy', 'autoAutorise', 'resume']);
  for (const k of Object.keys(input)) if (!allowed.has(k)) throw bad(`Champ inconnu : « ${String(k).slice(0, 40)} »`);
  if (input.resume !== undefined && input.resume !== false) throw bad('La reprise après échec n\'existe pas : elle est désactivée (resume doit rester faux)');

  if (typeof input.name !== 'string' || !NAME_RE.test(input.name.trim())) throw bad('Nom invalide (lettres, chiffres, espaces, « . _ - », 64 caractères au maximum, commence par une lettre ou un chiffre)');
  const name = input.name.trim();
  const description = input.description === undefined ? '' : checkText(input.description, 'Description', LIMITS.maxDescription);
  if (input.autoAutorise !== undefined && typeof input.autoAutorise !== 'boolean') throw bad('autoAutorise doit être un booléen');

  const params = validateDefs(input.params);
  const paramNames = params.map((p) => p.name);

  if (!Array.isArray(input.steps) || !input.steps.length) throw bad('Au moins une étape est requise');
  const used = { params: new Set(), secrets: new Set() };
  let risk = 'safe';
  const reasons = [];
  let count = 0;
  const note = (r) => { risk = maxLevel(risk, r.level); for (const why of r.reasons || []) if (!reasons.includes(why)) reasons.push(why); };

  const steps = input.steps.map((raw, i) => {
    const where = `Étape ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad(`${where} : objet attendu`);
    const stepName = raw.name === undefined ? `étape ${i + 1}` : checkText(raw.name, `${where} : nom`, 80).trim() || `étape ${i + 1}`;
    const kinds = ['run', 'agent', 'parallel'].filter((k) => raw[k] !== undefined);
    if (kinds.length !== 1) throw bad(`${where} : exactement une des clés « run », « agent » ou « parallel » est requise`);
    const unknown = Object.keys(raw).filter((k) => !['name', 'run', 'agent', 'parallel', 'timeoutSec', 'continueOnError'].includes(k));
    if (unknown.length) throw bad(`${where} : champ inconnu « ${String(unknown[0]).slice(0, 40)} »`);
    count += 1;

    if (kinds[0] === 'run') {
      const { step, risk: r } = validateRunStep(raw, where, params, used);
      note(r);
      return { ...step, name: stepName };
    }
    if (kinds[0] === 'agent') {
      const a = raw.agent;
      if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad(`${where} : « agent » doit être un objet { action, args? }`);
      if (typeof a.action !== 'string' || !Object.hasOwn(AGENT_ACTIONS, a.action)) {
        throw bad(`${where} : action d'agent inconnue (autorisées : ${Object.keys(AGENT_ACTIONS).join(', ')} ; un playbook ne crée pas de nouvelle action)`);
      }
      const args = a.args === undefined ? {} : a.args;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw bad(`${where} : args doit être un objet`);
      for (const [k, v] of Object.entries(args)) {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(k)) throw bad(`${where} : nom d'argument invalide`);
        if (!(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) throw bad(`${where} : argument « ${k} » : texte, nombre ou booléen attendu`);
        if (typeof v === 'string') checkText(v, `${where} : argument « ${k} »`, 300);
      }
      if (JSON.stringify(args).length > 1024) throw bad(`${where} : arguments trop gros`);
      note({ level: AGENT_ACTIONS[a.action], reasons: AGENT_ACTIONS[a.action] === 'danger' ? [`action d'agent « ${a.action} » (coupe le réseau de l'hôte)`] : [] });
      const timeoutSec = raw.timeoutSec === undefined ? 60 : raw.timeoutSec;
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) throw bad(`${where} : délai entre 1 et 600 s`);
      return { name: stepName, agent: { action: a.action, args }, timeoutSec, continueOnError: raw.continueOnError === true };
    }
    // parallel
    const group = raw.parallel;
    if (!Array.isArray(group) || group.length < 2 || group.length > LIMITS.maxParallelGroup) throw bad(`${where} : « parallel » attend 2 à ${LIMITS.maxParallelGroup} commandes`);
    const sub = group.map((s, j) => {
      const w = `${where}.${j + 1}`;
      if (!s || typeof s !== 'object' || Array.isArray(s) || s.run === undefined) throw bad(`${w} : { run } attendu`);
      const extra = Object.keys(s).filter((k) => !['name', 'run', 'timeoutSec', 'continueOnError'].includes(k));
      if (extra.length) throw bad(`${w} : champ inconnu « ${String(extra[0]).slice(0, 40)} »`);
      const { step, risk: r } = validateRunStep(s, w, params, used);
      note(r);
      count += 1;
      return { ...step, name: s.name === undefined ? `${stepName}.${j + 1}` : checkText(s.name, `${w} : nom`, 80).trim() };
    });
    return { name: stepName, parallel: sub, continueOnError: raw.continueOnError === true };
  });
  if (count > LIMITS.maxSteps) throw bad(`Trop d'étapes (maximum ${LIMITS.maxSteps}, étapes parallèles comprises)`);

  // Un paramètre déclaré mais jamais utilisé n'est pas une erreur (il peut servir de contexte) ; un paramètre « host » doit avoir des cibles.
  const t = input.targets;
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad('Cibles : objet { hostIds, groups } attendu');
  for (const k of Object.keys(t)) if (!['hostIds', 'groups'].includes(k)) throw bad(`Cibles : champ inconnu « ${String(k).slice(0, 40)} »`);
  if (!Array.isArray(t.hostIds ?? [])) throw bad('Cibles : hostIds doit être une liste');
  if (!Array.isArray(t.groups ?? [])) throw bad('Cibles : groups doit être une liste');
  if ((t.hostIds ?? []).length > LIMITS.maxHostsPerPlaybook * 2 || (t.groups ?? []).length > LIMITS.maxGroups * 2) throw bad('Cibles : listes trop longues');
  const hostIds = [...new Set((t.hostIds ?? []).map((h) => {
    if (typeof h !== 'string' || !ID_RE.test(h)) throw bad('Cibles : identifiant d\'hôte invalide');
    return h;
  }))];
  const groups = [...new Set((t.groups ?? []).map((g) => {
    if (typeof g !== 'string' || !g.trim() || g.length > 48 || /[\u0000-\u001f\u007f]/.test(g)) throw bad('Cibles : nom de groupe invalide');
    return g.trim();
  }))];
  if (hostIds.length > LIMITS.maxHostsPerPlaybook) throw bad(`Trop d'hôtes cibles (maximum ${LIMITS.maxHostsPerPlaybook})`);
  if (groups.length > LIMITS.maxGroups) throw bad(`Trop de groupes cibles (maximum ${LIMITS.maxGroups})`);
  if (!hostIds.length && !groups.length) throw bad('Au moins un hôte ou un groupe cible est requis');

  const s = input.strategy ?? {};
  if (typeof s !== 'object' || Array.isArray(s)) throw bad('Stratégie : objet attendu');
  for (const k of Object.keys(s)) if (!['hosts', 'maxParallel'].includes(k)) throw bad(`Stratégie : champ inconnu « ${String(k).slice(0, 40)} »`);
  const hostsMode = s.hosts ?? 'sequential';
  if (!['sequential', 'parallel'].includes(hostsMode)) throw bad('Stratégie : hosts vaut « sequential » ou « parallel »');
  const maxParallel = s.maxParallel ?? 3;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) throw bad('Stratégie : maxParallel entre 1 et 10');

  return {
    name, description, risk, riskReasons: reasons, autoAutorise: input.autoAutorise === true, secrets: [...used.secrets].sort(),
    definition: { params, steps, targets: { hostIds, groups }, strategy: { hosts: hostsMode, maxParallel } },
  };
}

/** Nombre total de commandes (étapes parallèles comprises). */
export function countSteps(steps) {
  return steps.reduce((n, s) => n + (s.parallel ? s.parallel.length : 1), 0);
}
