// Service d'automatisation : playbooks versionnés, secrets nommés, interrupteur général. Les exécutions sont dans runs.js, la
// planification dans scheduler.js, les déclencheurs dans triggers.js.
//
// PRINCIPES (voir docs / wiki « Playbooks ») :
//  - TOUT est désactivé par défaut : `automation.enabled` est faux tant qu'un administrateur ne l'a pas activé (et chaque changement est journalisé) ;
//  - un playbook s'exécute SUR L'HÔTE CIBLE par SSH, jamais dans le processus Corvus ;
//  - un playbook ne cible que des hôtes POSIX avec accès SSH : refus à la création ET à l'exécution (l'OS peut changer) ;
//  - aucune valeur de secret dans le journal, la base, les erreurs ou les réponses d'API.
import crypto from 'node:crypto';
import { HttpError } from '../validate.js';
import { effectiveOs } from '../hostos.js';
import { lineDiff } from '../rewind.js';
import { validatePlaybook, LIMITS } from './model.js';
import { PlaybookError, SECRET_RE } from './params.js';
import { checkSecretValue } from './mask.js';

const newId = () => crypto.randomBytes(8).toString('hex');
const SECRETS_KEY = 'automation:secrets';
const MAX_SECRETS = 50;
const MAX_PLAYBOOKS = 200;

/** Une erreur de validation du modèle devient une réponse 400 ; le reste remonte tel quel. */
export function asHttp(err) {
  if (err instanceof PlaybookError) return new HttpError(400, 'INVALID_PLAYBOOK', err.message);
  return err;
}

export class AutomationService {
  constructor({ db, hosts, vault, journal, agents = null, alerts = null }) {
    Object.assign(this, { db, hosts, vault, journal, agents, alerts });
  }

  // --- Interrupteur général ---------------------------------------------------------------------------------------------------

  get enabled() { return this.db.getMeta('automation.enabled', false) === true; }

  setEnabled(on, { user, ip } = {}) {
    if (typeof on !== 'boolean') throw new HttpError(400, 'INVALID', 'enabled doit être un booléen');
    const before = this.enabled;
    this.db.setMeta('automation.enabled', on);
    this.journal.add({ type: 'automation', event: on ? 'enabled' : 'disabled', user, ip, ok: true, detail: `interrupteur général : ${before ? 'actif' : 'désactivé'} → ${on ? 'actif' : 'désactivé'}` });
    if (!on) this.onDisabled?.(); // arrête aussi les exécutions en cours (branché par runs.js)
    return this.enabled;
  }

  // --- Cibles -----------------------------------------------------------------------------------------------------------------

  /** Hôtes visés : ceux listés, plus les membres des groupes (résolus à chaque appel). Les hôtes supprimés disparaissent. */
  resolveTargets(def) {
    const all = this.hosts.hosts;
    const ids = new Set(def.targets.hostIds);
    const groups = new Set(def.targets.groups.map((g) => g.toLowerCase()));
    return all.filter((h) => ids.has(h.id) || (h.group && groups.has(h.group.toLowerCase())));
  }

  /** Système de l'hôte : réglage / détection SSH, sinon plateforme annoncée par l'agent. */
  hostOs(host) {
    const o = effectiveOs(host);
    if (o) return o;
    const p = this.agents?.forHost?.(host.id)?.platform;
    return p === 'windows' ? 'windows' : null;
  }

  /**
   * Refuse les cibles qui ne conviennent pas à un playbook : Windows (les commandes sont POSIX), et, si le playbook contient des
   * commandes (`run`), les hôtes « agent seul » (aucun accès SSH). Appelé à la création ET à chaque exécution.
   */
  assertTargetsUsable(def, hosts = this.resolveTargets(def)) {
    const needsSsh = def.steps.some((s) => s.run !== undefined || s.parallel !== undefined);
    for (const h of hosts) {
      if (this.hostOs(h) === 'windows') {
        throw new HttpError(409, 'POSIX_ONLY', `« ${h.name} » est un hôte Windows : un playbook ne cible que des hôtes POSIX (ses commandes sont POSIX).`);
      }
      if (needsSsh && h.authType === 'none') {
        throw new HttpError(409, 'AGENT_ONLY', `« ${h.name} » est un hôte « agent seul » (aucun accès SSH) : il ne peut pas recevoir de commandes.`);
      }
    }
    return hosts;
  }

