// Audit de sécurité 1.1.0 : chaque correctif a d'abord eu un test qui échoue. Voir docs/audit-1.1.0.md.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';

describe('droits de lecture trop larges (audit 1.1.0, point 9)', () => {
  let env; let admin; const ids = {}; let ro; let op;
  const asUser = async (u) => { const c = new CorvusClient(env.base, { corvus: env.corvus, user: u }); assert.equal((await c.login()).status, 200); return c; };
  before(async () => {
    env = await startCorvus();
    admin = env.client; await admin.login();
    ids.a = (await admin.api('POST', '/api/hosts', { name: 'a', hostname: 'a.example', username: 'pi', password: 'x' })).body.host.id;
    ids.b = (await admin.api('POST', '/api/hosts', { name: 'b', hostname: 'b.example', username: 'pi', password: 'x' })).body.host.id;
    const { users } = env.corvus.ctx;
    const r = makeUser(env.corvus, { username: 'lecteur', password: 'mot-de-passe-lecteur', role: 'viewer' });
    users.setGrants(r.id, [{ scope: 'host', target: ids.a, role: 'viewer' }]);
    const o = makeUser(env.corvus, { username: 'ops', password: 'mot-de-passe-operateur', role: 'operator' });
    users.setGrants(o.id, [{ scope: 'host', target: ids.a, role: 'operator' }]);
    ro = await asUser(r); op = await asUser(o);
  });
  after(() => env.close());

  const H = (p) => `/api/hosts/${ids.a}${p}`;
  const SENSITIVE = ['/admin/logs', '/admin/logs?lines=5&unit=ssh', '/admin/firewall', '/admin/users', '/rewind/diff?a=' + 'a'.repeat(64), `/rewind/version/${'b'.repeat(64)}`];

  test('un lecteur ne lit ni les journaux système, ni le pare-feu, ni les comptes de l\'hôte, ni l\'historique des fichiers', async () => {
    for (const p of SENSITIVE) assert.equal((await ro.api('GET', H(p))).status, 403, `lecteur : GET ${p}`);
    // variantes de casse et « / » final : mêmes refus
    for (const p of ['/Admin/Logs', '/ADMIN/FIREWALL/', '/admin/Users/', '/Rewind/Diff/?a=' + 'a'.repeat(64), `/REWIND/version/${'b'.repeat(64)}/`]) {
      const r = await ro.api('GET', H(p));
      assert.ok(r.status === 403 || r.status === 404, `lecteur : GET ${p} → ${r.status}`);
    }
  });

  test('ce qui reste en lecture pour un lecteur : services, mises à jour, supervision', async () => {
    for (const p of ['/admin/services', '/admin/updates', '/monitor/stats']) {
      const r = await ro.api('GET', H(p));
      assert.notEqual(r.status, 403, `lecteur : GET ${p} reste permis (${r.status})`);
    }
  });

  test('un opérateur y accède toujours (l\'hôte de test est injoignable : 5xx, jamais 403)', async () => {
    for (const p of ['/admin/logs', '/admin/firewall', '/admin/users']) assert.notEqual((await op.api('GET', H(p))).status, 403, p);
    assert.notEqual((await op.api('GET', H(`/rewind/version/${'b'.repeat(64)}`))).status, 403);
  });

  test('geler / dégeler / arrêter un processus par l\'agent (root) : administrateur de l\'hôte seulement', async () => {
    const body = { pid: 1234, start: 1, action: 'kill', confirm: true };
    assert.equal((await op.api('POST', H('/xray/proc'), body)).status, 403, 'opérateur refusé');
    assert.equal((await ro.api('POST', H('/xray/proc'), body)).status, 403);
    assert.equal((await op.api('POST', H('/Xray/Proc/'), body)).status, 403, 'variante de casse');
    assert.notEqual((await admin.api('POST', H('/xray/proc'), body)).status, 403, 'administrateur autorisé (puis refus normal : agent absent)');
  });

  test('identifiant d\'hôte en majuscules : jamais d\'accès, même réponse qu\'un hôte inconnu', async () => {
    const up = ids.b.toUpperCase();
    const a = await ro.api('GET', `/api/hosts/${up}/admin/logs`);
    const unknown = await ro.api('GET', '/api/hosts/ZZZZZZZZZZZZZZZZ/admin/logs');
    assert.ok([400, 404].includes(a.status));
    assert.equal(a.status, unknown.status);
    assert.equal((await ro.api('GET', `/api/hosts/${up}`)).status, a.status);
  });
});

describe('un jeton d\'API ne peut pas créer d\'autres moyens de se connecter (audit 1.1.0, point 2)', () => {
  let env;
  before(async () => { env = await startCorvus(); });
  after(() => env.close());
  const bearer = (method, url, body) => fetch(`${env.base}${url}`, {
    method, headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });

  test('jeton : pas de création ni de révocation de jetons, pas de passkey, pas de changement de mot de passe', async () => {
    const before = env.corvus.ctx.users.tokens(env.admin.id).length;
    for (const [m, u, b] of [
      ['POST', '/api/me/tokens', { name: 'persistance' }], ['POST', '/api/Me/Tokens/', { name: 'persistance' }],
      ['DELETE', '/api/me/tokens/aaaaaaaaaaaa'],
      ['POST', '/api/me/passkeys/options', {}], ['POST', '/api/me/passkeys', {}], ['DELETE', '/api/me/passkeys/aaaaaaaaaaaa'],
      ['POST', '/api/me/password', { current: 'x', next: 'un-nouveau-mot-de-passe-1' }],
    ]) {
      const r = await bearer(m, u, b);
      assert.equal(r.status, 403, `${m} ${u} par jeton → ${r.status}`);
    }
    assert.equal(env.corvus.ctx.users.tokens(env.admin.id).length, before, 'aucun jeton créé par un jeton');
  });

  test('jeton : la lecture de ses propres informations reste permise ; session navigateur : tout fonctionne', async () => {
    assert.equal((await bearer('GET', '/api/me')).status, 200);
    assert.equal((await bearer('GET', '/api/me/tokens')).status, 200);
    const c = env.client; await c.login();
    const t = await c.api('POST', '/api/me/tokens', { name: 'depuis-le-navigateur' });
    assert.equal(t.status, 201);
    assert.equal((await c.api('DELETE', `/api/me/tokens/${t.body.id}`)).status, 200);
  });
});

describe('gestion des comptes : session de navigateur exigée (audit 1.1.0, point 2)', () => {
  let env;
  before(async () => { env = await startCorvus(); });
  after(() => env.close());
  test('un jeton d\'API, même administrateur, ne crée ni ne modifie de compte ; il peut les lister', async () => {
    const h = { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' };
    const create = await fetch(`${env.base}/api/users`, { method: 'POST', headers: h, body: JSON.stringify({ username: 'porte-derobee', password: 'un-mot-de-passe-long-12', role: 'admin' }) });
    assert.equal(create.status, 403);
    assert.equal(env.corvus.ctx.users.byName('porte-derobee'), undefined);
    const del = await fetch(`${env.base}/api/Users/${env.admin.id}/`, { method: 'DELETE', headers: h });
    assert.equal(del.status, 403);
    assert.equal((await fetch(`${env.base}/api/users`, { headers: h })).status, 200);
  });
});
