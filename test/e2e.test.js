// Tests de bout en bout : Corvus réel + sshd de test (ou un vrai sshd via CORVUS_TEST_SSH_*).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

describe('fichiers (SFTP)', () => {
  const base = () => `/api/hosts/${hostId}/fs`;
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a3f1d1b80000000049454e44ae426082', 'hex');
  let dir;

  test('liste du dossier personnel', async () => {
    const r = await c.api('GET', `${base()}/list`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.path, sshd.rootVirtual);
    assert.equal(r.body.home, sshd.rootVirtual);
    dir = `${r.body.path}/essai sftp`;
  });

  test('créer un dossier, envoyer des fichiers', async () => {
    const mk = await c.api('POST', `${base()}/mkdir`, { path: dir });
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    const up = await c.raw('POST', `${base()}/upload?dir=${encodeURIComponent(dir)}&name=note.txt`, {
      body: Buffer.from('bonjour\nCorvus é\n'), headers: { 'content-type': 'application/octet-stream' },
    });
    assert.equal(up.status, 201, await up.text());
    const img = await c.raw('POST', `${base()}/upload?dir=${encodeURIComponent(dir)}&name=pixel.png`, {
      body: PNG, headers: { 'content-type': 'application/octet-stream' },
    });
    assert.equal(img.status, 201);
    const again = await c.raw('POST', `${base()}/upload?dir=${encodeURIComponent(dir)}&name=note.txt`, {
      body: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream' },
    });
    assert.equal(again.status, 409, 'pas d\'écrasement silencieux');
    const list = await c.api('GET', `${base()}/list?path=${encodeURIComponent(dir)}`);
    assert.deepEqual(list.body.entries.map((e) => e.name), ['note.txt', 'pixel.png']);
  });

  test('lire, éditer, détecter un conflit', async () => {
    const rd = await c.api('GET', `${base()}/read?path=${encodeURIComponent(`${dir}/note.txt`)}`);
    assert.equal(rd.status, 200);
    assert.equal(rd.body.content, 'bonjour\nCorvus é\n');
    const conflict = await c.api('PUT', `${base()}/write`, { path: `${dir}/note.txt`, content: 'x', expectedMtime: rd.body.mtime - 100 });
    assert.equal(conflict.status, 409);
    const wr = await c.api('PUT', `${base()}/write`, { path: `${dir}/note.txt`, content: 'modifié\n', expectedMtime: rd.body.mtime });
    assert.equal(wr.status, 200, JSON.stringify(wr.body));
    const rd2 = await c.api('GET', `${base()}/read?path=${encodeURIComponent(`${dir}/note.txt`)}`);
    assert.equal(rd2.body.content, 'modifié\n');
    const bin = await c.api('GET', `${base()}/read?path=${encodeURIComponent(`${dir}/pixel.png`)}`);
    assert.equal(bin.status, 415);
  });

  test('téléchargement et aperçu isolés (CSP sandbox)', async () => {
    const dl = await c.raw('GET', `${base()}/download?path=${encodeURIComponent(`${dir}/pixel.png`)}`);
    assert.equal(dl.status, 200);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(PNG));
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    assert.match(dl.headers.get('content-security-policy'), /sandbox/);
    const pv = await c.raw('GET', `${base()}/preview?path=${encodeURIComponent(`${dir}/pixel.png`)}`);
    assert.equal(pv.headers.get('content-type'), 'image/png');
    assert.match(pv.headers.get('content-security-policy'), /sandbox/);
    const txt = await c.raw('GET', `${base()}/preview?path=${encodeURIComponent(`${dir}/note.txt`)}`);
    assert.equal(txt.status, 415);
  });

  test('renommer puis supprimer récursivement', async () => {
    const rn = await c.api('POST', `${base()}/rename`, { from: `${dir}/note.txt`, to: `${dir}/renommé.txt` });
    assert.equal(rn.status, 200, JSON.stringify(rn.body));
    const del = await c.api('POST', `${base()}/delete`, { path: dir });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.deleted, 3);
    const gone = await c.api('GET', `${base()}/list?path=${encodeURIComponent(dir)}`);
    assert.equal(gone.status, 404);
  });

  test('garde-fous : dossier personnel, chemins invalides', async () => {
    const home = await c.api('POST', `${base()}/delete`, { path: '~' });
    assert.equal(home.status, 400);
    const bad = await c.api('POST', `${base()}/mkdir`, { path: 'a\nb' });
    assert.equal(bad.status, 400);
    const badName = await c.raw('POST', `${base()}/upload?dir=~&name=..%2Fevil`, { body: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(badName.status, 400);
  });

  test('journal SFTP', async () => {
    const r = await c.api('GET', '/api/journal?type=sftp');
    const events = r.body.entries.map((e) => e.event);
    for (const e of ['upload', 'edit', 'download', 'rename', 'delete', 'mkdir']) assert.ok(events.includes(e), `événement ${e} absent`);
  });
});

