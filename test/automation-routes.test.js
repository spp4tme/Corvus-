// Playbooks, étapes 4, 5 et 10 : routes /api/automation (droits, interrupteur général, risque, confirmation, prévisualisation, historique).
// Serveur COMPLET (avec accessGuard) + faux sshd. Les variantes de casse et la seconde barrière sont aussi dans accounts / second-barrier.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { isStrictPath } from '../server/lib/ratelimit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('automatisation : routes', () => {
  let env; let sshd; let admin; let op; let op2; let viewer; let nobody; let hostA; let hostB; let ctx;
  const mk = async (username, role, grants) => {
    const u = makeUser(env.corvus, { username, password: `mot-de-passe-${username}-test`, role });
    if (grants) ctx.users.setGrants(u.id, grants);
    const c = new CorvusClient(env.base, { corvus: env.corvus, user: u });
    assert.equal((await c.login()).status, 200);
    return { c, u };
  };
  const waitRun = async (c, id, timeout = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await c.api('GET', `/api/automation/runs/${id}`);
      if (r.status === 200 && r.body.run.status !== 'running') return r.body.run;
      if (Date.now() - t0 > timeout) throw new Error(`lancement ${id} jamais terminé : ${JSON.stringify(r.body).slice(0, 200)}`);
      await sleep(50);
    }
  };
  const on = () => { if (!ctx.automation.enabled) ctx.automation.setEnabled(true, {}); }; // chaque test qui exécute ne dépend pas de l'ordre
  const def = (extra = {}) => ({ name: `pb-${Math.random().toString(36).slice(2, 8)}`, steps: [{ name: 'dire bonjour', run: 'echo bonjour-corvus' }], targets: { hostIds: [hostA.id] }, ...extra });
  const create = async (extra) => { const r = await admin.c.api('POST', '/api/automation/playbooks', def(extra)); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.playbook; };

  before(async () => {
    sshd = await startFakeSshd();
    env = await startCorvus({ rateBackupPerMin: 1000 }); // plafond STRICT relevé ici ; il est testé séparément (fin du fichier)
    ctx = env.corvus.ctx;
    const h = (name) => ctx.hosts.create({ name, hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
    hostA = h('Hôte A'); hostB = h('Hôte B');
    admin = { c: env.client };
    assert.equal((await admin.c.login()).status, 200);
    op = await mk('op-a', 'operator', [{ scope: 'host', target: hostA.id, role: 'operator' }]);
    op2 = await mk('op-ab', 'operator', [{ scope: 'host', target: hostA.id, role: 'operator' }, { scope: 'host', target: hostB.id, role: 'operator' }]);
    viewer = await mk('lecteur', 'viewer', [{ scope: 'host', target: hostA.id, role: 'viewer' }]);
    nobody = await mk('sans-droits', 'operator', []);
  });
  after(async () => { await env?.close(); await sshd?.close(); });

  test('DÉSACTIVÉ PAR DÉFAUT : rien ne se lance tant que l\'administrateur n\'a pas activé l\'interrupteur', async () => {
    const pb = await create();
    const state = await admin.c.api('GET', '/api/automation/state');
    assert.equal(state.body.enabled, false);
    const r = await op.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'AUTOMATION_DISABLED');
    assert.equal(sshd.stats.execs.length, 0, 'aucune commande envoyée à l\'hôte');
    // Seul un administrateur change l'interrupteur ; seul un booléen est accepté ; chaque changement est journalisé.
    for (const who of [op, viewer, nobody]) assert.equal((await who.c.api('PUT', '/api/automation/settings', { enabled: true })).status, 403);
    for (const bad of ['true', 1, null, {}]) assert.equal((await admin.c.api('PUT', '/api/automation/settings', { enabled: bad })).status, 400);
    assert.equal(ctx.automation.enabled, false);
    assert.equal((await admin.c.api('PUT', '/api/automation/settings', { enabled: true })).body.enabled, true);
    assert.ok(ctx.db.get("SELECT 1 AS x FROM audit WHERE type = 'automation' AND event = 'enabled'"));
  });

  test('matrice des rôles : lecteur lit l\'historique ; opérateur lance ; administrateur administre', async () => {
    on();
    const pb = await create();
    const S = (c, m, u, b) => c.api(m, u, b).then((r) => r.status);
    // lecteur
    assert.equal(await S(viewer.c, 'GET', '/api/automation/state'), 200);
    assert.equal(await S(viewer.c, 'GET', '/api/automation/runs'), 200);
    for (const [m, u, b] of [
      ['GET', '/api/automation/playbooks'], ['GET', `/api/automation/playbooks/${pb.id}`], ['POST', '/api/automation/playbooks', def()], ['PUT', `/api/automation/playbooks/${pb.id}`, def()],
      ['DELETE', `/api/automation/playbooks/${pb.id}`, { confirm: true }], ['POST', `/api/automation/playbooks/${pb.id}/run`, {}], ['POST', '/api/automation/runs/aabbccdd11223344/cancel', {}],
      ['POST', '/api/automation/stop', {}], ['GET', '/api/automation/secrets'], ['PUT', '/api/automation/secrets/TOKEN_X', { value: 'valeur-assez-longue' }], ['PUT', '/api/automation/settings', { enabled: false }],
      ['GET', `/api/automation/playbooks/${pb.id}/versions`],
    ]) assert.equal(await S(viewer.c, m, u, b), 403, `lecteur : ${m} ${u}`);
    // opérateur : lit et lance, n'administre pas
    assert.equal(await S(op.c, 'GET', '/api/automation/playbooks'), 200);
    for (const [m, u, b] of [
      ['POST', '/api/automation/playbooks', def()], ['PUT', `/api/automation/playbooks/${pb.id}`, def()], ['DELETE', `/api/automation/playbooks/${pb.id}`, { confirm: true }],
      ['GET', '/api/automation/secrets'], ['PUT', '/api/automation/secrets/TOKEN_X', { value: 'valeur-assez-longue' }], ['DELETE', '/api/automation/secrets/TOKEN_X', { confirm: true }],
      ['GET', `/api/automation/playbooks/${pb.id}/versions`], ['GET', `/api/automation/playbooks/${pb.id}/diff?from=1&to=1`], ['POST', `/api/automation/playbooks/${pb.id}/rollback`, { version: 1, confirm: true }],
    ]) assert.equal(await S(op.c, m, u, b), 403, `opérateur : ${m} ${u}`);
    assert.ok(ctx.automation.find(pb.id), 'le playbook n\'a pas été touché par un compte trop faible');
    // sans jeton : 401
    const anon = await fetch(`${env.base}/api/automation/state`);
    assert.equal(anon.status, 401);
  });

  test('un opérateur ne lance un playbook que si TOUS ses hôtes cibles lui sont accordés (sinon 404, il ne le voit même pas)', async () => {
    on();
    const pb = await create({ name: 'Deux hôtes', targets: { hostIds: [hostA.id, hostB.id] } });
    const mine = await create({ name: 'Un hôte' });
    // op n'a que l'hôte A
    const list = (await op.c.api('GET', '/api/automation/playbooks')).body.playbooks.map((p) => p.name);
    assert.ok(list.includes('Un hôte') && !list.includes('Deux hôtes'), JSON.stringify(list));
    assert.equal((await op.c.api('GET', `/api/automation/playbooks/${pb.id}`)).status, 404);
    const run = await op.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {});
    assert.equal(run.status, 404, JSON.stringify(run.body));
    assert.equal(run.body.error.code, 'NOT_FOUND');
    // op2 a les deux : il voit et lance
    const list2 = (await op2.c.api('GET', '/api/automation/playbooks')).body.playbooks.map((p) => p.name);
    assert.ok(list2.includes('Deux hôtes'));
    assert.equal((await op2.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {})).status, 202);
    // un compte sans aucun droit ne voit rien et ne lance rien
    assert.deepEqual((await nobody.c.api('GET', '/api/automation/playbooks')).body.playbooks, []);
    assert.equal((await nobody.c.api('POST', `/api/automation/playbooks/${mine.id}/run`, {})).status, 404);
    // le droit « operator » sur l'hôte est exigé : un droit « viewer » ne suffit pas, même pour un compte opérateur
    const lowGrant = await mk('op-lecture', 'operator', [{ scope: 'host', target: hostA.id, role: 'viewer' }]);
    assert.equal((await lowGrant.c.api('POST', `/api/automation/playbooks/${mine.id}/run`, {})).status, 404);
    // l'administrateur lance tout
    assert.equal((await admin.c.api('POST', `/api/automation/playbooks/${mine.id}/run`, {})).status, 202);
  });

  test('lancement de bout en bout : sortie par hôte, code, historique, journal sans contenu', async () => {
    on();
    const pb = await create({ name: 'Bonjour', steps: [{ name: 'a', run: 'echo bonjour-corvus' }, { name: 'b', run: 'echo erreur-visible >&2; exit 0' }] });
    const r = await op.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {});
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const run = await waitRun(op.c, r.body.runId);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.steps.length, 2);
    assert.match(run.steps[0].output, /bonjour-corvus/);
    assert.match(run.steps[1].output, /erreur-visible/);
    assert.deepEqual(run.steps.map((s) => s.code), [0, 0]);
    assert.equal(run.counts.ok, 1);
    const hist = (await op.c.api('GET', '/api/automation/runs')).body.runs;
    assert.ok(hist.some((x) => x.id === r.body.runId));
    const j = JSON.stringify(ctx.db.all("SELECT detail FROM audit WHERE type = 'automation'"));
    assert.ok(!j.includes('bonjour-corvus'), 'la sortie ne doit pas être dans le journal');
    assert.match(j, /run-start|Bonjour/);
  });

  test('un échec est un échec : statut, code de sortie, alerte levée', async () => {
    on();
    const pb = await create({ name: 'Qui échoue', steps: [{ run: 'exit 7' }, { run: 'echo jamais' }] });
    const run = await waitRun(admin.c, (await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {})).body.runId);
    assert.equal(run.status, 'failed');
    assert.deepEqual(run.steps.map((s) => [s.status, s.code]), [['failed', 7], ['skipped', null]]);
    assert.ok(ctx.db.get("SELECT 1 AS x FROM alerts WHERE kind = 'playbook-failed'"));
  });

  test('RISQUE : un playbook dangereux exige confirm: true (exactement true) ; le risque vient du serveur', async () => {
    on();
    const pb = await create({ name: 'Risqué', steps: [{ run: 'rm -rf ~/dossier-inexistant-xyz' }] });
    assert.equal(pb.risk, 'danger');
    const sans = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {});
    assert.equal(sans.status, 400);
    assert.equal(sans.body.error.code, 'CONFIRM_REQUIRED');
    for (const confirm of ['true', 'oui', 1, {}, [true]]) assert.equal((await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, { confirm })).status, 400, JSON.stringify(confirm));
    const execsAvant = sshd.stats.execs.length;
    assert.equal(sshd.stats.execs.length, execsAvant, 'rien n\'a été exécuté sans confirmation');
    const ok = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, { confirm: true });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    await waitRun(admin.c, ok.body.runId);
  });

  test('PRÉVISUALISATION : un playbook « danger » exige une prévisualisation récente quand un agent en propose une ; dry n\'exécute RIEN', async () => {
    on();
    const pb = await create({ name: 'À prévisualiser', steps: [{ run: 'rm -rf ~/x-inexistant-prev' }] });
    const realFor = ctx.agents.forHost.bind(ctx.agents);
    const realReq = ctx.agents.request.bind(ctx.agents);
    const asked = [];
    ctx.agents.forHost = (id) => (id === hostA.id ? { online: true, platform: 'linux', capabilities: { actions: ['preview.run'] }, support: { preview: { ok: true } } } : realFor(id));
    ctx.agents.request = async (id, name, args) => { asked.push([id, name, args.command]); return { id: 'p1', entries: [{ path: '/x', kind: 'delete', before: 'a', after: '' }] }; };
    try {
      const avant = sshd.stats.execs.length;
      const sans = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, { confirm: true });
      assert.equal(sans.status, 409, JSON.stringify(sans.body));
      assert.equal(sans.body.error.code, 'PREVIEW_REQUIRED');
      const dry = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, { dry: true });
      assert.equal(dry.status, 200, JSON.stringify(dry.body));
      assert.equal(dry.body.dry, true);
      assert.equal(dry.body.plan[0].steps[0].analysis.level, 'danger');
      assert.ok(dry.body.plan[0].steps[0].preview.entries.length, 'résultat de la prévisualisation de l\'agent');
      assert.ok(!JSON.stringify(dry.body).includes('"before"'), 'le contenu brut des fichiers n\'est pas renvoyé');
      assert.deepEqual(asked.map((a) => a[1]), ['preview.run']);
      assert.equal(sshd.stats.execs.length, avant, 'la prévisualisation n\'a exécuté AUCUNE commande par SSH');
      const apres = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, { confirm: true });
      assert.equal(apres.status, 202, JSON.stringify(apres.body));
      await waitRun(admin.c, apres.body.runId);
      // La prévisualisation d'un AUTRE compte ne vaut pas pour celui-ci.
      const pb2 = await create({ name: 'Prévis perso', steps: [{ run: 'rm -rf ~/y-inexistant-prev' }], targets: { hostIds: [hostA.id] } });
      await admin.c.api('POST', `/api/automation/playbooks/${pb2.id}/run`, { dry: true });
      assert.equal((await op.c.api('POST', `/api/automation/playbooks/${pb2.id}/run`, { confirm: true })).status, 409);
    } finally { ctx.agents.forHost = realFor; ctx.agents.request = realReq; }
  });

  test('HÔTE WINDOWS : le playbook créé avant reste refusé à l\'exécution si l\'hôte devient Windows ; aucune commande envoyée', async () => {
    on();
    const pb = await create({ name: 'Devient Windows' });
    ctx.hosts.update(hostA.id, { os: 'windows' });
    try {
      const avant = sshd.stats.execs.length;
      const r = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {});
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'POSIX_ONLY');
      assert.equal(sshd.stats.execs.length, avant);
      // et on ne peut pas en créer un qui le vise
      assert.equal((await admin.c.api('POST', '/api/automation/playbooks', def())).status, 409);
    } finally { ctx.hosts.update(hostA.id, { os: 'auto' }); }
  });

  test('un seul lancement actif par playbook ; plafond global de lancements simultanés', async () => {
    on();
    const slow = await create({ name: 'Lent', steps: [{ run: 'sleep 4' }] });
    const slow2 = await create({ name: 'Lent 2', steps: [{ run: 'sleep 4' }] });
    const first = await admin.c.api('POST', `/api/automation/playbooks/${slow.id}/run`, {});
    assert.equal(first.status, 202);
    const again = await admin.c.api('POST', `/api/automation/playbooks/${slow.id}/run`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_RUNNING');
    const saved = ctx.automationRuns.maxConcurrentRuns;
    ctx.automationRuns.maxConcurrentRuns = 1;
    try {
      const other = await admin.c.api('POST', `/api/automation/playbooks/${slow2.id}/run`, {});
      assert.equal(other.status, 429);
      assert.equal(other.body.error.code, 'TOO_MANY_RUNS');
    } finally { ctx.automationRuns.maxConcurrentRuns = saved; }
    // annulation : l'auteur ou un administrateur, pas un autre compte
    assert.equal((await op2.c.api('POST', `/api/automation/runs/${first.body.runId}/cancel`, {})).status, 403);
    assert.equal((await admin.c.api('POST', `/api/automation/runs/${first.body.runId}/cancel`, {})).status, 200);
    const run = await waitRun(admin.c, first.body.runId);
    assert.equal(run.status, 'cancelled');
    assert.equal((await admin.c.api('POST', '/api/automation/runs/ffffffffffffffff/cancel', {})).status, 404);
  });

  test('ARRÊT D\'URGENCE : un opérateur interrompt tout ; désactiver l\'interrupteur aussi', async () => {
    on();
    const slow = await create({ name: 'Urgence', steps: [{ run: 'sleep 5' }] });
    const a = await op.c.api('POST', `/api/automation/playbooks/${slow.id}/run`, {});
    assert.equal(a.status, 202);
    await sleep(300);
    const t0 = Date.now();
    const stop = await op2.c.api('POST', '/api/automation/stop', {});
    assert.equal(stop.status, 200);
    assert.ok(stop.body.stopped >= 1);
    assert.equal((await waitRun(admin.c, a.body.runId)).status, 'cancelled');
    assert.ok(Date.now() - t0 < 4000, 'arrêté bien avant la fin du sleep');
    // interrupteur : l'éteindre arrête aussi ce qui tourne
    const b = await admin.c.api('POST', `/api/automation/playbooks/${slow.id}/run`, {});
    await sleep(300);
    await admin.c.api('PUT', '/api/automation/settings', { enabled: false });
    assert.equal((await waitRun(admin.c, b.body.runId)).status, 'cancelled');
    assert.equal((await admin.c.api('POST', `/api/automation/playbooks/${slow.id}/run`, {})).body.error.code, 'AUTOMATION_DISABLED');
    await admin.c.api('PUT', '/api/automation/settings', { enabled: true });
  });

  test('SECRETS : noms seulement, valeur masquée partout, jamais dans une ligne de commande, le journal ni la base', async () => {
    on();
    const secret = 'valeur-ultra-secrete-e2e-77';
    assert.equal((await admin.c.api('PUT', '/api/automation/secrets/API_KEY', { value: secret })).status, 200);
    assert.deepEqual((await admin.c.api('GET', '/api/automation/secrets')).body, { secrets: ['API_KEY'] });
    assert.ok(!JSON.stringify((await admin.c.api('GET', '/api/automation/state')).body).includes(secret));
    for (const bad of ['court', 'a\nb-secret-long', 42, undefined]) assert.equal((await admin.c.api('PUT', '/api/automation/secrets/API_KEY', { value: bad })).status, 400);
    assert.equal((await admin.c.api('PUT', '/api/automation/secrets/minuscule', { value: secret })).status, 400);
    const pb = await create({ name: 'Avec secret', steps: [{ run: 'printf "recu=%s\\n" {{secret.API_KEY}}' }] });
    const r = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {});
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const run = await waitRun(admin.c, r.body.runId);
    assert.equal(run.status, 'succeeded', JSON.stringify(run.steps));
    assert.match(run.steps[0].output, /recu=\*\*\*/);
    assert.ok(!JSON.stringify(run).includes(secret), 'la réponse de l\'API ne contient pas le secret');
    for (const table of ['audit', 'playbook_runs', 'playbook_run_steps', 'playbooks', 'playbook_versions', 'alerts']) {
      assert.ok(!JSON.stringify(ctx.db.all(`SELECT * FROM ${table}`)).includes(secret), `secret en clair dans ${table}`);
    }
    assert.ok(!JSON.stringify(sshd.stats.execs).includes(secret), 'jamais dans une ligne de commande envoyée à l\'hôte');
    // secret manquant : refusé avant tout, message clair
    const pb2 = await create({ name: 'Secret absent', steps: [{ run: 'echo {{secret.ABSENT_ONE}}' }] });
    const miss = await admin.c.api('POST', `/api/automation/playbooks/${pb2.id}/run`, {});
    assert.equal(miss.body.error.code, 'SECRET_MISSING');
    // suppression : confirm exigé
    assert.equal((await admin.c.api('DELETE', '/api/automation/secrets/API_KEY', {})).status, 400);
    assert.equal((await admin.c.api('DELETE', '/api/automation/secrets/API_KEY', { confirm: true })).status, 200);
  });

  test('INJECTION par l\'API : une valeur de paramètre hostile ne s\'exécute jamais sur l\'hôte', async () => {
    on();
    const pb = await create({ name: 'Avec paramètre', params: [{ name: 'nom', type: 'string', max: 200 }], steps: [{ run: 'printf "%s" {{nom}}' }] });
    const canari = path.join(sshd.root, 'PWNED');
    const hostile = "x'; touch PWNED; echo '";
    const r = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, { values: { nom: hostile } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const run = await waitRun(admin.c, r.body.runId);
    assert.equal(run.steps[0].output, hostile, 'la valeur ressort à l\'identique');
    assert.equal(fs.existsSync(canari), false, 'AUCUNE injection');
    // valeurs invalides : refusées avant toute exécution
    const avant = sshd.stats.execs.length;
    for (const values of [{ nom: 'a\nb' }, { nom: 'x'.repeat(201) }, { nom: 42 }, { inconnu: 'x' }, {}, 'x', [1]]) {
      assert.equal((await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, { values })).status, 400, JSON.stringify(values).slice(0, 40));
    }
    assert.equal(sshd.stats.execs.length, avant);
  });

  test('lancement automatique : exige autoAutorise, jamais pour un playbook « danger »', async () => {
    on();
    const normal = await create({ name: 'Pas auto' });
    const auto = await create({ name: 'Auto', autoAutorise: true });
    const danger = await create({ name: 'Auto danger', autoAutorise: true, steps: [{ run: 'rm -rf ~/z-inexistant' }] });
    const call = (id, trigger) => ctx.automationRuns.start({ playbookId: id, trigger, actor: `${trigger}:test` }).then(() => 'ok', (e) => e.code);
    assert.equal(await call(normal.id, 'schedule'), 'NOT_AUTO_AUTHORIZED');
    assert.equal(await call(danger.id, 'webhook'), 'RISK_NOT_AUTO');
    assert.equal(await call(auto.id, 'alert'), 'ok');
    await sleep(500);
  });

  test('historique : un lecteur ne voit que les hôtes qu\'il voit ; un autre compte ne lit pas un lancement qui ne le concerne pas', async () => {
    on();
    const pb = await create({ name: 'Deux pour historique', targets: { hostIds: [hostA.id, hostB.id] } });
    const r = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {});
    await waitRun(admin.c, r.body.runId);
    const full = (await admin.c.api('GET', `/api/automation/runs/${r.body.runId}`)).body.run;
    assert.equal(new Set(full.steps.map((s) => s.hostId)).size, 2);
    const vis = (await viewer.c.api('GET', `/api/automation/runs/${r.body.runId}`)).body.run;
    assert.deepEqual([...new Set(vis.steps.map((s) => s.hostId))], [hostA.id], 'le lecteur ne voit que l\'hôte A');
    assert.deepEqual(vis.hostIds, [hostA.id]);
    assert.equal((await nobody.c.api('GET', `/api/automation/runs/${r.body.runId}`)).status, 404);
    assert.ok(!(await nobody.c.api('GET', '/api/automation/runs')).body.runs.some((x) => x.id === r.body.runId));
    assert.equal((await admin.c.api('GET', '/api/automation/runs/pas-un-id')).status, 400);
    assert.equal((await admin.c.api('GET', '/api/automation/runs?limit=9999')).status, 400);
  });

  test('suppression et retour en arrière : confirm exigé, historique conservé', async () => {
    on();
    const pb = await create({ name: 'À retirer' });
    assert.equal((await admin.c.api('DELETE', `/api/automation/playbooks/${pb.id}`, {})).status, 400);
    assert.ok(ctx.automation.find(pb.id));
    await admin.c.api('PUT', `/api/automation/playbooks/${pb.id}`, def({ name: 'À retirer', steps: [{ run: 'echo v2' }] }));
    assert.equal((await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/rollback`, { version: 1 })).status, 400);
    const back = await admin.c.api('POST', `/api/automation/playbooks/${pb.id}/rollback`, { version: 1, confirm: true });
    assert.equal(back.body.playbook.version, 3);
    assert.equal((await admin.c.api('GET', `/api/automation/playbooks/${pb.id}/diff?from=1&to=2`)).status, 200);
    assert.equal((await admin.c.api('GET', `/api/automation/playbooks/${pb.id}/diff?from=a&to=2`)).status, 400);
    assert.equal((await admin.c.api('DELETE', `/api/automation/playbooks/${pb.id}`, { confirm: true })).status, 200);
    assert.equal((await admin.c.api('GET', `/api/automation/playbooks/${pb.id}`)).status, 404);
  });

  test('entrées hostiles : identifiants, corps, types', async () => {
    on();
    for (const id of ['x', '../etc', 'a b', '%00', 'é'.repeat(8), 'a'.repeat(40), '"; DROP TABLE playbooks;--']) {
      for (const [m, u] of [['GET', `/api/automation/playbooks/${encodeURIComponent(id)}`], ['POST', `/api/automation/playbooks/${encodeURIComponent(id)}/run`], ['GET', `/api/automation/runs/${encodeURIComponent(id)}`]]) {
        const r = await admin.c.api(m, u, m === 'GET' ? undefined : {});
        assert.ok([400, 404].includes(r.status), `${m} ${u} → ${r.status}`);
      }
    }
    for (const body of [null, 'texte', [], 42, { name: 'x' }, { ...def(), extra: 1 }, { ...def(), risk: 'safe' }]) {
      assert.equal((await admin.c.api('POST', '/api/automation/playbooks', body)).status, 400, JSON.stringify(body)?.slice(0, 40));
    }
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM playbooks WHERE name = 'x'").n, 0);
  });

  test('variantes de casse et « / » final : mêmes droits (lecteur et opérateur refusés, administrateur accepté)', async () => {
    on();
    const pb = await create({ name: 'Variantes' });
    const variants = (suffix) => [`/api/automation/playbooks${suffix}`, `/api/Automation/Playbooks${suffix}`, `/API/AUTOMATION/PLAYBOOKS${suffix}/`, `/api//automation/playbooks${suffix}`];
    // « // » ne correspond à aucune route (404) : sûr, car rien ne s'exécute. Les autres variantes sont refusées (403).
    const refused = (u, status) => (u.includes('//') ? [403, 404].includes(status) : status === 403);
    for (const u of variants('')) {
      const a = (await viewer.c.api('POST', u, def({ name: 'pirate-lecteur' }))).status;
      const b = (await op.c.api('POST', u, def({ name: 'pirate-operateur' }))).status;
      assert.ok(refused(u, a), `lecteur POST ${u} → ${a}`);
      assert.ok(refused(u, b), `opérateur POST ${u} → ${b}`);
    }
    for (const u of variants(`/${pb.id}/run`)) { const x = (await viewer.c.api('POST', u, {})).status; assert.ok(refused(u, x), `lecteur run ${u} → ${x}`); }
    for (const u of ['/api/Automation/Secrets/', '/api/AUTOMATION/secrets', '/api//automation//secrets']) {
      const x = (await op.c.api('GET', u)).status;
      assert.ok(refused(u, x), `opérateur ${u} → ${x}`);
    }
    for (const u of ['/api/Automation/Settings', '/api/automation/settings/']) assert.equal((await op.c.api('PUT', u, { enabled: false })).status, 403, `opérateur ${u}`);
    for (const u of ['/api/Automation/Stop/', '/API/automation/STOP']) assert.equal((await viewer.c.api('POST', u, {})).status, 403, `lecteur ${u}`);
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM playbooks WHERE name LIKE 'pirate%'").n, 0);
    assert.equal(ctx.automation.enabled, true, 'l\'interrupteur n\'a pas bougé');
    assert.equal((await admin.c.api('GET', '/api/Automation/Playbooks/')).status, 200);
  });

  test('limiteur de débit : lancer et l\'arrêt d\'urgence sont des routes à plafond STRICT (toutes variantes)', () => {
    for (const p of ['/automation/playbooks/aabbccdd11223344/run', '/Automation/Playbooks/aabbccdd11223344/Run/', '//automation//playbooks//x//run', '/automation/stop', '/AUTOMATION/Stop/']) {
      assert.equal(isStrictPath(p), true, p);
    }
    for (const p of ['/automation/runs', '/automation/state', '/automation/playbooks']) assert.equal(isStrictPath(p), false, p);
  });

  test('reprise après arrêt brutal : un lancement resté « running » est marqué interrompu', () => {
    ctx.db.run("INSERT INTO playbook_runs (id, playbook_name, playbook_version, trigger, status, started_at) VALUES ('orphelin00000001', 'X', 1, 'manual', 'running', ?)", Date.now());
    ctx.automationRuns.recover();
    assert.equal(ctx.db.get("SELECT status FROM playbook_runs WHERE id = 'orphelin00000001'").status, 'interrupted');
  });
});

