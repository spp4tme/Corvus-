// Tests de bout en bout : Corvus réel + sshd de test (ou un vrai sshd via CORVUS_TEST_SSH_*).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus } from './helpers/corvus.js';

let sshd;
let env;
let c;
let hostId;

before(async () => {
  sshd = await startFakeSshd();
  env = await startCorvus();
  c = env.client;
});

after(async () => {
  await env?.close();
  await sshd?.close();
});

const hostBody = (extra = {}) => ({
  name: 'Banc de test',
  hostname: '127.0.0.1',
  port: sshd.port,
  username: sshd.user,
  authType: 'password',
  password: sshd.password,
  icon: 'pi',
  group: 'Labo',
  ...extra,
});

describe('authentification', () => {
  test('API refusée sans authentification', async () => {
    const r = await c.api('GET', '/api/hosts');
    assert.equal(r.status, 401);
  });

  test('mauvais token refusé, puis bon token accepté (cookie HttpOnly SameSite=Strict)', async () => {
    const bad = await c.login('cv_faux');
    assert.equal(bad.status, 401);
    const ok = await c.login();
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });

  test('Bearer accepté, Bearer invalide refusé', async () => {
    const ok = await fetch(`${env.base}/api/hosts`, { headers: { authorization: `Bearer ${env.token}` } });
    assert.equal(ok.status, 200);
    const ko = await fetch(`${env.base}/api/hosts`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(ko.status, 401);
  });

  test('CSRF : mutation par cookie sans en-tête X-Corvus refusée', async () => {
    const r = await c.api('POST', '/api/hosts', hostBody(), { csrf: false });
    assert.equal(r.status, 403);
  });

  test('CSRF : origine étrangère refusée', async () => {
    const r = await c.api('POST', '/api/hosts', hostBody(), { headers: { origin: 'https://evil.example' }, csrf: true });
    // l'en-tête origin passé écrase celui du client
    assert.equal(r.status, 403);
  });

  test('en-têtes de sécurité (CSP stricte pour les scripts)', async () => {
    const r = await fetch(`${env.base}/`);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('hôtes', () => {
  test('validation des entrées', async () => {
    const r = await c.api('POST', '/api/hosts', hostBody({ hostname: 'bad host;rm -rf /' }));
    assert.equal(r.status, 400);
    const r2 = await c.api('POST', '/api/hosts', hostBody({ port: 70000 }));
    assert.equal(r2.status, 400);
  });

  test('création : les secrets ne sont jamais renvoyés ni stockés en clair', async () => {
    const r = await c.api('POST', '/api/hosts', hostBody());
    assert.equal(r.status, 201);
    hostId = r.body.host.id;
    assert.equal(r.body.host.hasPassword, true);
    assert.equal(r.body.host.password, undefined);
    const list = await c.api('GET', '/api/hosts');
    assert.ok(!JSON.stringify(list.body).includes(sshd.password));
    for (const f of fs.readdirSync(env.dataDir)) {
      const content = fs.readFileSync(path.join(env.dataDir, f), 'utf8');
      assert.ok(!content.includes(sshd.password), `secret en clair dans ${f}`);
    }
  });

  test('mise à jour partielle (épingle, groupe, tmux)', async () => {
    const r = await c.api('PATCH', `/api/hosts/${hostId}`, { pinned: true, group: 'Maison', tmux: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.host.pinned, true);
    assert.equal(r.body.host.group, 'Maison');
    assert.equal(r.body.host.hasPassword, true);
  });

  test('tester la connexion : TOFU mémorise l\'empreinte', async () => {
    const r1 = await c.api('POST', `/api/hosts/${hostId}/test`);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.ok, true);
    assert.equal(r1.body.hostKey.firstSeen, true);
    assert.match(r1.body.hostKey.fingerprint, /^SHA256:/);
    const r2 = await c.api('POST', `/api/hosts/${hostId}/test`);
    assert.equal(r2.body.hostKey.firstSeen, false);
  });

  test('mauvais mot de passe → SSH_AUTH', async () => {
    const r = await c.api('POST', '/api/hosts/test', hostBody({ password: 'faux' }));
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'SSH_AUTH');
  });

  test('clé privée chiffrée + passphrase', async () => {
    const noPass = await c.api('POST', '/api/hosts', hostBody({ authType: 'key', password: undefined, privateKey: sshd.clientKey.private }));
    assert.equal(noPass.status, 400);
    const r = await c.api('POST', '/api/hosts', hostBody({
      name: 'Clé', authType: 'key', password: undefined, privateKey: sshd.clientKey.private, passphrase: 'phrase-test',
    }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.host.hasKey, true);
    const t = await c.api('POST', `/api/hosts/${r.body.host.id}/test`);
    assert.equal(t.body.ok, true, JSON.stringify(t.body));
    const del = await c.api('DELETE', `/api/hosts/${r.body.host.id}`);
    assert.equal(del.status, 200);
  });
});

describe('terminal', () => {
  test('WebSocket : origine étrangère refusée', async () => {
    const t = c.terminal({ host: hostId }, { origin: 'https://evil.example' });
    await assert.rejects(t.opened, (e) => e.status === 403);
  });

  test('WebSocket : sans cookie refusé', async () => {
    const saved = c.cookie;
    c.cookie = null;
    const t = c.terminal({ host: hostId });
    await assert.rejects(t.opened, (e) => e.status === 401);
    c.cookie = saved;
  });

  let sessionId;
  let received = 0;
  test('ouverture, entrée/sortie', async () => {
    const t = c.terminal({ host: hostId, cols: 100, rows: 30 });
    await t.opened;
    const ready = await t.ready();
    assert.equal(ready.t, 'ready', JSON.stringify(ready));
    sessionId = ready.session.id;
    t.send('echo corvus-$((40+2))\n');
    await t.waitFor((x) => x.output.includes('corvus-42'));
    t.ws.send(JSON.stringify({ t: 'r', c: 120, r: 40 }));
    received = Buffer.byteLength(t.output);
    t.ws.close();
    await t.waitFor((x) => x.closed);
  });

  test('reconnexion : la session survit et reprend à l\'offset', async () => {
    const list = await c.api('GET', '/api/terminals');
    assert.ok(list.body.terminals.some((x) => x.id === sessionId));
    const t = c.terminal({ session: sessionId, since: received });
    await t.opened;
    const ready = await t.ready();
    assert.equal(ready.t, 'ready');
    assert.equal(ready.reset, false);
    t.send('echo reprise-ok\n');
    await t.waitFor((x) => x.output.includes('reprise-ok'));
    assert.ok(!t.output.includes('corvus-42'), 'pas de rejeu de ce qui a déjà été reçu');
    t.ws.send(JSON.stringify({ t: 'close' }));
    await t.waitFor((x) => x.closed);
  });

  test('mode tmux : repli propre si tmux est absent', async () => {
    const t = c.terminal({ host: hostId, tmux: '1', tmuxSession: 'essai' });
    await t.opened;
    await t.ready();
    t.send('echo apres-tmux\n');
    await t.waitFor((x) => x.output.includes('apres-tmux') || x.output.includes('tmux'));
    t.ws.send(JSON.stringify({ t: 'close' }));
  });

  test('journal des connexions', async () => {
    const r = await c.api('GET', '/api/journal?type=terminal');
    assert.ok(r.body.entries.some((e) => e.event === 'open' && e.hostId === hostId));
  });
});

describe('host key TOFU', () => {
  test('changement d\'empreinte détecté puis réinitialisation explicite', async () => {
    const port = sshd.port;
    await sshd.close();
    sshd = await startFakeSshd({ port });
    const r = await c.api('POST', `/api/hosts/${hostId}/test`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'HOSTKEY_MISMATCH');
    assert.match(r.body.error.details.received, /^SHA256:/);
    const reset = await c.api('DELETE', `/api/hosts/${hostId}/hostkey`);
    assert.equal(reset.status, 200);
    // nouveau mot de passe identique : le nouveau sshd a le même
    const again = await c.api('POST', `/api/hosts/${hostId}/test`);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.hostKey.firstSeen, true);
  });
});
