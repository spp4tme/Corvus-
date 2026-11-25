// Anti-ransomware de bout en bout : un FAUX ransomware (deploy/demo/fake-ransomware.sh, confiné à son dossier de
// démo) « chiffre » 30 documents ; le vrai agent détecte la rafale et le fichier piège, Corvus alerte, puis
// « Rembobiner » remet tout en place. L'isolement réseau n'est PAS appliqué ici (il couperait le réseau de la
// machine de test) : ses règles sont vérifiées par les tests Rust et `nft -c` ; les réactions automatiques le sont
// ici avec un agent simulé.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startCorvus, waitFor } from './helpers/corvus.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(here, '..', 'deploy', 'demo', 'fake-ransomware.sh');
const AGENT_BIN = process.env.CORVUS_AGENT_BIN
  || ['debug', 'release'].map((p) => path.join(here, '..', 'agent', 'target', p, 'corvus-agent')).find((p) => fs.existsSync(p));

describe('le faux ransomware refuse tout sauf son dossier de démonstration', () => {
  test('dossiers interdits', async () => {
    for (const d of [os.homedir(), '/etc', '/tmp', '/tmp/corvus-ransomware-demo-inexistant']) {
      await assert.rejects(run('bash', [DEMO, 'attack', d]), (e) => e.code === 2, d);
    }
    // Un lien symbolique portant le bon nom est refusé aussi.
    const link = `/tmp/corvus-ransomware-demo-lien-${process.pid}`;
    fs.symlinkSync(os.homedir(), link);
    try { await assert.rejects(run('bash', [DEMO, 'attack', link]), (e) => e.code === 2); } finally { fs.unlinkSync(link); }
  });
});

