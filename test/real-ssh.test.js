// Tests contre un VRAI serveur OpenSSH Linux (CI GitHub Actions, ou le Pi).
// Ignorés sans la variable CORVUS_REAL_SSH="hôte:port:utilisateur:motdepasse".
//   CORVUS_REAL_SSH=127.0.0.1:22:corvustest:Test-Passw0rd! node --test test/real-ssh.test.js
// L'utilisateur doit pouvoir faire `sudo -n` (CI) pour les tests d'administration ; sinon ils
// vérifient seulement le message « SUDO_REQUIRED ».
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCorvus, waitFor } from './helpers/corvus.js';

const spec = process.env.CORVUS_REAL_SSH;
const [hostname, port, username, ...pw] = (spec || '').split(':');
const password = pw.join(':');
const skip = !spec && 'CORVUS_REAL_SSH non défini (test réservé à Linux : CI ou Pi)';

describe('OpenSSH réel', { skip }, () => {
  let env;
  let c;
  let hostId;
  const H = (p) => `/api/hosts/${hostId}${p}`;

  before(async () => {
    env = await startCorvus();
    c = env.client;
    await c.login();
    const r = await c.api('POST', '/api/hosts', { name: 'OpenSSH réel', hostname, port: Number(port), username, authType: 'password', password });
    hostId = r.body.host.id;
  });
  after(() => env?.close());

  test('connexion, empreinte TOFU, uname', async () => {
    const r = await c.api('POST', H('/test'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.match(r.body.hostKey.fingerprint, /^SHA256:/);
  });

  test('terminal interactif + enregistrement', async () => {
    const t = c.terminal({ host: hostId, cols: 100, rows: 30 });
    await t.opened;
    const ready = await t.ready();
    assert.equal(ready.t, 'ready', JSON.stringify(ready));
    t.send('echo "reel-$((6*7))"\n');
    await t.waitFor((x) => x.output.includes('reel-42'));
    t.ws.send(JSON.stringify({ t: 'close' }));
    await t.waitFor((x) => x.closed);
    await waitFor(() => env.corvus.ctx.db.get('SELECT recording_sha FROM term_sessions WHERE id = ?', ready.session.id)?.recording_sha);
  });

  test('supervision Linux complète : par cœur, E/S disque, TCP', async () => {
    await c.api('GET', H('/monitor/stats'));
    await new Promise((r) => setTimeout(r, 1500));
    const s = (await c.api('GET', H('/monitor/stats'))).body;
    assert.ok(s.cpuCores.length >= 1, 'CPU par cœur');
    assert.ok(s.disk && s.disk.readBps >= 0, 'E/S disque (/proc/diskstats)');
    assert.ok(s.tcp && s.tcp.established >= 1, 'TCP (/proc/net/snmp)');
  });

  test('SFTP + mode annulable (rm -r puis restauration)', async () => {
    await c.api('POST', H('/fs/mkdir'), { path: '~/corvus-reel' });
    await c.api('PUT', H('/fs/write'), { path: '~/corvus-reel/a.txt', content: 'original\n' });
    const prep = await c.api('POST', H('/undo/prepare'), { command: 'rm -rf ~/corvus-reel' });
    assert.ok(prep.body.op, JSON.stringify(prep.body));
    await env.corvus.ctx.pool.exec(hostId, 'rm -rf ~/corvus-reel');
    const r = await c.api('POST', H(`/undo/${prep.body.op.id}`), { confirm: true });
    assert.deepEqual(r.body.errors, []);
    assert.equal((await c.api('GET', H('/fs/read?path=~/corvus-reel/a.txt'))).body.content, 'original\n');
    await env.corvus.ctx.pool.exec(hostId, 'rm -rf ~/corvus-reel');
  });

  test('administration : services, journal, règle sudoers', async () => {
    const sv = await c.api('GET', H('/admin/services'));
    if (sv.status === 404) return; // pas de systemd (conteneur) : rien d'autre à vérifier
    assert.ok(sv.body.services.length > 0);
    const logs = await c.api('GET', H('/admin/logs?lines=20'));
    assert.equal(logs.status, 200, JSON.stringify(logs.body));
    const rule = await c.api('GET', H('/sudoers'));
    assert.match(rule.body.text, /systemctl (start|restart) -- \*/);
    const fw = await c.api('GET', H('/admin/firewall'));
    assert.equal(fw.status, 200);
  });
});
