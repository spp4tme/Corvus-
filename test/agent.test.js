// Agent Corvus : enrôlement, authentification mutuelle Ed25519, événements idempotents, métriques.
// L'« agent » est simulé en Node avec les mêmes opérations cryptographiques que le binaire Rust.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { startCorvus, waitFor } from './helpers/corvus.js';
import { publicKeyFromRaw, signedText } from '../server/lib/agents.js';

let env;
let hostId;
const auth = () => ({ authorization: `Bearer ${env.token}`, 'content-type': 'application/json' });
const post = (url, body, headers = auth()) => fetch(env.base + url, { method: 'POST', headers, body: JSON.stringify(body) });

before(async () => {
  env = await startCorvus();
  const r = await post('/api/hosts', { name: 'Hôte agent', hostname: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' });
  assert.equal(r.status, 201);
  hostId = (await r.json()).host.id;
});
after(() => env?.close());

function newAgentKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicB64: spki.subarray(spki.length - 32).toString('base64') };
}

async function enrollAgent(key = newAgentKey()) {
  const t = await (await post('/api/agents/enrollments', { hostId })).json();
  const res = await fetch(`${env.base}/api/agent/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: t.token, publicKey: key.publicB64, version: '0.1.0', hostname: 'pi', capabilities: { fanotify: false } }),
  });
  return { res, token: t.token, key, body: await res.json().catch(() => null) };
}

/** Client WebSocket qui se comporte comme l'agent Rust. */
function connect(agentId, key, { forgeSignature = false, serverKey } = {}) {
  const ws = new WebSocket(`${env.base.replace('http', 'ws')}/agent`);
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const a = { ws, inbox, closed: null };
  ws.on('close', (code) => { a.closed = code; });
  a.send = (type, body = {}) => ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), type, ts: Date.now(), body }));
  a.next = (type) => waitFor(() => inbox.find((m) => m.type === type), 5000);
  a.handshake = async () => {
    const hello = await a.next('hello');
    const myChallenge = crypto.randomBytes(32).toString('base64');
    const sig = crypto.sign(null, signedText('agent', hello.body.challenge), forgeSignature ? newAgentKey().privateKey : key.privateKey);
    a.send('auth', { agentId, signature: sig.toString('base64'), challenge: myChallenge });
    return { myChallenge };
  };
  return a;
}

describe('enrôlement', () => {
  test('jeton à usage unique : le second usage est refusé', async () => {
    const e = await enrollAgent();
    assert.equal(e.res.status, 200);
    assert.match(e.body.agentId, /^[0-9a-f]{24}$/);
    assert.equal(e.body.hostId, hostId);
    const again = await fetch(`${env.base}/api/agent/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: e.token, publicKey: newAgentKey().publicB64 }),
    });
    assert.equal(again.status, 403);
  });

  test('jeton expiré ou inconnu refusé ; clé invalide refusée', async () => {
    const t = await (await post('/api/agents/enrollments', { hostId })).json();
    env.corvus.ctx.db.run('UPDATE agent_enrollments SET expires_at = 1');
    const exp = await fetch(`${env.base}/api/agent/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t.token, publicKey: newAgentKey().publicB64 }) });
    assert.equal(exp.status, 403);
    const bad = await fetch(`${env.base}/api/agent/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(43), publicKey: 'AAAA' }) });
    assert.equal(bad.status, 400);
  });

  test('seuls les administrateurs créent des jetons ; le jeton n\'est pas stocké en clair', async () => {
    const noAuth = await post('/api/agents/enrollments', { hostId }, { 'content-type': 'application/json' });
    assert.equal(noAuth.status, 401);
    const t = await (await post('/api/agents/enrollments', { hostId })).json();
    const rows = JSON.stringify(env.corvus.ctx.db.all('SELECT * FROM agent_enrollments'));
    assert.ok(!rows.includes(t.token));
    const unknownHost = await post('/api/agents/enrollments', { hostId: 'zzzzzzzzzz' });
    assert.equal(unknownHost.status, 404);
  });
});