describe('git distant', () => {
  const G = () => `/api/hosts/${hostId}/git`;
  let repo;
  let work;
  let originDir;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  const ident = ['-c', 'user.name=Test', '-c', 'user.email=test@corvus.local'];

  before(() => {
    work = path.join(sshd.root, 'work');
    originDir = path.join(sshd.root, 'origin.git');
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.name', 'Corvus Test');
    git(work, 'config', 'user.email', 'test@corvus.local');
    git(work, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(work, 'README.md'), '# Démo\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'Premier commit');
    git(sshd.root, 'clone', '-q', '--bare', work, originDir);
    git(work, 'remote', 'add', 'origin', originDir.replace(/\\/g, '/'));
    git(work, 'fetch', '-q', 'origin');
    git(work, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    repo = `${sshd.rootVirtual}/work`;
  });

  test('statut d\'un dépôt propre', async () => {
    const r = await c.api('GET', `${G()}/status?repo=${encodeURIComponent(repo)}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.branch, 'main');
    assert.equal(r.body.upstream, 'origin/main');
    assert.deepEqual(r.body.files, []);
    assert.deepEqual(r.body.remotes, ['origin']);
  });

  test('modifications, fichiers non suivis (nom avec quote), diff', async () => {
    fs.appendFileSync(path.join(work, 'README.md'), 'ligne ajoutée\n');
    fs.writeFileSync(path.join(work, "fichier d'essai.txt"), 'nouveau\n');
    const st = await c.api('GET', `${G()}/status?repo=${encodeURIComponent(repo)}`);
    const byPath = Object.fromEntries(st.body.files.map((f) => [f.path, f]));
    assert.equal(byPath['README.md'].unstaged, true);
    assert.equal(byPath["fichier d'essai.txt"].untracked, true);
    const d = await c.api('GET', `${G()}/diff?repo=${encodeURIComponent(repo)}&path=README.md`);
    assert.match(d.body.text, /\+ligne ajoutée/);
    const du = await c.api('GET', `${G()}/diff?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent("fichier d'essai.txt")}&untracked=1`);
    assert.match(du.body.text, /\+nouveau/);
  });

  test('stage / unstage', async () => {
    const s = await c.api('POST', `${G()}/stage`, { repo, paths: ['README.md', "fichier d'essai.txt"] });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.ok(s.body.files.every((f) => f.staged));
    const u = await c.api('POST', `${G()}/unstage`, { repo, paths: ["fichier d'essai.txt"] });
    assert.equal(u.body.files.find((f) => f.path === "fichier d'essai.txt").untracked, true);
    const all = await c.api('POST', `${G()}/stage`, { repo, all: true });
    assert.ok(all.body.files.every((f) => f.staged));
  });

  test('commit : le message n\'est jamais interprété par le shell', async () => {
    const message = "Ajout d'un $(touch PWNED) `id` ; echo \"x\"";
    const r = await c.api('POST', `${G()}/commit`, { repo, message });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.subject, message);
    assert.equal(r.body.status.ahead, 1);
    assert.ok(!fs.existsSync(path.join(work, 'PWNED')));
  });

  test('push puis historique et détail d\'un commit', async () => {
    const p = await c.api('POST', `${G()}/push`, { repo });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.status.ahead, 0);
    const log = await c.api('GET', `${G()}/log?repo=${encodeURIComponent(repo)}`);
    assert.equal(log.body.commits.length, 2);
    assert.match(log.body.commits[0].subject, /^Ajout d'un/);
    const show = await c.api('GET', `${G()}/show?repo=${encodeURIComponent(repo)}&sha=${log.body.commits[1].sha}`);
    assert.match(show.body.text, /Premier commit/);
  });

  test('branches : création, checkout, retour', async () => {
    const cr = await c.api('POST', `${G()}/checkout`, { repo, branch: 'feature/essai', create: true });
    assert.equal(cr.status, 200, JSON.stringify(cr.body));
    assert.equal(cr.body.branch, 'feature/essai');
    const br = await c.api('GET', `${G()}/branches?repo=${encodeURIComponent(repo)}`);
    assert.deepEqual(br.body.local.map((b) => b.name).sort(), ['feature/essai', 'main']);
    assert.ok(br.body.remote.some((b) => b.name === 'origin/main'));
    const back = await c.api('POST', `${G()}/checkout`, { repo, branch: 'main' });
    assert.equal(back.body.branch, 'main');
  });

  test('pull --ff-only depuis l\'origine', async () => {
    const other = path.join(sshd.root, 'other');
    git(sshd.root, 'clone', '-q', originDir, other);
    fs.writeFileSync(path.join(other, 'distant.txt'), 'depuis ailleurs\n');
    git(other, 'add', '-A');
    git(other, ...ident, 'commit', '-q', '-m', 'Commit distant');
    git(other, 'push', '-q', 'origin', 'main');
    await c.api('POST', `${G()}/fetch`, { repo });
    const before = await c.api('GET', `${G()}/status?repo=${encodeURIComponent(repo)}`);
    assert.equal(before.body.behind, 1);
    const r = await c.api('POST', `${G()}/pull`, { repo });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status.behind, 0);
    assert.ok(fs.existsSync(path.join(work, 'distant.txt')));
  });

  test('validation : injection dans les refs, SHA, dépôt inexistant', async () => {
    const inj = await c.api('POST', `${G()}/checkout`, { repo, branch: 'main; touch PWNED2' });
    assert.equal(inj.status, 400);
    const opt = await c.api('POST', `${G()}/checkout`, { repo, branch: '--orphan=x' });
    assert.equal(opt.status, 400);
    const sha = await c.api('GET', `${G()}/show?repo=${encodeURIComponent(repo)}&sha=HEAD;id`);
    assert.equal(sha.status, 400);
    const missing = await c.api('GET', `${G()}/status?repo=${encodeURIComponent(`${repo}-absent`)}`);
    assert.equal(missing.status, 404);
    const notRepo = await c.api('GET', `${G()}/status?repo=${encodeURIComponent(sshd.rootVirtual)}`);
    assert.equal(notRepo.status, 400);
    assert.equal(notRepo.body.error.code, 'NOT_A_REPO');
    assert.ok(!fs.existsSync(path.join(work, 'PWNED2')));
  });

  test('découverte des dépôts sous ~', async () => {
    const r = await c.api('GET', `${G()}/discover`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.repos.includes('~/work'), JSON.stringify(r.body));
  });
});

describe('supervision et docker', () => {
  const M = () => `/api/hosts/${hostId}`;

  test('statistiques : CPU calculé, mémoire, disques, uptime', async () => {
    const r = await c.api('GET', `${M()}/monitor/stats`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.mem && r.body.mem.total > 0, 'mémoire');
    assert.ok(r.body.mem.percent >= 0 && r.body.mem.percent <= 100);
    assert.ok(r.body.uptime > 0, 'uptime');
    assert.ok(Array.isArray(r.body.disks) && r.body.disks.length > 0, 'disques');
    assert.ok(r.body.cpu === null || (r.body.cpu >= 0 && r.body.cpu <= 100));
    const r2 = await c.api('GET', `${M()}/monitor/stats`);
    assert.equal(typeof r2.body.cpu, 'number', 'CPU calculé au 2e relevé');
  });

  test('processus : liste puis kill', async () => {
    const spawn = await env.corvus.ctx.pool.exec(hostId, 'sleep 300 >/dev/null 2>&1 & echo $!');
    const pid = Number(spawn.stdout.toString().trim());
    assert.ok(pid > 1);
    const list = await c.api('GET', `${M()}/monitor/processes`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.processes.some((p) => p.pid === pid), 'sleep présent');
    const k = await c.api('POST', `${M()}/monitor/kill`, { pid, signal: 'TERM' });
    assert.equal(k.status, 200, JSON.stringify(k.body));
    const bad = await c.api('POST', `${M()}/monitor/kill`, { pid: '1; reboot', signal: 'TERM' });
    assert.equal(bad.status, 400);
    const badSig = await c.api('POST', `${M()}/monitor/kill`, { pid, signal: 'TERM; reboot' });
    assert.equal(badSig.status, 400);
  });

  test('docker : liste, actions, logs, validation', async () => {
    const list = await c.api('GET', `${M()}/docker/containers`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.containers.map((x) => [x.name, x.state]), [['web', 'running'], ['db', 'exited']]);
    const st = await c.api('POST', `${M()}/docker/db/start`);
    assert.equal(st.status, 200, JSON.stringify(st.body));
    const logs = await c.api('GET', `${M()}/docker/web/logs?tail=50`);
    assert.match(logs.body.logs, /journal de web/);
    const inj = await c.api('POST', `${M()}/docker/${encodeURIComponent('web;id')}/restart`);
    assert.equal(inj.status, 400);
    const act = await c.api('POST', `${M()}/docker/web/rm`);
    assert.equal(act.status, 400);
    const calls = fs.readFileSync(sshd.dockerLog, 'utf8');
    assert.match(calls, /^start db$/m);
    assert.match(calls, /^logs --tail 50 --timestamps web$/m);
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
