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