describe('canal WebSocket', () => {
  test('authentification mutuelle, événements idempotents, métriques', async () => {
    const e = await enrollAgent();
    const a = connect(e.body.agentId, e.key);
    await a.handshake();
    const ok = await a.next('auth_ok');
    assert.equal(typeof ok.body.signature, 'string');
    assert.equal(ok.body.lastSeq, 0);

    a.send('events', { items: [{ seq: 1, ts: 1000, type: 'boot', body: { a: 1 } }, { seq: 2, ts: 2000, type: 'x', body: {} }] });
    assert.equal((await a.next('ack')).body.upTo, 2);
    a.inbox.length = 0;
    a.send('events', { items: [{ seq: 2, ts: 2000, type: 'x', body: {} }, { seq: 3, ts: 3000, type: 'y', body: {} }] });
    assert.equal((await a.next('ack')).body.upTo, 3);
    assert.equal(env.corvus.ctx.db.get('SELECT COUNT(*) AS n FROM agent_events WHERE agent_id = ?', e.body.agentId).n, 3, 'le renvoi du seq 2 ne crée pas de doublon');

    a.send('metrics', { ts: 5000, values: { cpu: 12.5, 'df:/': 40, 'mauvais nom!': 1, mem: 'NaN' } });
    await waitFor(() => env.corvus.ctx.db.get('SELECT 1 AS x FROM metrics_raw WHERE host_id = ? AND metric = ?', hostId, 'cpu'));
    const names = env.corvus.ctx.db.all('SELECT metric FROM metrics_raw WHERE host_id = ?', hostId).map((r) => r.metric).sort();
    assert.deepEqual(names, ['cpu', 'df:/']);

    // Reconnexion : le serveur annonce le dernier numéro reçu.
    a.ws.close();
    const b = connect(e.body.agentId, e.key);
    await b.handshake();
    assert.equal((await b.next('auth_ok')).body.lastSeq, 3);
    b.ws.close();
  });

  test('signature du serveur vérifiable avec la clé annoncée à l\'enrôlement', async () => {
    const e = await enrollAgent();
    const ws = new WebSocket(`${env.base.replace('http', 'ws')}/agent`);
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    const hello = await waitFor(() => inbox.find((m) => m.type === 'hello'), 5000);
    const myChallenge = crypto.randomBytes(32).toString('base64');
    const sig = crypto.sign(null, signedText('agent', hello.body.challenge), e.key.privateKey);
    ws.send(JSON.stringify({ v: 1, id: 'a', type: 'auth', ts: 0, body: { agentId: e.body.agentId, signature: sig.toString('base64'), challenge: myChallenge } }));
    const ok = await waitFor(() => inbox.find((m) => m.type === 'auth_ok'), 5000);
    assert.ok(crypto.verify(null, signedText('server', myChallenge), publicKeyFromRaw(e.body.serverPublicKey), Buffer.from(ok.body.signature, 'base64')));
    // Une signature « agent » ne vaut pas signature « serveur » (le rôle est dans le texte signé).
    assert.ok(!crypto.verify(null, signedText('agent', myChallenge), publicKeyFromRaw(e.body.serverPublicKey), Buffer.from(ok.body.signature, 'base64')));
    ws.close();
  });

  test('mauvaise signature, agent inconnu et agent révoqué sont refusés', async () => {
    const e = await enrollAgent();
    const forged = connect(e.body.agentId, e.key, { forgeSignature: true });
    await forged.handshake();
    await waitFor(() => forged.closed !== null, 5000);
    assert.equal(forged.closed, 4001);
    assert.ok(!forged.inbox.some((m) => m.type === 'auth_ok'));

    const unknown = connect('0'.repeat(24), e.key);
    await unknown.handshake();
    await waitFor(() => unknown.closed !== null, 5000);
    assert.equal(unknown.closed, 4001);

    const good = connect(e.body.agentId, e.key);
    await good.handshake();
    await good.next('auth_ok');
    const del = await fetch(`${env.base}/api/agents/${e.body.agentId}`, { method: 'DELETE', headers: auth() });
    assert.equal(del.status, 200);
    await waitFor(() => good.closed !== null, 5000);
    const after = connect(e.body.agentId, e.key);
    await after.handshake();
    await waitFor(() => after.closed !== null, 5000);
    assert.ok(!after.inbox.some((m) => m.type === 'auth_ok'));
  });

  test('message avant authentification, JSON invalide et origine de navigateur refusés', async () => {
    const a = connect('x', newAgentKey());
    await a.next('hello');
    a.send('events', { items: [{ seq: 1, type: 'x', body: {} }] });
    await waitFor(() => a.closed !== null, 5000);
    assert.equal(env.corvus.ctx.db.get('SELECT COUNT(*) AS n FROM agent_events').n >= 0, true);

    const b = new WebSocket(`${env.base.replace('http', 'ws')}/agent`);
    b.on('message', () => b.send('pas du json'));
    const code = await new Promise((r) => b.on('close', r));
    assert.equal(code, 4001);

    const browser = new WebSocket(`${env.base.replace('http', 'ws')}/agent`, { headers: { origin: 'https://evil.example' } });
    const status = await new Promise((resolve) => { browser.on('unexpected-response', (_q, res) => resolve(res.statusCode)); browser.on('error', () => {}); });
    assert.equal(status, 403);
  });

  test('le journal enregistre enrôlement, connexion et révocation (chaîne intacte)', async () => {
    const rows = env.corvus.ctx.db.all("SELECT event FROM audit WHERE type = 'agent'").map((r) => r.event);
    for (const ev of ['enroll-token', 'enrolled', 'connected', 'revoked', 'auth-failed']) assert.ok(rows.includes(ev), ev);
    assert.equal(env.corvus.ctx.journal.verify().ok, true);
  });
});

