// Seconde barrière : les routeurs refusent d'eux-mêmes, même si le middleware `accessGuard` est contourné
// (variante de casse, « / » final, règle oubliée dans GLOBAL_RULES). Ici, les routeurs sont montés SANS accessGuard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startCorvus } from './helpers/corvus.js';
import { accountRoutes } from '../server/routes/accounts.js';
import { hostRoutes } from '../server/routes/core.js';
import { extraRoutes } from '../server/routes/index.js';

let env, srv, base;

before(async () => {
  env = await startCorvus();
  const app = express();
  app.use(express.json());
  // Pas d'accessGuard : l'identité est fournie par l'en-tête de test.
  app.use((req, res, next) => { req.user = { id: req.get('x-uid') || 'u-test', username: 'test', role: req.get('x-role') || 'viewer' }; next(); });
  app.use(accountRoutes(env.corvus.ctx));
  app.use(hostRoutes(env.corvus.ctx));
  app.use(extraRoutes(env.corvus.ctx));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 'ERR' }));
  await new Promise((resolve) => { srv = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { srv.close(); await env.close(); });

const call = async (role, method, url, body, uid) => {
  const r = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', 'x-role': role, ...(uid ? { 'x-uid': uid } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  return r.status;
};

test('lecteur : toutes les routes d\'administration refusent d\'elles-mêmes (403)', async () => {
  const sid = 'abcdefabcdef';
  for (const [m, u, b] of [
    ['GET', '/users'], ['GET', '/Users/'], ['POST', '/users', { username: 'pirate', password: 'un-mot-de-passe-long-12', role: 'admin' }],
    ['PATCH', '/users/0123456789abcdef', { role: 'admin' }], ['POST', '/users/0123456789abcdef/reset-totp', {}], ['DELETE', '/users/0123456789abcdef'],
    ['GET', '/agents'], ['GET', '/Agents'], ['POST', '/agents/enrollments', { hostId: 'x' }], ['DELETE', '/agents/x'],
    ['GET', '/tailscale/peers'], ['GET', '/journal/verify'], ['GET', '/Journal/Verify/'],
    ['POST', '/services', { name: 'x', hostId: 'x', port: 80 }], ['DELETE', `/services/${sid}`], ['POST', `/services/${sid}/open`, {}],
    ['POST', '/alerts/1/ack', {}],
    ['GET', '/backups'], ['GET', '/system/config'], ['POST', '/system/restart', {}],
  ]) {
    assert.equal(await call('viewer', m, u, b), 403, `lecteur : ${m} ${u}`);
  }
  assert.equal(env.corvus.ctx.users.byName('pirate'), undefined, 'aucun compte créé par un lecteur');
});

test('opérateur : pas d\'administration ; administrateur : accès conservé', async () => {
  for (const [m, u, b] of [['GET', '/users'], ['POST', '/users', { username: 'x', password: 'un-mot-de-passe-long-12' }], ['GET', '/agents'], ['GET', '/journal/verify'], ['POST', '/services', {}]]) {
    assert.equal(await call('operator', m, u, b), 403, `opérateur : ${m} ${u}`);
  }
  assert.notEqual(await call('operator', 'POST', '/alerts/1/ack', {}), 403, 'l\'opérateur acquitte toujours les alertes');
  assert.equal(await call('admin', 'GET', '/users'), 200);
  assert.equal(await call('admin', 'GET', '/journal/verify'), 200);
  assert.equal(await call('admin', 'GET', '/agents'), 200);
});

test('comparer : le routeur refuse de lui-même un compte sans rôle valide, variantes de casse comprises (étape 1)', async () => {
  for (const u of ['/compare', '/Compare', '/COMPARE/']) {
    assert.equal(await call('aucun', 'POST', u, { path: '~/x', hostIds: ['a', 'b'] }), 403, `rôle inconnu : ${u}`);
  }
  // Rôle valide mais hôtes inconnus : 404 (jamais 403 qui révélerait quoi que ce soit)
  assert.equal(await call('viewer', 'POST', '/Compare/', { path: '~/x', hostIds: ['abcdefabcdef', 'bcdefabcdefa'] }), 404);
});

test('copie d\'hôte à hôte : le routeur refuse de lui-même un compte sans rôle « opérateur » (étape 4)', async () => {
  for (const [m, u, b] of [['POST', '/fs/copy', {}], ['POST', '/Fs/Copy/', {}], ['GET', '/FS/COPY', undefined], ['GET', '/fs/copy/0123456789abcdef', undefined], ['DELETE', '/Fs/copy/0123456789abcdef/', undefined]]) {
    assert.equal(await call('viewer', m, u, b), 403, `lecteur : ${m} ${u}`);
    assert.equal(await call('aucun', m, u, b), 403, `rôle inconnu : ${m} ${u}`);
  }
  assert.notEqual(await call('operator', 'GET', '/fs/copy'), 403);
});

test('routes d\'hôte : la barrière générique revérifie le droit SUR L\'HÔTE même sans accessGuard (audit 1.1.0)', async () => {
  const { users, hosts } = env.corvus.ctx;
  const h1 = hosts.create({ name: 'barriere', hostname: 'b.example', username: 'pi', authType: 'password', password: 'x' });
  const h2 = hosts.create({ name: 'interdit', hostname: 'c.example', username: 'pi', authType: 'password', password: 'x' });
  const u = users.create({ username: 'barriere', password: 'mot-de-passe-barriere-1', role: 'viewer' });
  users.setGrants(u.id, [{ scope: 'host', target: h1.id, role: 'viewer' }]);
  // Hôte non accordé : 404 pour toute route d'hôte, aussi bien lecture qu'écriture
  for (const [m, p, b] of [['GET', `/hosts/${h2.id}`], ['GET', `/hosts/${h2.id}/fs/list`], ['POST', `/hosts/${h2.id}/fs/mkdir`, {}], ['GET', `/Hosts/${h2.id}/Admin/Logs/`], ['GET', `/hosts/${h2.id.toUpperCase()}/monitor/stats`]]) {
    assert.equal(await call('viewer', m, p, b, u.id), 404, `${m} ${p}`);
  }
  // Hôte accordé en lecture : lecteur → refus des lectures sensibles et de toute écriture, quelles que soient les variantes
  for (const [m, p, b] of [['GET', `/hosts/${h1.id}/admin/logs`], ['GET', `/Hosts/${h1.id}/ADMIN/LOGS/`], ['GET', `/hosts/${h1.id}/admin/firewall`], ['POST', `/hosts/${h1.id}/fs/mkdir`, {}],
    ['POST', `/hosts/${h1.id}/xray/proc`, {}], ['POST', `/hosts/${h1.id}/Isolation/`, {}], ['PATCH', `/hosts/${h1.id}/`, { name: 'x' }]]) {
    assert.equal(await call('viewer', m, p, b, u.id), 403, `${m} ${p}`);
  }
  // Les routes globales voisines ne sont pas happées par la barrière (« /hosts/test » n'est pas un identifiant d'hôte)
  assert.notEqual(await call('admin', 'POST', '/hosts/test', {}, u.id), 404);
});

test('playbooks : le routeur refuse de lui-même sans le bon rôle, variantes de casse et « / » final comprises (jalon 1.3)', async () => {
  const id = '0123456789abcdef';
  // Rôle inconnu : refusé partout (garde « viewer » posée sur tout /automation).
  for (const [m, u, b] of [['GET', '/automation/state'], ['GET', '/Automation/State/'], ['GET', '/automation/runs'], ['POST', '/automation/stop', {}], ['POST', `/AUTOMATION/Playbooks/${id}/Run/`, {}], ['GET', '/automation/playbooks']]) {
    assert.equal(await call('aucun', m, u, b), 403, `rôle inconnu : ${m} ${u}`);
  }
  // Lecteur : ni lancer, ni lire les définitions, ni administrer.
  for (const [m, u, b] of [
    ['GET', '/automation/playbooks'], ['GET', '/Automation/Playbooks/'], ['GET', `/automation/playbooks/${id}`], ['POST', '/automation/playbooks', {}], ['POST', '/Automation/Playbooks/', {}],
    ['PUT', `/automation/playbooks/${id}`, {}], ['DELETE', `/automation/playbooks/${id}`, { confirm: true }], ['POST', `/automation/playbooks/${id}/run`, {}], ['POST', `/Automation/PLAYBOOKS/${id}/RUN/`, {}],
    ['POST', `/automation/runs/${id}/cancel`, {}], ['POST', '/automation/stop', {}], ['POST', '/Automation/Stop/', {}], ['PUT', '/automation/settings', { enabled: true }], ['PUT', '/Automation/Settings/', { enabled: true }],
    ['GET', '/automation/secrets'], ['GET', '/Automation/Secrets/'], ['PUT', '/automation/secrets/TOKEN_X', { value: 'valeur-assez-longue' }], ['DELETE', '/automation/secrets/TOKEN_X', { confirm: true }],
    ['GET', `/automation/playbooks/${id}/versions`], ['GET', `/automation/playbooks/${id}/diff?from=1&to=2`], ['POST', `/automation/playbooks/${id}/rollback`, { version: 1, confirm: true }],
  ]) {
    assert.equal(await call('viewer', m, u, b), 403, `lecteur : ${m} ${u}`);
  }
  // Opérateur : lit et lance, n'administre pas.
  for (const [m, u, b] of [
    ['POST', '/automation/playbooks', {}], ['POST', '/Automation/Playbooks/', {}], ['PUT', `/automation/playbooks/${id}`, {}], ['DELETE', `/automation/playbooks/${id}`, { confirm: true }],
    ['PUT', '/automation/settings', { enabled: true }], ['PUT', '/Automation/Settings', { enabled: true }], ['GET', '/automation/secrets'], ['PUT', '/automation/secrets/TOKEN_X', { value: 'valeur-assez-longue' }],
    ['GET', `/automation/playbooks/${id}/versions`], ['POST', `/automation/playbooks/${id}/rollback`, { version: 1, confirm: true }],
  ]) {
    assert.equal(await call('operator', m, u, b), 403, `opérateur : ${m} ${u}`);
  }
  assert.notEqual(await call('operator', 'GET', '/automation/playbooks'), 403, 'l\'opérateur lit les playbooks');
  assert.notEqual(await call('operator', 'POST', '/automation/stop', {}), 403, 'l\'opérateur peut demander l\'arrêt d\'urgence');
  assert.equal(env.corvus.ctx.automation.enabled, false, 'rien n\'a changé l\'interrupteur');
  assert.equal(env.corvus.ctx.automation.list().length, 0);
});
