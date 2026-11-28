// Playbooks, étape 1 : modèle de données (validation pure, niveau de risque, versions, cibles) et service (base, secrets, journal).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCorvus } from './helpers/corvus.js';
import { validatePlaybook, commandRisk, AGENT_ACTIONS, LIMITS } from '../server/lib/automation/model.js';
import { PlaybookError } from '../server/lib/automation/params.js';

const HOST = 'aabbccdd11223344';
const base = (extra = {}) => ({ name: 'Nettoyer les journaux', steps: [{ run: 'ls /var/log' }], targets: { hostIds: [HOST] }, ...extra });
const refuse = (input, re) => assert.throws(() => validatePlaybook(input), (e) => e instanceof PlaybookError && (!re || re.test(e.message)), String(JSON.stringify(input)).slice(0, 80));

describe('validation d\'un playbook (module pur)', () => {
  test('minimum valide : défauts sûrs (auto-autorisation FAUSSE, exécution séquentielle, risque calculé)', () => {
    const v = validatePlaybook(base());
    assert.equal(v.autoAutorise, false);
    assert.equal(v.risk, 'safe');
    assert.deepEqual(v.definition.strategy, { hosts: 'sequential', maxParallel: 3 });
    assert.equal(v.definition.steps[0].timeoutSec, 300);
    assert.deepEqual(v.secrets, []);
  });

  test('noms : accents acceptés, caractères dangereux ou de contrôle refusés', () => {
    assert.equal(validatePlaybook(base({ name: 'Redémarrer le service Nginx' })).name, 'Redémarrer le service Nginx');
    for (const name of ['', '   ', ' ', '-x', '.x', 'a/b', 'a;b', 'a\nb', 'a\u0000b', 'x'.repeat(65), 42, null, ['x'], '<script>', '$(id)', 'a`b`']) refuse(base({ name }), /Nom invalide/);
  });

  test('le risque est CALCULÉ, jamais fourni : une commande dangereuse ne peut pas se déclarer sûre', () => {
    assert.equal(validatePlaybook(base({ steps: [{ run: 'rm -rf /srv/data' }] })).risk, 'danger');
    assert.equal(validatePlaybook(base({ steps: [{ run: 'ls' }, { run: 'sudo rm -rf /var/lib/x' }] })).risk, 'danger', 'le pire niveau l\'emporte');
    refuse({ ...base(), risk: 'safe' }, /Champ inconnu/);
    refuse({ ...base(), riskLevel: 'safe' }, /Champ inconnu/);
  });

  test('risque d\'un modèle : les marqueurs ne masquent pas la commande', () => {
    const r = commandRisk('rm -rf {{dossier}}');
    assert.equal(r.level, 'danger');
    assert.ok(commandRisk('echo {{secret.TOKEN}}').level);
  });

  test('étapes : une seule sorte par étape, champs inconnus refusés, bornes', () => {
    refuse(base({ steps: [] }), /Au moins une étape/);
    refuse(base({ steps: 'ls' }), /Au moins une étape/);
    refuse(base({ steps: [{}] }), /exactement une/);
    refuse(base({ steps: [{ run: 'ls', agent: { action: 'xray.live' } }] }), /exactement une/);
    refuse(base({ steps: [{ run: 'ls', exec: 'x' }] }), /champ inconnu/);
    refuse(base({ steps: [{ run: '' }] }), /vide|commande/);
    refuse(base({ steps: [{ run: 'x'.repeat(LIMITS.maxCommandChars + 1) }] }), /caractères/);
    refuse(base({ steps: [{ run: 'ls\u0000' }] }), /contrôle|NUL/);
    refuse(base({ steps: Array.from({ length: LIMITS.maxSteps + 1 }, () => ({ run: 'ls' })) }), /Trop d'étapes/);
    for (const timeoutSec of [0, -1, 1.5, 99999, '10']) refuse(base({ steps: [{ run: 'ls', timeoutSec }] }), /délai/);
    refuse(base({ steps: [{ run: 'ls', continueOnError: 'oui' }] }), /booléen/);
  });

  test('étapes parallèles : 2 à 8 commandes, chacune validée', () => {
    assert.equal(validatePlaybook(base({ steps: [{ name: 'g', parallel: [{ run: 'ls' }, { run: 'df' }] }] })).definition.steps[0].parallel.length, 2);
    refuse(base({ steps: [{ parallel: [{ run: 'ls' }] }] }), /2 à 8/);
    refuse(base({ steps: [{ parallel: Array.from({ length: 9 }, () => ({ run: 'ls' })) }] }), /2 à 8/);
    refuse(base({ steps: [{ parallel: [{ run: 'ls' }, { agent: { action: 'xray.live' } }] }] }), /\{ run \}/);
    refuse(base({ steps: [{ parallel: [{ run: 'ls' }, { run: 'echo \'{{x}}\'' }] }] }), /paramètre|quotes/i);
  });

  test('étapes d\'agent : seulement les actions NOMMÉES existantes ; arguments simples et bornés', () => {
    const v = validatePlaybook(base({ steps: [{ agent: { action: 'net.isolate' } }] }));
    assert.equal(v.risk, 'danger', 'l\'isolement réseau est dangereux');
    assert.equal(validatePlaybook(base({ steps: [{ agent: { action: 'net.status' } }] })).risk, 'safe');
    for (const action of ['rm', 'shell.exec', 'preview.apply', 'proc.kill', '__proto__', 'constructor', 'toString', '', 42]) refuse(base({ steps: [{ agent: { action } }] }), /action d'agent inconnue/);
    refuse(base({ steps: [{ agent: { action: 'xray.live', args: [1] } }] }), /objet/);
    refuse(base({ steps: [{ agent: { action: 'xray.live', args: { 'A-b': 1 } } }] }), /argument/);
    refuse(base({ steps: [{ agent: { action: 'xray.live', args: { x: { y: 1 } } } }] }), /texte, nombre/);
    refuse(base({ steps: [{ agent: { action: 'xray.live', args: { x: 'a'.repeat(301) } } }] }), /caractères/);
    assert.deepEqual(Object.keys(AGENT_ACTIONS).sort(), ['net.isolate', 'net.release', 'net.status', 'preview.run', 'xray.live']);
  });

  test('paramètres et secrets référencés par les étapes', () => {
    const v = validatePlaybook(base({
      params: [{ name: 'service', type: 'choice', choices: ['a', 'b'] }],
      steps: [{ run: 'systemctl status {{service}}' }, { run: 'curl -H {{secret.API_TOKEN}} https://x' }, { run: 'echo {{secret.API_TOKEN}} {{secret.DB_PASS}}' }],
    }));
    assert.deepEqual(v.secrets, ['API_TOKEN', 'DB_PASS']);
    refuse(base({ steps: [{ run: 'echo {{pas_declare}}' }] }), /non déclaré/);
  });

  test('cibles : au moins une, identifiants et groupes valides, bornes', () => {
    refuse({ ...base(), targets: undefined }, /Cibles/);
    refuse(base({ targets: {} }), /Au moins un hôte/);
    refuse(base({ targets: { hostIds: [] } }), /Au moins un hôte/);
    refuse(base({ targets: { hostIds: 'x' } }), /liste/);
    refuse(base({ targets: { hostIds: ['pas un id'] } }), /identifiant/);
    refuse(base({ targets: { hostIds: ['../../etc'] } }), /identifiant/);
    refuse(base({ targets: { hostIds: [HOST], extra: 1 } }), /champ inconnu/);
    refuse(base({ targets: { groups: ['a\nb'] } }), /groupe/);
    refuse(base({ targets: { groups: [''] } }), /groupe/);
    refuse(base({ targets: { groups: 'prod' } }), /liste/);
    refuse(base({ targets: { hostIds: Array.from({ length: LIMITS.maxHostsPerPlaybook + 1 }, (_, i) => `h${String(i).padStart(10, '0')}`) } }), /Trop d'hôtes/);
    assert.deepEqual(validatePlaybook(base({ targets: { hostIds: [HOST, HOST], groups: ['prod', 'prod'] } })).definition.targets, { hostIds: [HOST], groups: ['prod'] });
  });

  test('stratégie et reprise : bornes ; la reprise après échec n\'existe pas', () => {
    assert.equal(validatePlaybook(base({ strategy: { hosts: 'parallel', maxParallel: 10 } })).definition.strategy.maxParallel, 10);
    refuse(base({ strategy: { hosts: 'tous' } }), /sequential/);
    for (const maxParallel of [0, 11, 1.5, '3']) refuse(base({ strategy: { maxParallel } }), /maxParallel/);
    refuse(base({ strategy: { x: 1 } }), /champ inconnu/);
    refuse(base({ resume: true }), /reprise/);
    assert.ok(validatePlaybook(base({ resume: false })));
  });

  test('entrées hostiles : types incorrects, prototype, très longues valeurs', () => {
    for (const input of [null, undefined, 'x', 42, [], true]) refuse(input, /objet/);
    refuse({ ...base(), __proto__x: 1 }, /inconnu/);
    refuse(base({ description: 'd'.repeat(LIMITS.maxDescription + 1) }), /caractères/);
    refuse(base({ description: 'a\u0000b' }), /contrôle/);
    refuse(base({ autoAutorise: 'oui' }), /booléen/);
    refuse(base({ autoAutorise: 1 }), /booléen/);
  });
});

describe('service : playbooks en base, versions, secrets, interrupteur', () => {
  let env; let auto; let hostPosix; let hostWin; let hostSolo; let admin;
  before(async () => {
    env = await startCorvus();
    const { hosts } = env.corvus.ctx;
    hostPosix = hosts.create({ name: 'Linux', hostname: '10.0.0.1', username: 'u', authType: 'password', password: 'x', group: 'prod' });
    hostWin = hosts.create({ name: 'Windows', hostname: '10.0.0.2', username: 'u', authType: 'password', password: 'x', os: 'windows', group: 'prod' });
    hostSolo = hosts.create({ name: 'Agent seul', authType: 'none' });
    auto = env.corvus.ctx.automation;
    admin = { id: 'u1', username: 'admin' };
  });
  after(async () => { await env?.close(); });

  const def = (extra = {}) => ({ name: 'Mon playbook', steps: [{ run: 'ls /tmp' }], targets: { hostIds: [hostPosix.id] }, ...extra });
  const code = (fn) => { try { fn(); } catch (e) { return `${e.status} ${e.code}`; } return 'aucune erreur'; };

  test('DÉSACTIVÉ PAR DÉFAUT ; chaque changement est journalisé', () => {
    assert.equal(auto.enabled, false);
    assert.equal(auto.setEnabled(true, { user: admin }), true);
    assert.equal(auto.enabled, true);
    auto.setEnabled(false, { user: admin });
    const lignes = env.corvus.ctx.db.all("SELECT event, detail FROM audit WHERE type = 'automation' AND event IN ('enabled', 'disabled') ORDER BY rowid");
    assert.deepEqual(lignes.map((l) => l.event), ['enabled', 'disabled']);
    for (const bad of ['true', 1, null, undefined]) assert.equal(code(() => auto.setEnabled(bad, {})), '400 INVALID');
  });

  test('création : version 1, risque calculé, auto-autorisation fausse par défaut, journal', () => {
    const p = auto.create(def({ name: 'Créé' }), { user: admin });
    assert.equal(p.version, 1);
    assert.equal(p.autoAutorise, false);
    assert.equal(p.risk, 'safe');
    assert.equal(auto.list().length >= 1, true);
    const j = env.corvus.ctx.db.get("SELECT detail FROM audit WHERE event = 'playbook-create' ORDER BY rowid DESC");
    assert.match(j.detail, /Créé/);
  });

  test('nom unique sans tenir compte de la casse ; cible inconnue refusée', () => {
    assert.equal(code(() => auto.create(def({ name: 'CRÉÉ' }))), '409 CONFLICT');
    assert.equal(code(() => auto.create(def({ name: 'Autre', targets: { hostIds: ['0123456789abcdef'] } }))), '400 INVALID_PLAYBOOK');
    assert.equal(code(() => auto.create(def({ name: '' }))), '400 INVALID_PLAYBOOK');
  });

  test('HÔTE WINDOWS : refusé à la création (hôte listé, ou membre d\'un groupe visé)', () => {
    assert.equal(code(() => auto.create(def({ name: 'Win direct', targets: { hostIds: [hostWin.id] } }))), '409 POSIX_ONLY');
    assert.equal(code(() => auto.create(def({ name: 'Win groupe', targets: { groups: ['prod'] } }))), '409 POSIX_ONLY');
  });

  test('HÔTE « agent seul » : refusé pour des commandes, accepté pour des étapes d\'agent', () => {
    assert.equal(code(() => auto.create(def({ name: 'Solo cmd', targets: { hostIds: [hostSolo.id] } }))), '409 AGENT_ONLY');
    const ok = auto.create(def({ name: 'Solo agent', steps: [{ agent: { action: 'xray.live' } }], targets: { hostIds: [hostSolo.id] } }));
    assert.equal(ok.risk, 'safe');
  });

  test('l\'OS peut changer après coup : l\'exécution revérifie (assertTargetsUsable)', () => {
    const p = auto.create(def({ name: 'Devient Windows' }));
    env.corvus.ctx.hosts.update(hostPosix.id, { os: 'windows' });
    assert.equal(code(() => auto.assertTargetsUsable(auto.definitionOf(p.id))), '409 POSIX_ONLY');
    env.corvus.ctx.hosts.update(hostPosix.id, { os: 'auto' });
    assert.doesNotThrow(() => auto.assertTargetsUsable(auto.definitionOf(p.id)));
  });

  test('versions : chaque modification crée une version (qui, quand), diff, retour = nouvelle version', () => {
    const p = auto.create(def({ name: 'Versionné' }), { user: { username: 'alice' } });
    const v2 = auto.update(p.id, def({ name: 'Versionné', steps: [{ run: 'ls /tmp' }, { run: 'df -h' }] }), { user: { username: 'bob' } });
    assert.equal(v2.version, 2);
    const hist = auto.versions(p.id);
    assert.deepEqual(hist.map((h) => [h.version, h.author]), [[2, 'bob'], [1, 'alice']]);
    const d = auto.diff(p.id, 1, 2);
    assert.ok(JSON.stringify(d.diff).includes('df -h'));
    const v3 = auto.rollback(p.id, 1, { user: { username: 'alice' } });
    assert.equal(v3.version, 3, 'revenir en arrière ne réécrit pas l\'historique');
    assert.equal(auto.versions(p.id).length, 3);
    assert.equal(v3.steps, 1);
    assert.equal(code(() => auto.rollback(p.id, 99)), '404 NOT_FOUND');
    assert.equal(code(() => auto.diff(p.id, 1, 99)), '404 NOT_FOUND');
  });

  test('suppression : le playbook et ses versions disparaissent, l\'historique d\'exécution garde le nom', () => {
    const p = auto.create(def({ name: 'À supprimer' }));
    env.corvus.ctx.db.run("INSERT INTO playbook_runs (id, playbook_id, playbook_name, playbook_version, trigger, status, started_at) VALUES ('r1', ?, 'À supprimer', 1, 'manual', 'succeeded', ?)", p.id, Date.now());
    auto.delete(p.id, { user: admin });
    assert.equal(auto.find(p.id), null);
    assert.equal(env.corvus.ctx.db.get('SELECT COUNT(*) AS n FROM playbook_versions WHERE playbook_id = ?', p.id).n, 0);
    assert.equal(env.corvus.ctx.db.get("SELECT playbook_name AS n FROM playbook_runs WHERE id = 'r1'").n, 'À supprimer');
    assert.equal(code(() => auto.delete(p.id)), '404 NOT_FOUND');
  });

  test('secrets : stockés dans le coffre, jamais renvoyés ni journalisés', () => {
    auto.setSecret('API_TOKEN', 'valeur-ultra-secrete-123', { user: admin });
    assert.deepEqual(auto.secretNames(), ['API_TOKEN']);
    assert.deepEqual(auto.secretValues(['API_TOKEN']), { API_TOKEN: 'valeur-ultra-secrete-123' });
    const journal = JSON.stringify(env.corvus.ctx.db.all('SELECT * FROM audit'));
    assert.ok(!journal.includes('valeur-ultra-secrete-123'), 'la valeur ne doit JAMAIS apparaître dans le journal');
    const enBase = JSON.stringify(env.corvus.ctx.db.all("SELECT * FROM meta"));
    assert.ok(!enBase.includes('valeur-ultra-secrete-123'), 'ni en clair en base');
    for (const bad of ['minuscule', 'A', '1ABC', 'AB-CD', 'X'.repeat(40), '', null]) assert.equal(code(() => auto.setSecret(bad, 'valeur-correcte-1')), '400 INVALID', String(bad));
    for (const v of ['court', 'a\nb-assez-long', 'x'.repeat(600), 42]) assert.equal(code(() => auto.setSecret('OK_NAME', v)), '400 INVALID');
    assert.equal(code(() => auto.secretValues(['ABSENT'])), '409 SECRET_MISSING');
    auto.deleteSecret('API_TOKEN', { user: admin });
    assert.deepEqual(auto.secretNames(), []);
    assert.equal(code(() => auto.deleteSecret('API_TOKEN')), '404 NOT_FOUND');
  });

  test('secrets utilisés par un playbook', () => {
    const p = auto.create(def({ name: 'Avec secrets', steps: [{ run: 'curl -H {{secret.API_TOKEN}} x' }, { parallel: [{ run: 'echo {{secret.DB_PASS}}' }, { run: 'ls' }] }] }));
    assert.deepEqual(auto.secretsUsedBy(auto.definitionOf(p.id)), ['API_TOKEN', 'DB_PASS']);
  });
});