// --- Interopérabilité : le VRAI binaire Rust contre le VRAI serveur ------------------------------
// Compiler d'abord : (cd agent && cargo build). Sans binaire, ces tests sont ignorés (ex. CI Node seule).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Asynchrone obligatoire : le serveur de test tourne dans CE processus, un appel bloquant l'empêcherait de répondre.
const run = promisify(execFile);

const AGENT_BIN = process.env.CORVUS_AGENT_BIN
  || ['debug', 'release'].map((p) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'target', p, process.platform === 'win32' ? 'corvus-agent.exe' : 'corvus-agent')).find((p) => fs.existsSync(p));

describe('agent Rust (binaire réel)', { skip: AGENT_BIN ? false : 'binaire non compilé (cd agent && cargo build)' }, () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-agent-'));

  test('enrôlement, connexion authentifiée, événement de démarrage et métriques', async () => {
    const d = dir();
    const t = await (await post('/api/agents/enrollments', { hostId })).json();
    const { stdout: out } = await run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', d]);
    assert.match(out, /Enrôlé : agent [0-9a-f]{24}/);
    const identity = JSON.parse(fs.readFileSync(path.join(d, 'identity.json'), 'utf8'));
    if (process.platform === 'win32') {
      // Pas de mode 0600 sous Windows : l'ACL réelle ne doit donner l'accès qu'à SYSTEM, aux Administrateurs et au propriétaire.
      const { stdout: acl } = await run(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), [path.join(d, 'identity.json')]);
      assert.equal(acl.toLowerCase().split(':(f)').length - 1, 3, acl);
      assert.doesNotMatch(acl, /everyone|authenticated users|builtin\users|tout le monde|utilisateurs/i);
    } else {
      assert.equal(fs.statSync(path.join(d, 'identity.json')).mode & 0o777, 0o600);
    }
    assert.equal(identity.serverPublicKey ?? identity.server_public_key, env.corvus.ctx.agents.publicKeyB64);

    // Le jeton est consommé : un second enrôlement échoue.
    await assert.rejects(run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', dir()]));

    const child = spawn(AGENT_BIN, ['run', '--dir', d, '--interval', '1'], { stdio: 'pipe' });
    try {
      const { db } = env.corvus.ctx;
      await waitFor(() => db.get("SELECT 1 AS x FROM agent_events WHERE agent_id = ? AND type = 'agent.start'", identity.agent_id), 40000);
      await waitFor(() => db.get('SELECT 1 AS x FROM metrics_raw WHERE host_id = ? AND metric = ?', hostId, 'mem'), 40000);
      if (process.platform !== 'linux') {
        // Sous Windows et macOS les métriques viennent de `sysinfo` : disque nommé « df:<disque> », réseau, uptime.
        await waitFor(() => db.get("SELECT 1 AS x FROM metrics_raw WHERE host_id = ? AND metric LIKE 'df:%'", hostId), 40000);
        await waitFor(() => db.get("SELECT 1 AS x FROM metrics_raw WHERE host_id = ? AND metric = 'cpu'", hostId), 40000);
        await waitFor(() => db.get("SELECT 1 AS x FROM metrics_raw WHERE host_id = ? AND metric = 'uptime'", hostId), 40000);
      }
      const list = (await (await fetch(`${env.base}/api/agents`, { headers: auth() })).json()).agents;
      const me = list.find((a) => a.id === identity.agent_id);
      assert.equal(me.online, true);
      assert.equal(me.version, '1.3.1');
      assert.equal(me.capabilities.ebpf, false);
      assert.equal(me.platform, { win32: 'windows', darwin: 'macos' }[process.platform] ?? 'linux');
    } finally {
      child.kill();
    }
  });

  test('Radiographie en direct : le vrai agent liste ses processus (dont lui-même) sur Windows, macOS et Linux', async () => {
    const d = dir();
    const t = await (await post('/api/agents/enrollments', { hostId })).json();
    await run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', d]);
    const identity = JSON.parse(fs.readFileSync(path.join(d, 'identity.json'), 'utf8'));
    const child = spawn(AGENT_BIN, ['run', '--dir', d, '--interval', '1'], { stdio: 'pipe' });
    try {
      const { db } = env.corvus.ctx;
      await waitFor(() => db.get("SELECT 1 AS x FROM agent_events WHERE agent_id = ? AND type = 'agent.start'", identity.agent_id), 40000);
      const r = await fetch(`${env.base}/api/hosts/${hostId}/xray/live`, { headers: auth() });
      assert.equal(r.status, 200);
      const live = await r.json();
      const list = live.processes ?? live.procs ?? [];
      assert.ok(list.length > 5, `processus attendus : ${JSON.stringify(live).slice(0, 200)}`);
      assert.ok(list.some((p) => p.pid === child.pid), "l'agent se voit lui-même");
    } finally {
      child.kill();
    }
  });

  // Linux : pas de signal du système de fichiers (FSNOTIFY = false, balayage périodique seul) ; ce signal n'existe que sous Windows et macOS.
  test('un fichier créé dans un dossier surveillé est détecté bien avant le balayage périodique (évènements du système)', { skip: process.platform === 'linux' && 'Linux : balayage périodique seulement' }, async () => {
    const d = dir();
    const watched = dir();
    fs.writeFileSync(path.join(watched, 'existant.txt'), 'x');
    const t = await (await post('/api/agents/enrollments', { hostId })).json();
    await run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', d]);
    const identity = JSON.parse(fs.readFileSync(path.join(d, 'identity.json'), 'utf8'));
    // Balayage périodique à 60 s : seul le signal du système de fichiers peut produire l'évènement dans le délai du test.
    const child = spawn(AGENT_BIN, ['run', '--dir', d, '--interval', '1', '--watch', watched, '--scan-interval', '60'], { stdio: 'pipe' });
    try {
      const { db } = env.corvus.ctx;
      await waitFor(() => db.get("SELECT 1 AS x FROM agent_events WHERE agent_id = ? AND type = 'agent.start'", identity.agent_id), 40000);
      await new Promise((r) => setTimeout(r, 1500));
      fs.writeFileSync(path.join(watched, 'nouveau.txt'), 'bonjour');
      await waitFor(() => db.get("SELECT 1 AS x FROM agent_events WHERE agent_id = ? AND type = 'file.created'", identity.agent_id), 20000);
    } finally {
      child.kill();
    }
  });

  test('hôte « agent seul » : le vrai agent s’enrôle, passe en ligne et envoie ses métriques sans aucun SSH configuré', async () => {
    const solo = (await post('/api/hosts', { name: 'PC agent seul', authType: 'none' }).then((r) => r.json())).host;
    assert.equal(solo.authType, 'none');
    const d = dir();
    const t = await (await post('/api/agents/enrollments', { hostId: solo.id })).json();
    await run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', d]);
    const identity = JSON.parse(fs.readFileSync(path.join(d, 'identity.json'), 'utf8'));
    const child = spawn(AGENT_BIN, ['run', '--dir', d, '--interval', '1'], { stdio: 'pipe' });
    try {
      const { db } = env.corvus.ctx;
      await waitFor(() => db.get('SELECT 1 AS x FROM metrics_raw WHERE host_id = ? AND metric = ?', solo.id, 'mem'), 40000);
      const hosts = (await (await fetch(`${env.base}/api/hosts`, { headers: auth() })).json()).hosts;
      const moi = hosts.find((x) => x.id === solo.id);
      assert.equal(moi.agent.online, true);
      assert.equal(moi.agent.id ?? identity.agent_id, identity.agent_id);
      // Pas de SSH : refusé proprement, l'agent, lui, répond (Radiographie en direct).
      assert.equal((await fetch(`${env.base}/api/hosts/${solo.id}/monitor/stats`, { headers: auth() })).status, 409);
      const live = await fetch(`${env.base}/api/hosts/${solo.id}/xray/live`, { headers: auth() });
      assert.equal(live.status, 200);
    } finally {
      child.kill();
    }
  });

  test('un agent qui parle à un FAUX serveur (autre clé) se déconnecte', async () => {
    const d = dir();
    const t = await (await post('/api/agents/enrollments', { hostId })).json();
    await run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', d]);
    const f = path.join(d, 'identity.json');
    const id = JSON.parse(fs.readFileSync(f, 'utf8'));
    // L'agent croit connaître une AUTRE clé de serveur : la signature de Corvus doit être rejetée.
    id.server_public_key = newAgentKey().publicB64;
    fs.writeFileSync(f, JSON.stringify(id));
    const child = spawn(AGENT_BIN, ['run', '--dir', d, '--interval', '1'], { stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    try {
      await waitFor(() => /INVALIDE/.test(stderr), 10000);
      assert.match(stderr, /connexion perdue/);
    } finally {
      child.kill();
    }
  });
});

describe('état visible et alerte hors ligne', () => {
  test('la liste des hôtes indique l\'agent ; un agent muet déclenche une alerte unique', async () => {
    const e = await enrollAgent();
    const a = connect(e.body.agentId, e.key);
    await a.handshake();
    await a.next('auth_ok');
    let hosts = (await (await fetch(`${env.base}/api/hosts`, { headers: auth() })).json()).hosts;
    assert.equal(hosts.find((x) => x.id === hostId).agent.online, true);

    a.ws.close();
    await waitFor(() => !env.corvus.ctx.agents.connections.has(e.body.agentId), 5000);
    hosts = (await (await fetch(`${env.base}/api/hosts`, { headers: auth() })).json()).hosts;
    assert.equal(hosts.find((x) => x.id === hostId).agent.online, false);

    const { db, agents } = env.corvus.ctx;
    db.run('UPDATE agents SET last_seen_at = ? WHERE id = ?', Date.now() - 10 * 60_000, e.body.agentId);
    agents.checkOffline();
    agents.checkOffline(); // dédoublonnée
    const alerts = db.all("SELECT message FROM alerts WHERE kind = 'agent.offline' AND message LIKE '%Hôte agent%'");
    assert.ok(alerts.length >= 1);
    assert.match(alerts[0].message, /hors ligne depuis (9|10) min/);
  });
});