describe('défense anti-ransomware avec le vrai agent', { skip: AGENT_BIN ? false : 'binaire non compilé (cd agent && cargo build)' }, () => {
  let env; let hostId; let agent; let dir; let demo; let originals;
  const auth = () => ({ authorization: `Bearer ${env.token}`, 'content-type': 'application/json' });
  const api = async (method, url, body) => {
    const r = await fetch(env.base + url, { method, headers: auth(), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const events = async (type) => (await api('GET', `/api/hosts/${hostId}/rewind/events?type=${type}&limit=200`)).body.events;

  before(async () => {
    env = await startCorvus();
    hostId = (await api('POST', '/api/hosts', { name: 'Victime', hostname: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' })).body.host.id;
    const { stdout } = await run('bash', [DEMO, 'prepare']);
    demo = /Dossier de démonstration : (\S+)/.exec(stdout)[1];
    originals = Object.fromEntries(fs.readdirSync(demo).filter((f) => !f.startsWith('.')).map((f) => [f, fs.readFileSync(path.join(demo, f), 'utf8')]));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-agent-'));
    const t = (await api('POST', '/api/agents/enrollments', { hostId })).body;
    await run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', dir]);
    agent = spawn(AGENT_BIN, ['run', '--dir', dir, '--watch', demo, '--canary', demo, '--ransom-threshold', '10', '--scan-interval', '1', '--interval', '1'], { stdio: 'pipe' });
    await waitFor(async () => (await events('file.baseline')).length >= 33, 20000, 300); // 30 documents + 3 fichiers pièges
    originals = Object.fromEntries(fs.readdirSync(demo).filter((f) => !f.startsWith('.')).map((f) => [f, fs.readFileSync(path.join(demo, f), 'utf8')]));
  });
  after(async () => { agent?.kill(); await env?.close(); if (demo) await run('bash', [DEMO, 'clean', demo]).catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });

  test('attaque : fichier piège + rafale de fichiers chiffrés détectés, alerte critique, journal', async () => {
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 1500));
    globalThis.__T = Date.now();
    await new Promise((r) => setTimeout(r, 1500));
    await run('bash', [DEMO, 'attack', demo]);
    const canary = await waitFor(async () => (await events('canary')).find((e) => e.ts > before), 20000, 300);
    assert.match(canary.body.path, /!corvus-leurre/);
    const burst = await waitFor(async () => (await events('ransom.suspect'))[0], 20000, 300);
    assert.ok(burst.body.count >= 10 && burst.body.sample.length > 0);
    const alerts = env.corvus.ctx.db.all("SELECT severity, message FROM alerts WHERE kind LIKE 'ransom:%'");
    assert.ok(alerts.length >= 2 && alerts.every((a) => a.severity === 'critical'));
    assert.ok(alerts.some((a) => /RANSOMWARE POSSIBLE/.test(a.message) && /Victime/.test(a.message)));
    assert.match(alerts.find((a) => /fichier piège/.test(a.message)).message, /aucune réaction automatique/, 'rien n\'est fait sans option explicite');
    const j = env.corvus.ctx.db.all("SELECT event FROM audit WHERE type = 'ransom'").map((r) => r.event);
    assert.ok(j.includes('canary') && j.includes('suspect'));
  });

  test('rembobiner : tout est restauré à l\'identique, les fichiers .locked disparaissent', async () => {
    await waitFor(() => fs.readdirSync(demo).some((f) => f === 'LISEZ-MOI.txt'), 5000);
    await waitFor(async () => (await events('file.created')).some((e) => e.body.path.endsWith('LISEZ-MOI.txt')) && (await events('file.deleted')).length >= 33, 20000, 300);
    const T = globalThis.__T;
    const ch = (await api('GET', `/api/hosts/${hostId}/rewind/changes?at=${T}`)).body.changes;
    assert.ok(ch.length >= 60, `${ch.length} différences`);
    assert.ok(ch.filter((c) => c.action === 'restore').every((c) => c.restorable));
    const done = await api('POST', `/api/hosts/${hostId}/rewind/restore`, { at: T, paths: ch.map((c) => c.path), confirm: true });
    assert.equal(done.status, 200);
    assert.ok(done.body.results.every((r) => r.ok), JSON.stringify(done.body.results.filter((r) => !r.ok)));
    const now = Object.fromEntries(fs.readdirSync(demo).filter((f) => !f.startsWith('.')).map((f) => [f, fs.readFileSync(path.join(demo, f), 'utf8')]));
    assert.deepEqual(now, originals, 'chaque fichier est identique à l\'original');
  });

  test('réactions automatiques (agent simulé) : gel + isolement seulement si activés', async () => {
    const calls = [];
    const real = env.corvus.ctx.agents.request;
    env.corvus.ctx.agents.request = async (h, name, args) => { calls.push([name, args]); return {}; };
    try {
      const writers = [{ pid: 4321, start: 99, exe: '/tmp/malware', writtenBytes: 1e6 }];
      const ev = { type: 'ransom.suspect', ts: Date.now(), body: { count: 12, windowSec: 30, threshold: 10, sample: ['/h/a'], writers } };
      env.corvus.ctx.behavior.ingest(hostId, ev);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(calls, [], 'options désactivées : aucune réaction');
      await api('PUT', `/api/hosts/${hostId}/behavior/settings`, { autoFreeze: true, autoIsolate: true, isolateTtl: 300 });
      env.corvus.ctx.db.run("DELETE FROM alerts WHERE kind LIKE 'ransom:%'");
      env.corvus.ctx.behavior.ingest(hostId, ev);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(calls, [['proc.freeze', { pid: 4321, start: 99 }], ['net.isolate', { ttlSec: 300 }]]);
      const a = env.corvus.ctx.db.get("SELECT message FROM alerts WHERE kind LIKE 'ransom:%' ORDER BY id DESC");
      assert.match(a.message, /gelé/);
      assert.match(a.message, /isolé du réseau 300 s \(Tailscale et Corvus conservés\)/);
    } finally { env.corvus.ctx.agents.request = real; }
  });

  test('isolement manuel : confirmation obligatoire, administrateur, journalisé', async () => {
    const calls = [];
    const real = env.corvus.ctx.agents.request;
    env.corvus.ctx.agents.request = async (h, name, args) => { calls.push([name, args]); return { isolated: name === 'net.isolate' }; };
    try {
      assert.equal((await api('POST', `/api/hosts/${hostId}/isolation`, { action: 'isolate' })).status, 400);
      assert.equal((await api('POST', `/api/hosts/${hostId}/isolation`, { action: 'isolate', ttlSec: 5, confirm: true })).status, 400, 'durée minimale 60 s');
      assert.equal((await api('POST', `/api/hosts/${hostId}/isolation`, { action: 'isolate', ttlSec: 120, confirm: true })).status, 200);
      assert.equal((await api('POST', `/api/hosts/${hostId}/isolation`, { action: 'release', confirm: true })).status, 200);
      assert.deepEqual(calls, [['net.isolate', { ttlSec: 120 }], ['net.release', {}]]);
      assert.equal((await fetch(`${env.base}/api/hosts/${hostId}/isolation`)).status, 401);
    } finally { env.corvus.ctx.agents.request = real; }
    const j = env.corvus.ctx.db.all("SELECT event FROM audit WHERE type = 'ransom'").map((r) => r.event);
    assert.ok(j.includes('isolate') && j.includes('release'));
  });
});
