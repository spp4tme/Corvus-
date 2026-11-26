// Un terminal déjà ouvert ne survit pas à la perte des droits : compte désactivé, déconnexion, rôle retiré.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';

let env; let sshd; let admin; let hostId;

before(async () => {
  sshd = await startFakeSshd();
  env = await startCorvus();
  admin = env.client;
  await admin.login();
  const h = await admin.api('POST', '/api/hosts', { name: 'cible', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
  hostId = h.body.host.id;
});
after(async () => { await sshd?.close(); await env?.close(); });

async function operatorWithTerminal(name) {
  const u = makeUser(env.corvus, { username: name, password: `mot-de-passe-${name}-long`, role: 'operator' });
  env.corvus.ctx.users.setGrants(u.id, [{ scope: 'host', target: hostId, role: 'operator' }]);
  const c = new CorvusClient(env.base, { corvus: env.corvus, user: u });
  assert.equal((await c.login()).status, 200);
  const t = c.terminal({ host: hostId, tmux: '0' });
  await t.opened;
  assert.equal((await t.ready()).t, 'ready');
  return { u, c, t };
}

test('compte désactivé : son terminal ouvert est coupé tout de suite', async () => {
  const { u, t } = await operatorWithTerminal('desactive');
  assert.equal((await admin.api('PATCH', `/api/users/${u.id}`, { disabled: true })).status, 200);
  await t.waitFor((x) => x.closed, 5000);
  assert.ok(t.ctl.some((c) => c.code === 'REVOKED'));
});

test('déconnexion : le terminal rattaché à cette session est coupé', async () => {
  const { c, t } = await operatorWithTerminal('sortant');
  assert.equal((await c.api('POST', '/api/auth/logout')).status, 200);
  await t.waitFor((x) => x.closed, 5000);
});

test('droit sur l\'hôte retiré : la session du propriétaire est fermée', async () => {
  const { u, t } = await operatorWithTerminal('retire');
  assert.equal((await admin.api('PUT', `/api/users/${u.id}/grants`, { grants: [] })).status, 200);
  await t.waitFor((x) => x.closed, 5000);
  assert.equal(env.corvus.ctx.terminals.list().filter((s) => s.ownerId === u.id).length, 0);
});

test('droit sur l\'hôte retiré : ses enregistrements de session ne sont plus relisibles', async () => {
  const { u, c, t } = await operatorWithTerminal('relecture');
  t.send('echo trace-a-relire\n');
  await t.waitFor((x) => x.output.includes('trace-a-relire'));
  const sid = env.corvus.ctx.terminals.list().find((s) => s.ownerId === u.id).id;
  t.ws.send(JSON.stringify({ t: 'close' }));
  await t.waitFor((x) => x.closed, 5000);
  const db = env.corvus.ctx.db;
  for (let i = 0; i < 100 && !db.get('SELECT recording_sha FROM term_sessions WHERE id = ?', sid)?.recording_sha; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await c.api('GET', `/api/recordings/${sid}`)).status, 200);
  assert.ok((await c.api('GET', '/api/recordings')).body.recordings.some((r) => r.id === sid));
  assert.equal((await admin.api('PUT', `/api/users/${u.id}/grants`, { grants: [] })).status, 200);
  assert.equal((await c.api('GET', `/api/recordings/${sid}`)).status, 404);
  assert.ok(!(await c.api('GET', '/api/recordings')).body.recordings.some((r) => r.id === sid));
});
