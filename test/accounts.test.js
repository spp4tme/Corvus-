// Comptes, TOTP obligatoire, rôles et droits par hôte / groupe (étape 3a).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';
import * as totp from '../server/lib/totp.js';

describe('premier lancement : administrateur + TOTP obligatoire', () => {
  let env;
  before(async () => { env = await startCorvus({}, { setup: false }); });
  after(() => env.close());

  test('état : installation requise', async () => {
    const r = await env.client.api('GET', '/api/auth/status');
    assert.equal(r.body.setupRequired, true);
    assert.equal(r.body.authenticated, false);
  });

  test('token d\'amorçage obligatoire, puis enrôlement TOTP avant toute session', async () => {
    const c = env.client;
    const bad = await c.api('POST', '/api/auth/setup', { bootstrapToken: 'cv_faux', username: 'moi', password: 'un-mot-de-passe-long' });
    assert.equal(bad.status, 401);
    const weak = await c.api('POST', '/api/auth/setup', { bootstrapToken: env.bootstrapToken, username: 'moi', password: 'court' });
    assert.equal(weak.status, 400);
    const r = await c.api('POST', '/api/auth/setup', { bootstrapToken: env.bootstrapToken, username: 'moi', password: 'un-mot-de-passe-long' });
    assert.equal(r.status, 201);
    const { enrollToken, secret, uri } = r.body.enroll;
    assert.match(uri, /^otpauth:\/\/totp\/Corvus%3Amoi\?secret=/);
    assert.equal((await c.api('GET', '/api/hosts')).status, 401, 'pas encore de session');
    const wrong = await c.api('POST', '/api/auth/totp/enroll', { enrollToken, code: '000000' });
    assert.equal(wrong.status, 400);
    const res = await fetch(`${env.base}/api/auth/totp/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken, code: totp.codeAt(secret, totp.stepAt()) }),
    });
    assert.equal(res.status, 200);
    c.cookie = res.headers.get('set-cookie').split(';')[0];
    const me = await c.api('GET', '/api/me');
    assert.equal(me.body.user.role, 'admin');
    assert.equal(me.body.user.totpEnabled, true);
    const again = await c.api('POST', '/api/auth/setup', { bootstrapToken: env.bootstrapToken, username: 'autre', password: 'un-mot-de-passe-long' });
    assert.equal(again.status, 409, 'une seule installation');
  });

  test('un code TOTP ne sert qu\'une fois (anti-rejeu)', async () => {
    const u = env.corvus.ctx.users.byName('moi');
    const secret = env.corvus.ctx.users.totpSecret(u.id);
    const step = u.totp_last_step;
    const code = totp.codeAt(secret, step);
    const r = await fetch(`${env.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'moi', password: 'un-mot-de-passe-long', code }),
    });
    assert.equal(r.status, 401);
  });
});

