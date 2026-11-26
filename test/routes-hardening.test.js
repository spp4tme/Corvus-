// Routes restantes : alertes cloisonnées par hôte (liste ET acquittement), désabonnement push limité à son compte.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';

let env; let admin; let op; let hostA; let hostB;

before(async () => {
  env = await startCorvus();
  admin = env.client;
  await admin.login();
  const mk = async (name) => (await admin.api('POST', '/api/hosts', { name, hostname: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' })).body.host.id;
  hostA = await mk('accorde');
  hostB = await mk('interdit');
  const u = makeUser(env.corvus, { username: 'operateur', password: 'mot-de-passe-operateur-long', role: 'operator' });
  env.corvus.ctx.users.setGrants(u.id, [{ scope: 'host', target: hostA, role: 'operator' }]);
  op = new CorvusClient(env.base, { corvus: env.corvus, user: u });
  assert.equal((await op.login()).status, 200);
});
after(() => env?.close());

const insert = (hostId, kind) => Number(env.corvus.ctx.db.run('INSERT INTO alerts (ts, host_id, kind, severity, message) VALUES (?, ?, ?, ?, ?)',
  Date.now(), hostId, kind, 'critical', kind).lastInsertRowid);

test('un opérateur ne peut pas faire taire l\'alerte d\'un hôte qui ne lui est pas accordé', async () => {
  const foreign = insert(hostB, 'ransom:suspect');
  const mine = insert(hostA, 'anomaly:proc:x');
  assert.equal((await op.api('POST', `/api/alerts/${foreign}/ack`)).status, 404);
  assert.equal(env.corvus.ctx.db.get('SELECT ack_at FROM alerts WHERE id = ?', foreign).ack_at, null, 'toujours ouverte');
  assert.equal((await op.api('POST', `/api/alerts/${mine}/ack`)).status, 200);
  assert.equal((await admin.api('POST', `/api/alerts/${foreign}/ack`)).status, 200, 'l\'admin, lui, peut');
});

test('liste des alertes : celles de ses hôtes restent visibles même noyées sous celles des autres', async () => {
  const mine = insert(hostA, 'anomaly:proc:visible');
  for (let i = 0; i < 150; i++) insert(hostB, `bruit:${i}`);
  const list = (await op.api('GET', '/api/alerts')).body.alerts;
  assert.ok(list.some((a) => a.id === mine));
  assert.ok(!list.some((a) => a.hostId === hostB));
});

test('désabonnement push : seulement ses propres appareils', async () => {
  const db = env.corvus.ctx.db;
  const endpoint = 'https://fcm.googleapis.com/fcm/send/appareil-admin';
  db.run('INSERT INTO push_subscriptions (endpoint, user_id, label, created_at) VALUES (?, ?, ?, ?)', endpoint, env.admin.id, 'tel', Date.now());
  assert.equal((await op.api('DELETE', '/api/push/subscribe', { endpoint })).status, 200);
  assert.ok(db.get('SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?', endpoint), 'l\'appareil de l\'admin reste abonné');
  assert.equal((await admin.api('DELETE', '/api/push/subscribe', { endpoint })).status, 200);
  assert.ok(!db.get('SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?', endpoint));
});