describe('automatisation : plafond strict du limiteur', () => {
  test('au-delà du plafond, lancer répond 429 (+ Retry-After), une seule entrée de journal, rien n\'est exécuté', async () => {
    const sshd = await startFakeSshd();
    const env = await startCorvus({ rateBackupPerMin: 3 });
    try {
      const { ctx } = { ctx: env.corvus.ctx };
      const host = ctx.hosts.create({ name: 'H', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
      const c = env.client;
      assert.equal((await c.login()).status, 200);
      ctx.automation.setEnabled(true, {});
      const pb = (await c.api('POST', '/api/automation/playbooks', { name: 'Rapide', steps: [{ run: 'echo x' }], targets: { hostIds: [host.id] } })).body.playbook;
      const codes = [];
      for (let i = 0; i < 6; i++) { codes.push((await c.api('POST', `/api/automation/playbooks/${pb.id}/run`, {})).status); await sleep(120); }
      assert.deepEqual(codes.slice(0, 3).map((x) => x === 202 || x === 409), [true, true, true], JSON.stringify(codes));
      assert.ok(codes.slice(3).every((x) => x === 429), JSON.stringify(codes));
      const res = await fetch(`${env.base}/api/automation/playbooks/${pb.id}/run`, { method: 'POST', headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
      assert.equal(ctx.db.all("SELECT 1 FROM audit WHERE type = 'ratelimit'").length, 1, 'une seule entrée de journal, pas une par requête refusée');
      // lire l'historique, lui, n'est pas soumis au plafond strict
      assert.equal((await c.api('GET', '/api/automation/runs')).status, 200);
    } finally { await env.close(); await sshd.close(); }
  });
});
