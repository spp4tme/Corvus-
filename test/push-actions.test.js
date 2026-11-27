// Étape 3 — Actions dans les notifications push : charge utile, droits, lien profond, aucune donnée dans le push.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';

// Le service worker s'appuie sur public/sw-actions.js : on le charge tel quel dans une machine virtuelle.
const load = () => {
  const sandbox = { self: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw-actions.js', import.meta.url), 'utf8'), sandbox);
  // Les objets viennent d'un autre « realm » : on les ramène à du JSON pur pour que deepStrictEqual les compare.
  const sw = sandbox.self.CorvusSW;
  const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
  return { ...sw, buildNotification: (n) => plain(sw.buildNotification(n)), decideClick: (a, d) => plain(sw.decideClick(a, d)), ackRequest: (i) => plain(sw.ackRequest(i)) };
};

describe('service worker : logique des actions (isolée)', () => {
  const SW = load();

  test('adresses : seules les adresses internes sont ouvertes', () => {
    for (const bad of ['https://evil.example', '//evil.example', 'javascript:alert(1)', 'data:text/html,x', '/\\evil', '/a\nb', 'x'.repeat(400), 42, null, undefined, '']) {
      assert.equal(SW.safeUrl(bad), '/', String(bad));
    }
    assert.equal(SW.safeUrl('/#/xray?host=abc&isolate=1'), '/#/xray?host=abc&isolate=1');
  });

  test('notification : actions connues seulement, 3 au plus, aucune donnée sensible requise', () => {
    const r = SW.buildNotification({
      title: 'Corvus — alerte', body: 'Fichier piège touché', alertId: 7, hostId: 'h',
      actions: [{ action: 'open', title: 'Ouvrir', url: '/#/xray?host=h' }, { action: 'ack', title: 'Acquitter', alertId: 7 },
        { action: 'isolate', title: 'Isoler…', url: '/#/xray?host=h&isolate=1' }, { action: 'rm-rf', title: 'Danger', url: '/x' }, { action: 'open', title: 'Encore', url: '/y' }],
    });
    assert.deepEqual(r.options.actions.map((a) => a.action), ['open', 'ack', 'isolate']);
    assert.equal(r.options.tag, 'alerte-7');
    assert.equal(r.options.data.url, '/#/xray?host=h');
    // Sans détail (réseau coupé, session expirée) : message générique, aucun bouton.
    const g = SW.buildNotification({});
    assert.equal(g.title, 'Corvus');
    assert.deepEqual(g.options.actions, []);
    // Une adresse externe glissée dans une action est neutralisée
    const e = SW.buildNotification({ actions: [{ action: 'open', title: 'x', url: 'https://evil.example' }] });
    assert.equal(e.options.data.url, '/');
  });

  test('clic : « Isoler… » ouvre l\'écran de confirmation, ne demande jamais d\'isolement direct', () => {
    const { options } = SW.buildNotification({
      alertId: 3, actions: [{ action: 'open', title: 'Ouvrir', url: '/#/xray?host=h' }, { action: 'ack', title: 'Acquitter', alertId: 3 }, { action: 'isolate', title: 'Isoler…', url: '/#/xray?host=h&isolate=1' }],
    });
    const iso = SW.decideClick('isolate', options.data);
    assert.deepEqual(iso, { kind: 'open', url: '/#/xray?host=h&isolate=1' });
    assert.deepEqual(SW.decideClick('ack', options.data), { kind: 'ack', alertId: 3 });
    assert.deepEqual(SW.decideClick('', options.data), { kind: 'open', url: '/#/xray?host=h' }, 'clic sur le corps');
    // Une action absente de la liste (non autorisée pour ce compte) ne fait rien d'autre qu'ouvrir l'application
    assert.equal(SW.decideClick('ack', { actions: [] }).kind, 'open');
    assert.equal(SW.decideClick('isolate', { actions: [] }).kind, 'open');
    // Un identifiant d'alerte falsifié (non entier) n'est pas accepté
    assert.equal(SW.decideClick('ack', { actions: [{ action: 'ack', alertId: '1/../..' }] }).kind, 'open');
  });

  test('acquittement : cookie de session + en-tête anti-CSRF, méthode POST, adresse fixe', () => {
    const r = SW.ackRequest(12);
    assert.equal(r.url, '/api/alerts/12/ack');
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.credentials, 'same-origin');
    assert.equal(r.init.headers['X-Corvus'], '1');
    assert.equal(SW.ackRequest('12; DROP').url, '/api/alerts/NaN/ack', 'jamais d\'injection dans l\'adresse');
  });

  test('sw.js : importe la logique, ne stocke rien d\'autre, n\'isole nulle part', () => {
    const sw = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    assert.match(sw, /importScripts\('\/sw-actions\.js'/);
    assert.ok(!/isolation/.test(sw), 'le service worker n\'appelle jamais l\'API d\'isolement');
    assert.ok(!/innerHTML/.test(sw));
  });
});

describe('API : boutons calculés par compte, droits, journal', () => {
  let env; let admin; const ids = {};
  const asUser = async (u) => { const c = new CorvusClient(env.base, { corvus: env.corvus, user: u }); assert.equal((await c.login()).status, 200); return c; };
  let alertId; let hostlessId;

  before(async () => {
    env = await startCorvus();
    admin = env.client; await admin.login();
    for (const n of ['maison', 'labo']) ids[n] = (await admin.api('POST', '/api/hosts', { name: n, hostname: `${n}.example`, username: 'pi', password: 'x' })).body.host.id;
    const { users, alerts } = env.corvus.ctx;
    const op = makeUser(env.corvus, { username: 'ops', password: 'mot-de-passe-operateur', role: 'operator' });
    users.setGrants(op.id, [{ scope: 'host', target: ids.maison, role: 'operator' }]);
    const ro = makeUser(env.corvus, { username: 'lecteur', password: 'mot-de-passe-lecteur', role: 'viewer' });
    users.setGrants(ro.id, [{ scope: 'host', target: ids.maison, role: 'viewer' }]);
    // Alerte critique de « maison » : la notification est émise par Alerts.raise (comme en production)
    alertId = alerts.raise({ kind: 'canary:test', severity: 'critical', message: 'Fichier piège touché', hostId: ids.maison });
    env.corvus.ctx.push.sendOne = async () => 201;
  });
  after(() => env.close());

  const latest = async (cl) => cl.api('GET', '/api/push/latest');
  const actionsOf = (r) => r.body.notification.actions.map((a) => a.action);

  test('administrateur : Ouvrir + Acquitter + Isoler… (alerte critique d\'un hôte dont il est administrateur)', async () => {
    const r = await latest(admin);
    assert.equal(r.status, 200);
    assert.deepEqual(actionsOf(r), ['open', 'ack', 'isolate']);
    const iso = r.body.notification.actions.find((a) => a.action === 'isolate');
    assert.match(iso.url, /^\/#\/xray\?host=[a-z0-9]{8,32}&isolate=1$/);
    assert.equal(r.body.notification.actions.find((a) => a.action === 'ack').alertId, alertId);
    assert.ok(!JSON.stringify(r.body).includes('confirm'), 'aucune requête d\'isolement prête à partir');
  });

  test('opérateur de l\'hôte : acquitter oui, isoler non ; lecteur : seulement ouvrir ; hôte non accordé : rien', async () => {
    const { users } = env.corvus.ctx;
    const op = users.byName('ops');
    const cop = await asUser({ ...op, password: 'mot-de-passe-operateur', secret: users.totpSecret(op.id) });
    assert.deepEqual(actionsOf(await latest(cop)), ['open', 'ack']);
    const ro = users.byName('lecteur');
    const cro = await asUser({ ...ro, password: 'mot-de-passe-lecteur', secret: users.totpSecret(ro.id) });
    assert.deepEqual(actionsOf(await latest(cro)), ['open']);
    // Un compte sans accès à l'hôte ne reçoit pas la notification (404) et ne peut pas acquitter l'alerte
    const out = makeUser(env.corvus, { username: 'dehors', password: 'mot-de-passe-dehors1', role: 'operator' });
    users.setGrants(out.id, [{ scope: 'host', target: ids.labo, role: 'operator' }]);
    const cout = await asUser(out);
    assert.equal((await latest(cout)).status, 404);
    assert.equal((await cout.api('POST', `/api/alerts/${alertId}/ack`, {})).status, 404, 'acquitter l\'alerte d\'un hôte non accordé : refusé');
  });

  test('l\'isolement lui-même reste réservé et confirmé côté serveur', async () => {
    const { users } = env.corvus.ctx;
    const op = users.byName('ops');
    const cop = await asUser({ ...op, password: 'mot-de-passe-operateur', secret: users.totpSecret(op.id) });
    for (const u of [`/api/hosts/${ids.maison}/isolation`, `/api/Hosts/${ids.maison}/Isolation/`]) {
      assert.equal((await cop.api('POST', u, { action: 'isolate', ttlSec: 60, confirm: true })).status, 403, u);
    }
    assert.equal((await admin.api('POST', `/api/hosts/${ids.maison}/isolation`, { action: 'isolate', ttlSec: 60 })).status >= 400, true, 'sans confirm : refusé');
  });

  test('acquittement : journalisé, une seule fois, variantes de casse refusées pour un lecteur', async () => {
    const { users } = env.corvus.ctx;
    const ro = users.byName('lecteur');
    const cro = await asUser({ ...ro, password: 'mot-de-passe-lecteur', secret: users.totpSecret(ro.id) });
    for (const u of [`/api/alerts/${alertId}/ack`, `/api/Alerts/${alertId}/Ack/`, `/api/ALERTS/${alertId}/ACK`]) {
      assert.equal((await cro.api('POST', u, {})).status, 403, `lecteur : ${u}`);
    }
    const op = users.byName('ops');
    const cop = await asUser({ ...op, password: 'mot-de-passe-operateur', secret: users.totpSecret(op.id) });
    assert.equal((await cop.api('POST', `/api/alerts/${alertId}/ack`, {}, {})).status, 200);
    assert.equal((await cop.api('POST', `/api/alerts/${alertId}/ack`, {})).status, 404, 'déjà acquittée');
    const j = await admin.api('GET', '/api/journal?type=alert');
    assert.ok(j.body.entries.some((e) => e.event === 'ack' && e.user === 'ops' && /canary:test/.test(e.detail)));
    // Après acquittement, les boutons « Acquitter » / « Isoler… » disparaissent
    assert.deepEqual(actionsOf(await latest(admin)), ['open']);
    // Sans l'en-tête anti-CSRF : refusé
    hostlessId = env.corvus.ctx.alerts.raise({ kind: 'disk-space', severity: 'warn', message: 'Disque presque plein' });
    assert.equal((await admin.api('POST', `/api/alerts/${hostlessId}/ack`, {}, { csrf: false })).status, 403);
  });

  test('alerte sans hôte : opérateur peut acquitter, jamais d\'isolement', async () => {
    const r = await latest(admin);
    assert.deepEqual(actionsOf(r), ['open', 'ack']);
    assert.ok(!r.body.notification.actions.some((a) => a.action === 'isolate'));
  });

  test('le push lui-même ne contient aucune donnée : requête vide, aucun détail transmis au service de push', async () => {
    const calls = [];
    env.corvus.ctx.push.sendOne = async (...args) => { calls.push(args); return 201; };
    env.corvus.ctx.db.run('INSERT INTO push_subscriptions (endpoint, user_id, label, created_at) VALUES (?, ?, ?, ?)',
      'https://fcm.googleapis.com/fcm/send/test-endpoint', env.admin.id, 'test', Date.now());
    await env.corvus.ctx.push.notify({ title: 'Secret', body: 'mot de passe: hunter2', hostId: ids.maison, alertId: 999 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1, 'seule l\'adresse du service de push est passée à l\'envoi');
    assert.equal(typeof calls[0][0], 'string');
    assert.ok(!JSON.stringify(calls).includes('hunter2'));
    const src = fs.readFileSync(new URL('../server/lib/push.js', import.meta.url), 'utf8');
    assert.match(src, /'Content-Length': '0'/, 'la requête de push est vide (Content-Length: 0)');
  });
});
