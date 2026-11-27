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
  app.use((req, res, next) => { req.user = { id: 'u-test', username: 'test', role: req.get('x-role') || 'viewer' }; next(); });
  app.use(accountRoutes(env.corvus.ctx));
  app.use(hostRoutes(env.corvus.ctx));
  app.use(extraRoutes(env.corvus.ctx));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ code: err.code || 'ERR' }));
  await new Promise((resolve) => { srv = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { srv.close(); await env.close(); });

const call = async (role, method, url, body) => {
  const r = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', 'x-role': role }, body: body ? JSON.stringify(body) : undefined,
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
