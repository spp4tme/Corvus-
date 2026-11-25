// Empreinte du normal : apprentissage, anomalies, heure creuse, gel automatique, autorisation.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCorvus } from './helpers/corvus.js';
import { aggregateDestination } from '../server/lib/behavior.js';

const DAY = 86_400_000;

describe('agrégation des destinations', () => {
  test('IPv4 → /24 + port, IPv6 → /48 + port', () => {
    assert.equal(aggregateDestination('203.0.113.45:443'), '203.0.113.0/24:443');
    assert.equal(aggregateDestination('[2001:db8:1:2::5]:22'), '2001:db8:1::/48:22');
    assert.equal(aggregateDestination(undefined), '?');
  });
});

describe('empreinte du normal', () => {
  let env; let hostId; let behavior; let frozen;
  const auth = () => ({ authorization: `Bearer ${env.token}`, 'content-type': 'application/json' });
  const api = async (method, url, body) => {
    const r = await fetch(env.base + url, { method, headers: auth(), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const start = (exe, extra = {}, ts = Date.now()) => ({ type: 'proc.start', ts, body: { pid: 4242, start: 777, exe, uid: 1000, ...extra } });
  const alerts = () => env.corvus.ctx.db.all("SELECT kind, severity, message FROM alerts WHERE kind LIKE 'anomaly:%'");

  before(async () => {
    env = await startCorvus();
    hostId = (await api('POST', '/api/hosts', { name: 'Empreinte', hostname: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' })).body.host.id;
    behavior = env.corvus.ctx.behavior;
    frozen = [];
    env.corvus.ctx.agents.request = async (h, name, args) => { frozen.push([h, name, args]); return {}; }; // l'agent n'est pas nécessaire ici
  });
  after(() => env?.close());

  test('pendant l\'apprentissage : tout est appris, aucune alerte', () => {
    behavior.ingest(hostId, start('/usr/bin/ls'));
    behavior.ingest(hostId, { type: 'conn.open', ts: Date.now(), body: { exe: '/usr/bin/curl', remote: '203.0.113.7:443' } });
    behavior.ingest(hostId, { type: 'port.open', ts: Date.now(), body: { item: 'tcp 0.0.0.0:22' } });
    const o = behavior.overview(hostId);
    assert.equal(o.learning, true);
    assert.deepEqual([o.counts.proc, o.counts.conn, o.counts.listen], [1, 1, 1]);
    assert.equal(alerts().length, 0);
  });

  test('après l\'apprentissage : seul un élément JAMAIS vu déclenche une alerte', () => {
    env.corvus.ctx.db.setMeta(`behavior.start.${hostId}`, Date.now() - 20 * DAY);
    assert.equal(behavior.learning(hostId), false);
    behavior.ingest(hostId, start('/usr/bin/ls')); // connu
    behavior.ingest(hostId, { type: 'conn.open', ts: Date.now(), body: { exe: '/usr/bin/curl', remote: '203.0.113.99:443' } }); // même /24 : connu
    assert.equal(alerts().length, 0);
    behavior.ingest(hostId, start('/tmp/inconnu', { via: { ssh: 'mallory' }, lineage: [{ comm: 'sshd' }] }));
    const a = alerts();
    assert.equal(a.length, 1);
    assert.match(a[0].message, /Programme jamais vu — \/tmp\/inconnu · 1000.*session SSH de mallory/);
    assert.equal(a[0].severity, 'warn');
    // Même élément une 2e fois : pas de nouvelle alerte ni de nouvelle anomalie.
    behavior.ingest(hostId, start('/tmp/inconnu'));
    assert.equal(alerts().length, 1);
    assert.equal(behavior.overview(hostId).anomalies.length, 1);
    behavior.ingest(hostId, { type: 'conn.open', ts: Date.now(), body: { exe: '/usr/bin/curl', remote: '198.51.100.1:4444' } });
    behavior.ingest(hostId, { type: 'port.open', ts: Date.now(), body: { item: 'tcp 0.0.0.0:31337' } });
    assert.deepEqual(behavior.overview(hostId).anomalies.map((x) => x.kind).sort(), ['conn', 'listen', 'proc']);
  });

  test('autoriser un élément le retire des anomalies (journalisé)', async () => {
    assert.equal((await api('POST', `/api/hosts/${hostId}/behavior/allow`, { kind: 'proc', item: '/tmp/inconnu|1000' })).status, 200);
    assert.equal(behavior.overview(hostId).anomalies.some((x) => x.kind === 'proc'), false);
    assert.equal((await api('POST', `/api/hosts/${hostId}/behavior/allow`, { kind: 'proc', item: 'n/existe/pas' })).status, 404);
    assert.equal((await fetch(`${env.base}/api/hosts/${hostId}/behavior`)).status, 401);
  });

  test('heure creuse : alerte critique + gel automatique SEULEMENT si activé', async () => {
    const db = env.corvus.ctx.db;
    const nowHour = new Date().getHours();
    // Historique : beaucoup d'activité apprise, aucune à l'heure courante.
    for (let h = 0; h < 24; h++) if (h !== nowHour) db.run("INSERT OR REPLACE INTO behavior_profile (host_id, kind, item, count, first_seen, last_seen, allowed) VALUES (?, 'hour', ?, 50, 1, 1, 1)", hostId, String(h));
    db.run("DELETE FROM behavior_profile WHERE host_id = ? AND kind = 'hour' AND item = ?", hostId, String(nowHour));
    behavior.ingest(hostId, start('/tmp/nuit-1', { pid: 111, start: 11 }));
    assert.equal(alerts().find((a) => a.message.includes('nuit-1')).severity, 'critical');
    assert.match(alerts().find((a) => a.message.includes('nuit-1')).message, /heure habituellement calme/);
    assert.equal(frozen.length, 0, 'gel automatique désactivé par défaut');

    assert.equal((await api('PUT', `/api/hosts/${hostId}/behavior/settings`, { autoFreeze: true })).body.autoFreeze, true);
    behavior.ingest(hostId, start('/tmp/nuit-2', { pid: 222, start: 22 }));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(frozen, [[hostId, 'proc.freeze', { pid: 222, start: 22 }]]);
    const j = db.all("SELECT event FROM audit WHERE type = 'behavior'").map((r) => r.event);
    assert.ok(j.includes('auto-freeze') && j.includes('anomaly'));
  });

  test('recommencer l\'apprentissage exige une confirmation', async () => {
    assert.equal((await api('POST', `/api/hosts/${hostId}/behavior/restart`, {})).status, 400);
    const r = await api('POST', `/api/hosts/${hostId}/behavior/restart`, { confirm: true, days: 7 });
    assert.equal(r.status, 200);
    assert.equal(r.body.learning, true);
    assert.equal(r.body.learnDays, 7);
    assert.deepEqual(r.body.counts, {});
  });
});