  /** Unicité du nom sans tenir compte de la casse, accents compris (le NOCASE de SQLite ne replie que l'ASCII). */
  #nameTaken(name, exceptId = null) {
    const key = name.toLocaleLowerCase('fr');
    return this.db.all('SELECT id, name FROM playbooks').some((r) => r.id !== exceptId && r.name.toLocaleLowerCase('fr') === key);
  }

  #checkHostsExist(def) {
    for (const id of def.targets.hostIds) if (!this.hosts.find(id)) throw new HttpError(400, 'INVALID_PLAYBOOK', 'Cible inconnue : un des hôtes n\'existe pas');
  }

  // --- Playbooks --------------------------------------------------------------------------------------------------------------

  #view(r, { full = true } = {}) {
    if (!r) return null;
    const definition = JSON.parse(r.definition);
    const out = {
      id: r.id, name: r.name, description: r.description, version: r.version, risk: r.risk, autoAutorise: !!r.auto_authorized,
      createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
      steps: definition.steps.reduce((n, s) => n + (s.parallel ? s.parallel.length : 1), 0), targets: definition.targets,
    };
    if (full) Object.assign(out, { params: definition.params, strategy: definition.strategy, stepsDetail: definition.steps });
    return out;
  }

  list() {
    return this.db.all('SELECT * FROM playbooks ORDER BY name COLLATE NOCASE').map((r) => this.#view(r, { full: false }));
  }

  find(id) { return this.#view(this.db.get('SELECT * FROM playbooks WHERE id = ?', id)); }

  get(id) {
    const p = this.find(id);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Playbook introuvable');
    return p;
  }

  /** Définition complète telle que stockée (pour l'exécuteur). */
  definitionOf(id) {
    const r = this.db.get('SELECT * FROM playbooks WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Playbook introuvable');
    return { ...JSON.parse(r.definition), id: r.id, name: r.name, version: r.version, risk: r.risk, autoAutorise: !!r.auto_authorized };
  }

  create(input, { user, ip } = {}) {
    let v;
    try { v = validatePlaybook(input); } catch (err) { throw asHttp(err); }
    this.#checkHostsExist(v.definition);
    this.assertTargetsUsable(v.definition);
    if (this.db.get('SELECT COUNT(*) AS n FROM playbooks').n >= MAX_PLAYBOOKS) throw new HttpError(409, 'LIMIT', `Trop de playbooks (maximum ${MAX_PLAYBOOKS})`);
    if (this.#nameTaken(v.name)) throw new HttpError(409, 'CONFLICT', 'Un playbook porte déjà ce nom');
    const id = newId();
    const now = Date.now();
    this.db.tx(() => {
      this.db.run('INSERT INTO playbooks (id, name, description, version, definition, risk, auto_authorized, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
        id, v.name, v.description, JSON.stringify(v.definition), v.risk, v.autoAutorise ? 1 : 0, user?.username ?? null, now, now);
      this.db.run('INSERT INTO playbook_versions (playbook_id, version, name, description, definition, risk, auto_authorized, author, ts) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)',
        id, v.name, v.description, JSON.stringify(v.definition), v.risk, v.autoAutorise ? 1 : 0, user?.username ?? null, now);
    });
    this.journal.add({ type: 'automation', event: 'playbook-create', user, ip, ok: true, detail: `${v.name} (risque ${v.risk}${v.autoAutorise ? ', auto-autorisé' : ''})` });
    return this.get(id);
  }

  update(id, input, { user, ip } = {}) {
    const cur = this.db.get('SELECT * FROM playbooks WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Playbook introuvable');
    let v;
    try { v = validatePlaybook(input); } catch (err) { throw asHttp(err); }
    this.#checkHostsExist(v.definition);
    this.assertTargetsUsable(v.definition);
    if (this.#nameTaken(v.name, id)) throw new HttpError(409, 'CONFLICT', 'Un playbook porte déjà ce nom');
    const version = cur.version + 1;
    const now = Date.now();
    this.db.tx(() => {
      this.db.run('UPDATE playbooks SET name = ?, description = ?, version = ?, definition = ?, risk = ?, auto_authorized = ?, updated_at = ? WHERE id = ?',
        v.name, v.description, version, JSON.stringify(v.definition), v.risk, v.autoAutorise ? 1 : 0, now, id);
      this.db.run('INSERT INTO playbook_versions (playbook_id, version, name, description, definition, risk, auto_authorized, author, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, version, v.name, v.description, JSON.stringify(v.definition), v.risk, v.autoAutorise ? 1 : 0, user?.username ?? null, now);
    });
    this.journal.add({ type: 'automation', event: 'playbook-update', user, ip, ok: true, detail: `${v.name} v${cur.version} → v${version} (risque ${v.risk}${v.autoAutorise ? ', auto-autorisé' : ''})` });
    return this.get(id);
  }

  delete(id, { user, ip } = {}) {
    const cur = this.db.get('SELECT * FROM playbooks WHERE id = ?', id);
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Playbook introuvable');
    this.db.tx(() => {
      this.db.run('DELETE FROM playbooks WHERE id = ?', id);
      this.db.run('DELETE FROM playbook_versions WHERE playbook_id = ?', id);
      this.onDeleted?.(id); // planifications et déclencheurs liés (branché plus tard)
    });
    this.journal.add({ type: 'automation', event: 'playbook-delete', user, ip, ok: true, detail: cur.name });
  }

  versions(id) {
    this.get(id);
    return this.db.all('SELECT version, name, risk, auto_authorized AS autoAutorise, author, ts FROM playbook_versions WHERE playbook_id = ? ORDER BY version DESC', id)
      .map((r) => ({ ...r, autoAutorise: !!r.autoAutorise }));
  }

  /** Différence entre deux versions (texte JSON mis en forme, lignes ajoutées / retirées). */
  diff(id, from, to) {
    const get = (n) => {
      const r = this.db.get('SELECT * FROM playbook_versions WHERE playbook_id = ? AND version = ?', id, n);
      if (!r) throw new HttpError(404, 'NOT_FOUND', `Version ${n} introuvable`);
      return JSON.stringify({ name: r.name, description: r.description, autoAutorise: !!r.auto_authorized, ...JSON.parse(r.definition) }, null, 2);
    };
    this.get(id);
    return { from, to, diff: lineDiff(get(from), get(to)) };
  }

  /** Revenir à une ancienne version CRÉE une nouvelle version (l'historique n'est jamais réécrit). */
  rollback(id, version, { user, ip } = {}) {
    const r = this.db.get('SELECT * FROM playbook_versions WHERE playbook_id = ? AND version = ?', id, version);
    if (!r) throw new HttpError(404, 'NOT_FOUND', `Version ${version} introuvable`);
    const def = JSON.parse(r.definition);
    const out = this.update(id, { name: r.name, description: r.description, autoAutorise: !!r.auto_authorized, ...def }, { user, ip });
    this.journal.add({ type: 'automation', event: 'playbook-rollback', user, ip, ok: true, detail: `${r.name} : retour au contenu de la v${version}` });
    return out;
  }

  // --- Secrets nommés (coffre) ------------------------------------------------------------------------------------------------

  secretNames() { return Object.keys(this.vault.get(SECRETS_KEY) || {}).sort(); }

  setSecret(name, value, { user, ip } = {}) {
    if (typeof name !== 'string' || !SECRET_RE.test(name)) throw new HttpError(400, 'INVALID', 'Nom de secret invalide (MAJUSCULES, chiffres et « _ », 2 à 32 caractères)');
    const problem = checkSecretValue(value);
    if (problem) throw new HttpError(400, 'INVALID', problem);
    const all = this.vault.get(SECRETS_KEY) || {};
    if (!(name in all) && Object.keys(all).length >= MAX_SECRETS) throw new HttpError(409, 'LIMIT', `Trop de secrets (maximum ${MAX_SECRETS})`);
    this.vault.set(SECRETS_KEY, { ...all, [name]: value });
    this.journal.add({ type: 'automation', event: 'secret-set', user, ip, ok: true, detail: `secret ${name} enregistré` }); // jamais la valeur
  }

  deleteSecret(name, { user, ip } = {}) {
    const all = this.vault.get(SECRETS_KEY) || {};
    if (!(name in all)) throw new HttpError(404, 'NOT_FOUND', 'Secret introuvable');
    const { [name]: _gone, ...rest } = all;
    this.vault.set(SECRETS_KEY, rest);
    this.journal.add({ type: 'automation', event: 'secret-delete', user, ip, ok: true, detail: `secret ${name} supprimé` });
  }

  /** Valeurs demandées (usage INTERNE : exécuteur seulement, jamais renvoyées). */
  secretValues(names) {
    const all = this.vault.get(SECRETS_KEY) || {};
    const out = {};
    for (const n of names) {
      if (!(n in all)) throw new HttpError(409, 'SECRET_MISSING', `Le secret « ${n} » n'est pas défini : ajoutez-le avant de lancer ce playbook`);
      out[n] = all[n];
    }
    return out;
  }

  /** Noms des secrets qu'utilise un playbook. */
  secretsUsedBy(def) {
    const names = new Set();
    const scan = (t) => { for (const m of String(t).matchAll(/\{\{\s*secret\.([A-Z0-9_]+)\s*\}\}/g)) names.add(m[1]); };
    for (const s of def.steps) { if (s.run) scan(s.run); for (const p of s.parallel || []) scan(p.run); }
    return [...names].sort();
  }
}

export { LIMITS };
