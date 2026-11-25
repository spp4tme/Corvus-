// Radiographie (étape 7.1) avec le vrai agent : processus, lignée, connexions, gel / dégel / arrêt.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startCorvus, waitFor } from './helpers/corvus.js';

const run = promisify(execFile);
const AGENT_BIN = process.env.CORVUS_AGENT_BIN
  || ['debug', 'release'].map((p) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'target', p, 'corvus-agent')).find((p) => fs.existsSync(p));

describe('radiographie avec le vrai agent', { skip: AGENT_BIN ? false : 'binaire non compilé (cd agent && cargo build)' }, () => {
  let env; let hostId; let agent; let dir; let target; let server; let client;
  const auth = () => ({ authorization: `Bearer ${env.token}`, 'content-type': 'application/json' });
  const api = async (method, url, body) => {
    const r = await fetch(env.base + url, { method, headers: auth(), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const stateOf = (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').pop().trim()[0];

  before(async () => {
    env = await startCorvus();
    hostId = (await api('POST', '/api/hosts', { name: 'Xray', hostname: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' })).body.host.id;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-agent-'));
    const t = (await api('POST', '/api/agents/enrollments', { hostId })).body;
    await run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', dir]);
    agent = spawn(AGENT_BIN, ['run', '--dir', dir, '--watch', dir, '--interval', '1'], { stdio: 'pipe' });
    await waitFor(() => env.corvus.ctx.agents.forHost(hostId)?.online, 15000);
    // Une connexion sortante non locale ne peut pas être garantie en test : on observe la connexion vers le serveur de test (loopback ignorée),
    // donc on vérifie le chemin « live » sur les processus uniquement.
    // Le processus de test doit naître APRÈS l'instantané initial de l'agent, sinon il en ferait partie.
    await waitFor(async () => (await api('GET', `/api/hosts/${hostId}/rewind/events?type=proc.snapshot`)).body.events.length, 15000, 200);
    target = spawn('sleep', ['120'], { stdio: 'ignore' });
    server = net.createServer().listen(0, '127.0.0.1');
  });
  after(async () => { agent?.kill(); target?.kill('SIGKILL'); server?.close(); client?.destroy(); await env?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('événements : un processus démarré est vu, avec sa lignée', async () => {
    const ev = await waitFor(async () => (await api('GET', `/api/hosts/${hostId}/rewind/events?type=proc.start&limit=200`)).body.events.find((e) => e.body.pid === target.pid), 15000, 300);
    assert.match(ev.body.exe, /sleep$/);
    assert.ok(ev.body.lineage.length >= 1);
    assert.equal(ev.body.lineage[0].pid, process.pid, 'le parent direct est ce processus de test');
    assert.equal(ev.body.uid, process.getuid());
  });

  test('instantané en direct : processus avec identifiant (pid, start)', async () => {
    const live = (await api('GET', `/api/hosts/${hostId}/xray/live`)).body;
    const p = live.processes.find((x) => x.pid === target.pid);
    assert.ok(p && p.start > 0);
    assert.ok(Array.isArray(live.connections));
  });

  test('geler, dégeler, tuer : confirmation, bon identifiant, journal', async () => {
    const live = (await api('GET', `/api/hosts/${hostId}/xray/live`)).body;
    const p = live.processes.find((x) => x.pid === target.pid);
    const base = { pid: p.pid, start: p.start };
    assert.equal((await api('POST', `/api/hosts/${hostId}/xray/proc`, { ...base, action: 'freeze' })).status, 400, 'confirmation obligatoire');
    assert.equal((await api('POST', `/api/hosts/${hostId}/xray/proc`, { ...base, action: 'freeze', confirm: true })).status, 200);
    await waitFor(() => stateOf(target.pid) === 'T', 3000);
    assert.equal((await api('POST', `/api/hosts/${hostId}/xray/proc`, { ...base, start: p.start + 1, action: 'thaw', confirm: true })).status, 422, 'pid réutilisé / mauvais starttime refusé');
    assert.equal((await api('POST', `/api/hosts/${hostId}/xray/proc`, { ...base, action: 'thaw', confirm: true })).status, 200);
    await waitFor(() => stateOf(target.pid) !== 'T', 3000);
    assert.equal((await api('POST', `/api/hosts/${hostId}/xray/proc`, { ...base, action: 'kill', confirm: true })).status, 200);
    await waitFor(() => target.exitCode !== null || target.signalCode, 3000);
    const j = env.corvus.ctx.db.all("SELECT event FROM audit WHERE type = 'xray'").map((r) => r.event);
    assert.deepEqual(['freeze', 'thaw-failed', 'thaw', 'kill'].filter((e) => !j.includes(e)), []);
  });

  test('processus protégés et agent lui-même : refusés', async () => {
    const r1 = await api('POST', `/api/hosts/${hostId}/xray/proc`, { pid: 1, start: 0, action: 'kill', confirm: true });
    assert.equal(r1.status, 400, 'pid 1 refusé dès la validation');
    const live = (await api('GET', `/api/hosts/${hostId}/xray/live`)).body;
    const self = live.processes.find((x) => x.pid === agent.pid);
    const r2 = await api('POST', `/api/hosts/${hostId}/xray/proc`, { pid: self.pid, start: self.start, action: 'kill', confirm: true });
    assert.equal(r2.status, 422);
    assert.match(JSON.stringify(r2.body), /agent lui-même|protégé/);
  });

  test('sans authentification : refus', async () => {
    assert.equal((await fetch(`${env.base}/api/hosts/${hostId}/xray/live`)).status, 401);
  });
});
