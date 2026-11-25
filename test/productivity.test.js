// Étapes 4 et 5.1 de bout en bout (sshd de test) : snippets, exécution multi-hôtes,
// historique et suggestions, mode « annulable », administration (lecture, garde-fous).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus } from './helpers/corvus.js';

let sshd;
let env;
let c;
let hostId;
let host2;

before(async () => {
  sshd = await startFakeSshd();
  env = await startCorvus();
  c = env.client;
  await c.login();
  const body = (name) => ({ name, hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
  hostId = (await c.api('POST', '/api/hosts', body('Banc A'))).body.host.id;
  host2 = (await c.api('POST', '/api/hosts', body('Banc B'))).body.host.id;
});
after(async () => { await env?.close(); await sshd?.close(); });

describe('snippets et exécution multi-hôtes', () => {
  test('snippets : création, filtre par hôte, suppression', async () => {
    const g = await c.api('POST', '/api/snippets', { name: 'Espace disque', command: 'df -h' });
    assert.equal(g.status, 201);
    const s = await c.api('POST', '/api/snippets', { name: 'Logs A', command: 'tail -n 50 app.log', hostId });
    assert.equal(s.status, 201);
    assert.equal((await c.api('GET', `/api/snippets?hostId=${hostId}`)).body.snippets.length, 2);
    assert.equal((await c.api('GET', `/api/snippets?hostId=${host2}`)).body.snippets.length, 1);
    assert.equal((await c.api('DELETE', `/api/snippets/${s.body.snippet.id}`)).status, 200);
  });

  test('même commande sur deux hôtes, résultats côte à côte', async () => {
    const r = await c.api('POST', '/api/exec', { hostIds: [hostId, host2], command: 'echo multi-$((40+2))' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.results.map((x) => x.host), ['Banc A', 'Banc B']);
    assert.ok(r.body.results.every((x) => x.ok && x.stdout.includes('multi-42')));
  });

  test('commande risquée : confirmation exigée avant toute exécution', async () => {
    const marker = path.join(sshd.root, 'ne-pas-supprimer.txt');
    fs.writeFileSync(marker, 'x');
    const r = await c.api('POST', '/api/exec', { hostIds: [hostId], command: 'rm -f ne-pas-supprimer.txt' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CONFIRM_REQUIRED');
    assert.equal(r.body.error.details.analysis.level, 'danger');
    assert.ok(fs.existsSync(marker), 'rien n\'a été exécuté');
  });
});

describe('historique et suggestions', () => {
  test('n-grammes, complétion par préfixe et chemins, séquences répétées', async () => {
    for (let i = 0; i < 3; i++) {
      for (const cmd of ['git status', 'git add -A', 'git commit -m wip']) await c.api('POST', `/api/hosts/${hostId}/history`, { command: cmd });
    }
    const next = await c.api('GET', `/api/hosts/${hostId}/complete?prefix=&prev1=${encodeURIComponent('git status')}`);
    assert.equal(next.body.next[0].command, 'git add -A');
    const pre = await c.api('GET', `/api/hosts/${hostId}/complete?prefix=${encodeURIComponent('git c')}`);
    assert.equal(pre.body.history[0].command, 'git commit -m wip');
    fs.mkdirSync(path.join(sshd.root, 'projets-corvus'), { recursive: true });
    const paths = await c.api('GET', `/api/hosts/${hostId}/complete?prefix=${encodeURIComponent('cd ~/projets-c')}`);
    assert.ok(paths.body.paths.includes('~/projets-corvus/'), JSON.stringify(paths.body));
    const seq = await c.api('GET', `/api/hosts/${hostId}/sequences`);
    assert.deepEqual(seq.body.sequences[0].commands, ['git status', 'git add -A', 'git commit -m wip']);
  });
});

describe('mode « annulable »', () => {
  test('sauvegarde avant rm / sed -i, puis restauration exacte', async () => {
    fs.mkdirSync(path.join(sshd.root, 'undo'), { recursive: true });
    fs.writeFileSync(path.join(sshd.root, 'undo', 'a.conf'), 'port=80\n');
    fs.mkdirSync(path.join(sshd.root, 'undo', 'dossier'), { recursive: true });
    fs.writeFileSync(path.join(sshd.root, 'undo', 'dossier', 'b.txt'), 'contenu b');
    const prep = await c.api('POST', `/api/hosts/${hostId}/undo/prepare`, { command: 'rm -rf dossier && sed -i s/80/8080/ a.conf && echo x > nouveau.txt', cwd: '~/undo' });
    assert.equal(prep.status, 200, JSON.stringify(prep.body));
    assert.ok(prep.body.op, JSON.stringify(prep.body.analysis));
    assert.ok(prep.body.op.files >= 4);
    // La commande est exécutée (comme si elle venait du terminal).
    await env.corvus.ctx.pool.exec(hostId, 'cd ~/undo && rm -rf dossier && sed -i s/80/8080/ a.conf && echo x > nouveau.txt');
    assert.ok(!fs.existsSync(path.join(sshd.root, 'undo', 'dossier')));
    assert.equal((await c.api('POST', `/api/hosts/${hostId}/undo/${prep.body.op.id}`, {})).status, 400, 'confirmation exigée');
    const r = await c.api('POST', `/api/hosts/${hostId}/undo/${prep.body.op.id}`, { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.errors, []);
    assert.equal(fs.readFileSync(path.join(sshd.root, 'undo', 'a.conf'), 'utf8'), 'port=80\n');
    assert.equal(fs.readFileSync(path.join(sshd.root, 'undo', 'dossier', 'b.txt'), 'utf8'), 'contenu b');
    assert.ok(!fs.existsSync(path.join(sshd.root, 'undo', 'nouveau.txt')), 'fichier créé par la commande retiré');
    assert.equal((await c.api('POST', `/api/hosts/${hostId}/undo/${prep.body.op.id}`, { confirm: true })).status, 409);
  });

  test('commande non annulable : analyse seule, aucune promesse', async () => {
    const r = await c.api('POST', `/api/hosts/${hostId}/undo/prepare`, { command: 'rm $(cat liste.txt)' });
    assert.equal(r.body.op, null);
    assert.equal(r.body.analysis.undoable, false);
  });
});

describe('administration (façon Cockpit)', () => {
  test('règle sudoers générée, limitée, sans pager ni shell', async () => {
    const r = await c.api('GET', `/api/hosts/${hostId}/sudoers`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (!r.body.text) {
      // Hôte de test sans systemd/ufw (ex. Windows) : aucune règle, message explicite.
      assert.match(r.body.notes[0], /Aucun outil/);
      return;
    }
    assert.match(r.body.text, /NOPASSWD:/);
    const rules = r.body.text.split('\n').filter((l) => !l.startsWith('#')).join('\n');
    assert.doesNotMatch(rules, /journalctl|less|\bvi\b|bash|NOPASSWD: ALL/);
  });

  test('garde-fous : confirmation exigée, nom de service validé', async () => {
    assert.equal((await c.api('POST', `/api/hosts/${hostId}/admin/services/nginx/restart`, {})).status, 400);
    assert.equal((await c.api('POST', `/api/hosts/${hostId}/admin/services/${encodeURIComponent('a;reboot')}/restart`, { confirm: true })).status, 400);
    const lock = await c.api('POST', `/api/hosts/${hostId}/admin/users/${sshd.user}/lock`, { confirm: true });
    assert.equal(lock.body.error.code, 'LOCKOUT');
  });
});