describe('rôles et droits par hôte / groupe', () => {
  let env;
  let admin;
  const ids = {};
  const asUser = async (user) => {
    const c = new CorvusClient(env.base, { corvus: env.corvus, user });
    assert.equal((await c.login()).status, 200);
    return c;
  };

  before(async () => {
    env = await startCorvus();
    admin = env.client;
    await admin.login();
    for (const [name, group] of [['maison', 'Maison'], ['labo', 'Labo'], ['nas', 'Maison']]) {
      const r = await admin.api('POST', '/api/hosts', { name, hostname: `${name}.example`, username: 'pi', password: 'x' });
      ids[name] = r.body.host.id;
      await admin.api('PATCH', `/api/hosts/${ids[name]}`, { group });
    }
  });
  after(() => env.close());

  test('opérateur : seulement les hôtes accordés, sans administration', async () => {
    const op = makeUser(env.corvus, { username: 'ops', password: 'mot-de-passe-operateur', role: 'operator' });
    env.corvus.ctx.users.setGrants(op.id, [{ scope: 'group', target: 'maison', role: 'operator' }]);
    const c = await asUser(op);
    const list = await c.api('GET', '/api/hosts');
    assert.deepEqual(list.body.hosts.map((h) => h.name).sort(), ['maison', 'nas']);
    assert.equal((await c.api('GET', `/api/hosts/${ids.labo}`)).status, 404, 'hôte non accordé invisible');
    assert.equal((await c.api('PATCH', `/api/hosts/${ids.maison}`, { name: 'x' })).status, 403, 'pas de modification d\'hôte');
    assert.equal((await c.api('PATCH', `/api/hosts/${ids.maison}`, { repos: ['~/app'] })).status, 200, 'mais peut gérer la liste de dépôts');
    assert.equal((await c.api('POST', '/api/hosts', { name: 'y', hostname: 'y', username: 'pi' })).status, 403);
    assert.equal((await c.api('GET', '/api/users')).status, 403);
    assert.equal((await c.api('GET', '/api/backups')).status, 403);
    // Terminal : refusé sur un hôte non accordé (sans révéler son existence).
    const t = c.terminal({ host: ids.labo });
    await t.opened;
    const ctl = await t.ready();
    assert.equal(ctl.t, 'error');
    assert.equal(ctl.code, 'NOT_FOUND');
  });

  test('lecture seule : lecture permise, toute écriture refusée', async () => {
    const ro = makeUser(env.corvus, { username: 'lecteur', password: 'mot-de-passe-lecteur', role: 'viewer' });
    // Même un droit « operator » ne dépasse pas le rôle du compte.
    env.corvus.ctx.users.setGrants(ro.id, [{ scope: 'host', target: ids.labo, role: 'operator' }]);
    const c = await asUser(ro);
    const list = await c.api('GET', '/api/hosts');
    assert.deepEqual(list.body.hosts.map((h) => [h.name, h.role]), [['labo', 'viewer']]);
    assert.equal((await c.api('POST', `/api/hosts/${ids.labo}/fs/mkdir`, { path: '/tmp/x' })).status, 403);
    assert.equal((await c.api('POST', `/api/hosts/${ids.labo}/monitor/kill`, { pid: 1234 })).status, 403);
    const t = c.terminal({ host: ids.labo });
    await t.opened;
    const ctl = await t.ready();
    assert.equal(ctl.code, 'FORBIDDEN');
  });

  test('variantes de casse et « / » final : mêmes refus que le chemin canonique', async () => {
    // Express route sans tenir compte de la casse ni du « / » final : le contrôle de rôle doit en faire autant.
    const ro = env.corvus.ctx.users.byName('lecteur');
    const c = await asUser({ ...ro, password: 'mot-de-passe-lecteur', secret: env.corvus.ctx.users.totpSecret(ro.id) });
    const H = ids.labo;
    for (const [m, u, b] of [
      ['GET', '/api/Users'], ['GET', '/api/USERS/'], ['POST', '/api/Users', { username: 'pirate', password: 'un-mot-de-passe-long-12', role: 'admin' }],
      ['GET', '/api/Agents'], ['GET', '/api/Journal/Verify'], ['GET', '/api/journal/verify/'], ['GET', '/api/Backups'],
      ['POST', '/api/hosts/', { name: 'z', hostname: 'z', username: 'pi' }], ['POST', '/api/Hosts', { name: 'z', hostname: 'z', username: 'pi' }],
      ['GET', '/api/system/config/'], ['GET', '/api/System/Config'],
      ['GET', `/api/hosts/${H}/Sudoers`], ['POST', `/api/hosts/${H}/Admin/firewall/ufw`, { action: 'allow', port: '8080' }],
      ['POST', `/api/hosts/${H}/hostkey/`, {}], ['POST', `/api/Hosts/${H}/admin/firewall/ufw`, { action: 'allow', port: '8080' }],
      ['PATCH', `/api/hosts/${H}/`, { name: 'x' }],
    ]) {
      const r = await c.api(m, u, b);
      assert.ok(r.status === 403 || r.status === 404, `${m} ${u} → ${r.status} (attendu 403/404)`);
    }
    assert.equal(env.corvus.ctx.users.byName('pirate'), undefined, 'aucun compte créé par un lecteur');
    // Un opérateur ne franchit pas non plus le niveau « admin de l'hôte » par une variante de casse.
    const opU = env.corvus.ctx.users.byName('ops');
    const o = await asUser({ ...opU, password: 'mot-de-passe-operateur', secret: env.corvus.ctx.users.totpSecret(opU.id) });
    const M = ids.maison;
    for (const [m, u, b] of [
      ['POST', `/api/hosts/${M}/Admin/firewall/ufw`, { action: 'allow', port: '8080' }], ['POST', `/api/hosts/${M}/HostKey`, {}],
      ['GET', '/api/Users'], ['PATCH', `/api/hosts/${M}/`, { name: 'x' }],
    ]) {
      const r = await o.api(m, u, b);
      assert.ok(r.status === 403 || r.status === 404, `opérateur : ${m} ${u} → ${r.status} (attendu 403/404)`);
    }
  });

  test('journal : un compte restreint ne voit que ses hôtes et ses actions', async () => {
    const op = env.corvus.ctx.users.byName('ops');
    const c = await asUser({ ...op, password: 'mot-de-passe-operateur', secret: env.corvus.ctx.users.totpSecret(op.id) });
    const r = await c.api('GET', '/api/journal');
    assert.equal(r.status, 200);
    for (const e of r.body.entries) assert.ok(!e.hostId || [ids.maison, ids.nas].includes(e.hostId), `entrée visible à tort : ${e.host}`);
    assert.ok(!r.body.entries.some((e) => e.event === 'host-create' && e.hostId === ids.labo));
    assert.equal((await c.api('GET', '/api/journal/verify')).status, 403);
  });

  test('actions attribuées au compte dans le journal (chaîne intacte)', async () => {
    const r = await admin.api('GET', '/api/journal?type=admin');
    assert.ok(r.body.entries.some((e) => e.event === 'host-create' && e.user === 'admin'));
    const v = await admin.api('GET', '/api/journal/verify');
    assert.equal(v.body.ok, true);
  });

  test('admin : création de compte → mot de passe provisoire à changer, puis TOTP', async () => {
    const r = await admin.api('POST', '/api/users', { username: 'nouveau', password: 'provisoire-12345', role: 'operator' });
    assert.equal(r.status, 201);
    const c = new CorvusClient(env.base, {});
    const login = await c.api('POST', '/api/auth/login', { username: 'nouveau', password: 'provisoire-12345' });
    assert.ok(login.body.enroll, 'enrôlement TOTP exigé à la première connexion');
    const res = await fetch(`${env.base}/api/auth/totp/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: login.body.enroll.enrollToken, code: totp.codeAt(login.body.enroll.secret, totp.stepAt()) }),
    });
    c.cookie = res.headers.get('set-cookie').split(';')[0];
    assert.equal((await c.api('GET', '/api/hosts')).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await c.api('POST', '/api/me/password', { current: 'provisoire-12345', next: 'mon-nouveau-mot-de-passe' })).status, 200);
    assert.equal((await c.api('GET', '/api/hosts')).status, 200);
  });

  test('dernier administrateur protégé ; compte désactivé → sessions coupées', async () => {
    const me = await admin.api('GET', '/api/me');
    assert.equal((await admin.api('PATCH', `/api/users/${me.body.user.id}`, { role: 'operator' })).body.error.code, 'LAST_ADMIN');
    const victim = env.corvus.ctx.users.byName('nouveau');
    const c = new CorvusClient(env.base, { corvus: env.corvus, user: { ...victim, password: 'mon-nouveau-mot-de-passe', secret: env.corvus.ctx.users.totpSecret(victim.id) } });
    await c.login();
    assert.equal((await c.api('GET', '/api/me')).status, 200);
    await admin.api('PATCH', `/api/users/${victim.id}`, { disabled: true });
    assert.equal((await c.api('GET', '/api/me')).status, 401);
  });

  test('jetons d\'API personnels (Bearer), révocables', async () => {
    const r = await admin.api('POST', '/api/me/tokens', { name: 'script' });
    const ok = await fetch(`${env.base}/api/me`, { headers: { authorization: `Bearer ${r.body.token}` } });
    assert.equal(ok.status, 200);
    await admin.api('DELETE', `/api/me/tokens/${r.body.id}`);
    const ko = await fetch(`${env.base}/api/me`, { headers: { authorization: `Bearer ${r.body.token}` } });
    assert.equal(ko.status, 401);
  });
});
