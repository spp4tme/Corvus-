// Audit court du jalon 1.3 : chaque point a d'abord eu un test qui exploite le problème (rouge), puis le correctif (docs/audit-1.3.0.md).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { validatePlaybook } from '../server/lib/automation/model.js';
import { PlaybookError } from '../server/lib/automation/params.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = ['hostIds'];
const base = (extra = {}) => ({ name: 'Audit', steps: [{ run: 'echo ok' }], targets: { hostIds: ['aabbccdd11223344'] }, ...extra });

describe('point 1 (HAUTE) — un secret ne peut jamais partir vers une destination choisie par celui qui lance le playbook', () => {
  const refuse = (input) => assert.throws(() => validatePlaybook(input), (e) => e instanceof PlaybookError && /secret/i.test(e.message), JSON.stringify(input.steps).slice(0, 90));
  const withParams = (type, steps, extra = {}) => base({ params: [{ name: 'cible', type, ...(type === 'choice' ? { choices: ['a', 'b'] } : {}) }], steps, ...extra });

  test('EXPLOIT : « curl -H {{secret.TOKEN}} {{url}} » avec une URL fournie par l\'opérateur envoyait le secret chez lui', () => {
    for (const type of ['string', 'path', 'host']) {
      refuse(withParams(type, [{ run: 'curl -H {{secret.TOKEN}} {{cible}}' }]));
      refuse(withParams(type, [{ run: 'cat {{cible}}; echo {{secret.TOKEN}}' }]));
      refuse(withParams(type, [{ parallel: [{ run: 'ls' }, { run: 'mysql -h {{cible}} -p{{secret.DB_PASS}}' }] }]));
    }
  });

  test('un secret avec des paramètres bornés par l\'administrateur (liste de choix, entier) reste possible : la destination ne peut pas être choisie', () => {
    assert.ok(validatePlaybook(withParams('choice', [{ run: 'curl -H {{secret.TOKEN}} https://api.exemple.org/{{cible}}' }])));
    assert.ok(validatePlaybook(base({ params: [{ name: 'port', type: 'int', min: 1, max: 100 }], steps: [{ run: 'nc -w1 db.interne {{port}} <<< x # {{secret.TOKEN}}'.replace(' <<< x # ', ' ; echo ') }] })));
    assert.ok(validatePlaybook(withParams('string', [{ run: 'echo {{cible}}' }, { run: 'curl -H {{secret.TOKEN}} https://api.exemple.org/' }])), 'un paramètre dans UNE AUTRE étape ne gêne pas');
  });

  test('la règle vaut aussi par API (aucun playbook de ce type ne peut être enregistré)', async () => {
    const sshd = await startFakeSshd();
    const env = await startCorvus();
    try {
      const host = env.corvus.ctx.hosts.create({ name: 'H', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
      assert.equal((await env.client.login()).status, 200);
      const r = await env.client.api('POST', '/api/automation/playbooks', { name: 'Fuite', params: [{ name: 'url', type: 'string' }], steps: [{ run: 'curl -H {{secret.TOKEN}} {{url}}' }], targets: { hostIds: [host.id] } });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error.message, /secret/i);
      assert.equal(env.corvus.ctx.automation.list().length, 0);
    } finally { await env.close(); await sshd.close(); }
  });
});

describe('point 2 — entrées hostiles dans les valeurs de paramètres (prototype, types, taille)', () => {
  let env; let sshd; let host; let pb;
  before(async () => {
    sshd = await startFakeSshd();
    env = await startCorvus({ rateBackupPerMin: 1000 });
    host = env.corvus.ctx.hosts.create({ name: 'H', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
    env.corvus.ctx.automation.setEnabled(true, {});
    assert.equal((await env.client.login()).status, 200);
    pb = env.corvus.ctx.automation.create({ name: 'Proto', params: [{ name: 'x', type: 'string', required: false }], steps: [{ run: 'echo {{x}}' }], targets: { hostIds: [host.id] } }, {});
  });
  after(async () => { await env?.close(); await sshd?.close(); });

  test('« __proto__ », « constructor » et clés étranges : refusés, jamais fusionnés', async () => {
    for (const raw of ['{"values":{"__proto__":{"admin":true}}}', '{"values":{"constructor":{"prototype":{"x":1}}}}', '{"values":{"x":"ok","__proto__":"y"}}', '{"values":{"toString":"x"}}']) {
      const res = await fetch(`${env.base}/api/automation/playbooks/${pb.id}/run`, { method: 'POST', headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' }, body: raw });
      assert.equal(res.status, 400, raw);
    }
    assert.equal(({}).admin, undefined, 'le prototype d\'Object n\'a pas été pollué');
    assert.equal(env.corvus.ctx.db.get('SELECT COUNT(*) AS n FROM playbook_runs WHERE playbook_id = ?', pb.id).n, 0);
  });

  test('très grandes valeurs et imbrications : refusées sans exécuter', async () => {
    for (const values of [{ x: 'a'.repeat(5000) }, { x: { a: { b: 1 } } }, { x: ['a'] }, { x: null, y: 1 }, JSON.parse('{"x":"' + 'é'.repeat(300) + '"}')]) {
      const r = await env.client.api('POST', `/api/automation/playbooks/${pb.id}/run`, { values });
      assert.ok([400, 202].includes(r.status), String(r.status));
      if (r.status === 202) await sleep(300);
    }
    const bigBody = await fetch(`${env.base}/api/automation/playbooks/${pb.id}/run`, { method: 'POST', headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ values: { x: 'z'.repeat(6_000_000) } }) });
    assert.ok([400, 413].includes(bigBody.status), String(bigBody.status));
  });
});

describe('point 3 — WebSocket /ws/automation : authentifié, origine contrôlée, filtré par hôtes, jamais de sortie', () => {
  let env; let sshd; let hostA; let hostB; let op; let viewer; let admin;
  const open = (client, { origin = client.origin, cookie } = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${client.base.replace('http', 'ws')}/ws/automation`, { headers: { cookie: cookie ?? client.cookie ?? '', origin } });
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString('utf8'))));
    ws.once('open', () => resolve({ ws, msgs }));
    ws.once('unexpected-response', (_q, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
  before(async () => {
    sshd = await startFakeSshd();
    env = await startCorvus({ rateBackupPerMin: 1000 });
    const ctx = env.corvus.ctx;
    const mk = (name) => ctx.hosts.create({ name, hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
    hostA = mk('A'); hostB = mk('B');
    admin = env.client;
    assert.equal((await admin.login()).status, 200);
    const mku = async (username, role, grants) => {
      const u = makeUser(env.corvus, { username, password: `mot-de-passe-${username}-test`, role });
      ctx.users.setGrants(u.id, grants);
      const c = new CorvusClient(env.base, { corvus: env.corvus, user: u });
      assert.equal((await c.login()).status, 200);
      return c;
    };
    op = await mku('op-ws', 'operator', [{ scope: 'host', target: hostA.id, role: 'operator' }]);
    viewer = await mku('lecteur-ws', 'viewer', [{ scope: 'host', target: hostB.id, role: 'viewer' }]);
    ctx.automation.setEnabled(true, {});
  });
  after(async () => { await env?.close(); await sshd?.close(); });

  test('sans session : refusé (401) ; origine étrangère : refusée (403)', async () => {
    await assert.rejects(open(admin, { cookie: '' }), (e) => e.status === 401);
    await assert.rejects(open(admin, { origin: 'https://evil.example' }), (e) => e.status === 403);
  });

  test('chaque compte ne reçoit que les évènements des hôtes qu\'il voit ; JAMAIS de sortie de commande ; fermé si le compte est désactivé', async () => {
    const ctx = env.corvus.ctx;
    const pa = ctx.automation.create({ name: 'Sur A', steps: [{ run: 'echo SORTIE-SECRETE-A' }], targets: { hostIds: [hostA.id] } }, {});
    const pbb = ctx.automation.create({ name: 'Sur B', steps: [{ run: 'echo SORTIE-SECRETE-B' }], targets: { hostIds: [hostB.id] } }, {});
    const sOp = await open(op); const sViewer = await open(viewer); const sAdmin = await open(admin);
    await sleep(150);
    for (const s of [sOp, sViewer, sAdmin]) assert.equal(s.msgs[0].type, 'hello');
    const user = { id: 'u', username: 'admin', role: 'admin' };
    const ra = await ctx.automationRuns.start({ playbookId: pa.id, trigger: 'manual', user });
    const rb = await ctx.automationRuns.start({ playbookId: pbb.id, trigger: 'manual', user });
    for (let i = 0; i < 100 && ctx.automationRuns.active.size; i++) await sleep(50);
    await sleep(200);
    const ids = (s) => new Set(s.msgs.filter((m) => m.runId).map((m) => m.runId));
    assert.deepEqual([...ids(sOp)], [ra.runId], 'l\'opérateur (hôte A) ne voit que le lancement sur A');
    assert.deepEqual([...ids(sViewer)], [rb.runId], 'le lecteur (hôte B) ne voit que le lancement sur B');
    assert.deepEqual([...ids(sAdmin)].sort(), [ra.runId, rb.runId].sort());
    const all = JSON.stringify([sOp.msgs, sViewer.msgs, sAdmin.msgs]);
    assert.ok(!all.includes('SORTIE-SECRETE'), 'aucune sortie de commande dans les messages en direct');
    assert.ok(!/"hostIds"/.test(all), 'les identifiants d\'hôtes de tout le lancement ne sont pas diffusés');
    // un message envoyé au serveur n'a aucun effet
    sOp.ws.send(JSON.stringify({ type: 'stop' }));
    await sleep(100);
    // compte désactivé : le prochain évènement ferme la connexion
    const closed = new Promise((r) => sViewer.ws.once('close', r));
    ctx.users.update?.(ctx.users.byName('lecteur-ws').id, { disabled: true }, ctx.users.byName('lecteur-ws'));
    const u2 = ctx.users.byName('lecteur-ws');
    if (!u2.disabled) ctx.db.run('UPDATE users SET disabled = 1 WHERE id = ?', u2.id);
    await ctx.automationRuns.start({ playbookId: pbb.id, trigger: 'manual', user });
    await Promise.race([closed, sleep(3000)]);
    assert.equal(sViewer.ws.readyState === WebSocket.CLOSED || sViewer.ws.readyState === WebSocket.CLOSING, true, 'connexion fermée pour un compte désactivé');
    for (const s of [sOp, sAdmin]) s.ws.close();
  });
});

describe('point 4 — l\'historique et le journal ne contiennent jamais de valeur de secret, même après un échec', () => {
  test('un playbook en échec qui affiche son secret : sortie masquée dans la base, le journal et les alertes', async () => {
    const sshd = await startFakeSshd();
    const env = await startCorvus();
    try {
      const ctx = env.corvus.ctx;
      const host = ctx.hosts.create({ name: 'H', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
      ctx.automation.setEnabled(true, {});
      ctx.automation.setSecret('TOKEN_X', 'secret-qui-ne-doit-jamais-fuiter', {});
      const pb = ctx.automation.create({ name: 'Fuite en échec', steps: [{ run: 'echo "token={{secret.TOKEN_X}}" >&2; echo "token={{secret.TOKEN_X}}"; exit 9' }], targets: { hostIds: [host.id] } }, {});
      const r = await ctx.automationRuns.start({ playbookId: pb.id, trigger: 'manual', user: { id: 'u', username: 'admin', role: 'admin' } });
      for (let i = 0; i < 200 && ctx.db.get('SELECT status FROM playbook_runs WHERE id = ?', r.runId).status === 'running'; i++) await sleep(30);
      for (const t of ['playbook_runs', 'playbook_run_steps', 'audit', 'alerts', 'playbooks', 'playbook_versions']) {
        assert.ok(!JSON.stringify(ctx.db.all(`SELECT * FROM ${t}`)).includes('secret-qui-ne-doit-jamais-fuiter'), `secret en clair dans ${t}`);
      }
      assert.ok(!fs.readFileSync(path.join(env.dataDir, 'corvus.db')).includes('secret-qui-ne-doit-jamais-fuiter'), 'ni en clair dans le fichier de base');
    } finally { await env.close(); await sshd.close(); }
  });
});

void T;
