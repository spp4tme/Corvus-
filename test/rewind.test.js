// Rembobinage de bout en bout : le VRAI agent Rust surveille un dossier de test, le VRAI serveur
// reconstruit l'état à un instant T, calcule le diff et restaure (ou supprime) via l'agent.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startCorvus, waitFor } from './helpers/corvus.js';
import { lineDiff, Rewind } from '../server/lib/rewind.js';
import { Db } from '../server/db/index.js';

const run = promisify(execFile);
const AGENT_BIN = process.env.CORVUS_AGENT_BIN
  || ['debug', 'release'].map((p) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'target', p, 'corvus-agent')).find((p) => fs.existsSync(p));

describe('diff par lignes', () => {
  test('ajouts, suppressions, contexte', () => {
    const d = lineDiff('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nC\nd\ne\nf\ng\nh\ni');
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
    assert.deepEqual(d.hunks[0].lines.filter((l) => l.t !== ' ').map((l) => l.t + l.s), ['-c', '+C', '+i']);
    assert.equal(lineDiff('x', 'x').hunks.length, 0);
    assert.deepEqual(lineDiff('', 'nouveau').hunks[0].lines, [{ t: '+', s: 'nouveau' }]);
  });
});

describe('état des fichiers à un instant T', () => {
  test('un hôte très actif : les changements RÉCENTS restent visibles (plus de troncature aux anciens événements)', () => {
    const db = new Db(':memory:');
    const ins = (seq, ts, type, body) => db.run('INSERT INTO agent_events (agent_id, host_id, agent_seq, ts, type, body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'a', 'h1', seq, ts, type, JSON.stringify(body), ts);
    const sha = (c) => c.repeat(64);
    db.tx(() => {
      ins(1, 1, 'file.baseline', { path: '/etc/app.conf', sha: sha('a'), mode: 420, uid: 0, gid: 0 });
      // 200 001 événements de bruit (un journal qui bouge sans arrêt).
      for (let i = 0; i < 200_001; i++) ins(i + 2, 2 + i, 'file.modified', { path: '/var/log/bruit.log', sha: sha(i % 2 ? 'b' : 'c'), mode: 420, uid: 0, gid: 0 });
      ins(300_000, 300_000, 'file.modified', { path: '/etc/app.conf', sha: sha('d'), mode: 420, uid: 0, gid: 0 });
      ins(300_001, 300_001, 'file.created', { path: '/tmp/charge.sh', sha: sha('e'), mode: 493, uid: 0, gid: 0 });
    });
    const rw = new Rewind({ db });
    const now = rw.fileState('h1');
    assert.equal(now.get('/etc/app.conf').sha, sha('d'), 'la dernière modification est vue');
    assert.equal(now.get('/etc/app.conf').firstType, 'file.baseline');
    assert.ok(now.has('/tmp/charge.sh'));
    const ch = rw.changesSince('h1', 10, '/etc/').concat(rw.changesSince('h1', 10, '/tmp/'));
    assert.deepEqual(ch.map((c) => `${c.action} ${c.path}`), ['restore /etc/app.conf', 'remove /tmp/charge.sh']);
    assert.equal(rw.fileState('h1', 10, '/etc/').size, 1, 'préfixe respecté');
  });

  test('diff d\'un long fichier contre une ligne : mémoire bornée, résultat correct', () => {
    const long = Array.from({ length: 300_000 }, (_, i) => `l${i}`).join('\n');
    const d = lineDiff(long, 'x');
    assert.equal(d.removed, 300_000);
    assert.equal(d.added, 1);
  });
});

describe('rembobinage avec le vrai agent', { skip: AGENT_BIN ? false : 'binaire non compilé (cd agent && cargo build)' }, () => {
  let env; let hostId; let child; let watched; let agentDir; let agentId;
  const auth = () => ({ authorization: `Bearer ${env.token}`, 'content-type': 'application/json' });
  const api = async (method, url, body) => {
    const r = await fetch(env.base + url, { method, headers: auth(), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const scanned = async (pred) => waitFor(async () => pred((await api('GET', `/api/hosts/${hostId}/rewind/events?limit=500`)).body.events), 20000, 200);

  before(async () => {
    env = await startCorvus();
    const h = await api('POST', '/api/hosts', { name: 'Rewind', hostname: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' });
    hostId = h.body.host.id;
    watched = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-watched-'));
    watched = fs.realpathSync(watched);
    fs.writeFileSync(path.join(watched, 'app.conf'), 'port=80\nmode=prod\n');
    fs.writeFileSync(path.join(watched, 'ancien.txt'), 'je serai supprimé\n');
    fs.writeFileSync(path.join(watched, 'mon.key'), 'SECRET');
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-agent-'));
    const t = (await api('POST', '/api/agents/enrollments', { hostId })).body;
    await run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', agentDir]);
    agentId = JSON.parse(fs.readFileSync(path.join(agentDir, 'identity.json'), 'utf8')).agent_id;
    child = spawn(AGENT_BIN, ['run', '--dir', agentDir, '--watch', watched, '--interval', '1', '--scan-interval', '1'], { stdio: 'pipe' });
    await scanned((ev) => ev.filter((e) => e.type === 'file.baseline').length >= 3);
  });
  after(async () => { child?.kill(); await env?.close(); });

  test('état initial : contenus copiés sur le serveur, secrets suivis SANS contenu', async () => {
    const ev = (await api('GET', `/api/hosts/${hostId}/rewind/events?type=file.baseline&limit=50`)).body.events;
    const conf = ev.find((e) => e.body.path.endsWith('app.conf'));
    const key = ev.find((e) => e.body.path.endsWith('mon.key'));
    assert.equal(key.body.noContent, true);
    assert.equal(key.body.reason, 'secret');
    const text = await (await fetch(`${env.base}/api/hosts/${hostId}/rewind/version/${conf.body.sha}`, { headers: auth() })).text();
    assert.equal(text, 'port=80\nmode=prod\n');
    const missing = await fetch(`${env.base}/api/hosts/${hostId}/rewind/version/${key.body.sha}`, { headers: auth() });
    assert.equal(missing.status, 404, 'le contenu d\'un secret n\'a jamais été envoyé');
  });

  test('modification, création, suppression → diff, changements depuis T, restauration', async () => {
    await sleep(1200);
    const T = Date.now();
    await sleep(1200);
    fs.writeFileSync(path.join(watched, 'app.conf'), 'port=8080\nmode=prod\nnouveau=1\n');
    fs.writeFileSync(path.join(watched, 'cree.txt'), 'créé après T\n');
    fs.unlinkSync(path.join(watched, 'ancien.txt'));
    await scanned((ev) => ev.some((e) => e.type === 'file.modified') && ev.some((e) => e.type === 'file.created') && ev.some((e) => e.type === 'file.deleted'));

    const mod = (await api('GET', `/api/hosts/${hostId}/rewind/events?type=file.modified`)).body.events.find((e) => e.body.path.endsWith('app.conf'));
    const diff = (await api('GET', `/api/hosts/${hostId}/rewind/diff?a=${mod.body.prevSha}&b=${mod.body.sha}`)).body;
    assert.equal(diff.added, 2);
    assert.equal(diff.removed, 1);

    const ch = (await api('GET', `/api/hosts/${hostId}/rewind/changes?at=${T}`)).body.changes;
    const byName = Object.fromEntries(ch.map((c) => [path.basename(c.path), c]));
    assert.equal(byName['app.conf'].action, 'restore');
    assert.equal(byName['ancien.txt'].action, 'restore');
    assert.equal(byName['cree.txt'].action, 'remove');
    assert.ok(!byName['mon.key'], 'le secret n\'a pas changé');

    // Sans confirmation explicite : refusé. Puis restauration réelle.
    const refused = await api('POST', `/api/hosts/${hostId}/rewind/restore`, { at: T, paths: ch.map((c) => c.path) });
    assert.equal(refused.status, 400);
    const done = await api('POST', `/api/hosts/${hostId}/rewind/restore`, { at: T, paths: ch.map((c) => c.path), confirm: true });
    assert.equal(done.status, 200);
    assert.ok(done.body.results.every((r) => r.ok), JSON.stringify(done.body.results));
    assert.equal(fs.readFileSync(path.join(watched, 'app.conf'), 'utf8'), 'port=80\nmode=prod\n');
    assert.equal(fs.readFileSync(path.join(watched, 'ancien.txt'), 'utf8'), 'je serai supprimé\n');
    assert.ok(!fs.existsSync(path.join(watched, 'cree.txt')));
    assert.equal(fs.readFileSync(path.join(watched, 'mon.key'), 'utf8'), 'SECRET');

    // La restauration est elle-même dans l'historique (donc annulable), et dans le journal chaîné.
    await scanned((ev) => ev.filter((e) => e.type === 'file.modified').length >= 2 && ev.some((e) => e.type === 'file.deleted' && e.body.path.endsWith('cree.txt')) && ev.some((e) => e.type === 'file.created' && e.body.path.endsWith('ancien.txt')));
    const after = (await api('GET', `/api/hosts/${hostId}/rewind/changes?at=${T}`)).body.changes;
    assert.equal(after.length, 0, `plus aucune différence avec T : ${JSON.stringify(after)}`);
    const j = env.corvus.ctx.db.all("SELECT event FROM audit WHERE type = 'rewind'").map((r) => r.event);
    assert.ok(j.includes('restore-start') && j.includes('restore-restore') && j.includes('restore-remove'));
    assert.equal(env.corvus.ctx.journal.verify().ok, true);
  });

  test('l\'agent refuse un chemin hors des dossiers surveillés (même demandé par le serveur)', async () => {
    const buf = Buffer.from('x');
    await assert.rejects(env.corvus.ctx.agents.request(hostId, 'file.restore', {
      path: '/etc/passwd', sha256: crypto.createHash('sha256').update(buf).digest('hex'), data: buf.toString('base64'), mode: 0o644, uid: 0, gid: 0,
    }), /hors des dossiers surveillés/);
    await assert.rejects(env.corvus.ctx.agents.request(hostId, 'rm -rf /', {}), /Action inconnue/);
  });

  test('les droits sont nécessaires : sans authentification, refus', async () => {
    const r = await fetch(`${env.base}/api/hosts/${hostId}/rewind/changes?at=0`);
    assert.equal(r.status, 401);
  });

  test('restauration impossible si l\'agent est hors ligne', async () => {
    child.kill();
    await waitFor(() => !env.corvus.ctx.agents.connections.has(agentId), 5000);
    await assert.rejects(env.corvus.ctx.agents.request(hostId, 'file.remove', { path: path.join(watched, 'x') }), /Aucun agent connecté/);
  });
});
