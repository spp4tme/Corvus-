// Étape 4 — Copie d'hôte à hôte (SFTP → SFTP en flux via Corvus) : droits des deux côtés, refus d'écrasement,
// limites, annulation sans fichier partiel, liens symboliques, chemins hostiles. Deux faux sshd.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus, CorvusClient, makeUser, waitFor } from './helpers/corvus.js';

describe('copie d\'hôte à hôte', () => {
  let a; let b; let env; let admin; let cfg;
  const ids = {};
  const asUser = async (u) => { const c = new CorvusClient(env.base, { corvus: env.corvus, user: u }); assert.equal((await c.login()).status, 200); return c; };
  const put = (s, rel, content) => { fs.mkdirSync(path.dirname(path.join(s.root, rel)), { recursive: true }); fs.writeFileSync(path.join(s.root, rel), content); };
  const at = (s, rel) => path.join(s.root, rel);
  const copy = (cl, body, opts) => cl.api('POST', '/api/fs/copy', body, opts);
  const body = (srcRel, { dir = '~/dest', name, overwrite, confirm, from = ids.a, to = ids.b } = {}) => ({ from: { hostId: from, path: srcRel }, to: { hostId: to, dir, ...(name ? { name } : {}) }, ...(overwrite !== undefined ? { overwrite } : {}), ...(confirm !== undefined ? { confirm } : {}) });
  const finish = async (cl, id, timeout = 20000) => waitFor(async () => { const r = await cl.api('GET', `/api/fs/copy/${id}`); return r.body.copy.state !== 'running' ? r.body.copy : null; }, timeout);
  const listing = (s, rel = '') => fs.readdirSync(at(s, rel)).sort();

  before(async () => {
    [a, b] = await Promise.all([startFakeSshd(), startFakeSshd()]);
    env = await startCorvus();
    admin = env.client; await admin.login();
    cfg = env.corvus.ctx.config;
    for (const [n, s] of [['a', a], ['b', b]]) {
      const r = await admin.api('POST', '/api/hosts', { name: n, hostname: '127.0.0.1', port: s.port, username: s.user, authType: 'password', password: s.password });
      ids[n] = r.body.host.id;
    }
    fs.mkdirSync(at(b, 'dest'), { recursive: true });
  });
  after(async () => { await env?.close(); await Promise.all([a, b].map((s) => s?.close())); });

  test('copie d\'un fichier : contenu identique, progression, journal sans contenu', async () => {
    const data = crypto.randomBytes(300_000);
    put(a, 'src/photo.bin', data);
    const r = await copy(admin, body('~/src/photo.bin'));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const done = await finish(admin, r.body.copy.id);
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(done.bytes, 300_000);
    assert.equal(done.files, 1);
    assert.ok(fs.readFileSync(at(b, 'dest/photo.bin')).equals(data));
    // Les droits d'origine sont réappliqués par SFTP (chmod) : le faux sshd ignore SETSTAT, non vérifiable ici (testé sur OpenSSH réel).
    assert.deepEqual(listing(b, 'dest'), ['photo.bin'], 'aucun fichier temporaire');
    const j = await admin.api('GET', '/api/journal?type=sftp');
    const ev = j.body.entries.map((e) => e.event);
    assert.ok(ev.includes('copy') && ev.includes('copy-done'));
    assert.ok(!JSON.stringify(j.body).includes(data.subarray(0, 8).toString('base64')));
  });

  test('refus d\'écraser sans confirmation ; écrasement confirmé ; un dossier n\'est jamais fusionné', async () => {
    put(a, 'src/note.txt', 'nouveau');
    put(b, 'dest/note.txt', 'ancien');
    assert.equal((await copy(admin, body('~/src/note.txt'))).status, 409);
    assert.equal(fs.readFileSync(at(b, 'dest/note.txt'), 'utf8'), 'ancien');
    assert.equal((await copy(admin, body('~/src/note.txt', { overwrite: true }))).status, 400, 'écraser exige confirm: true');
    assert.equal(fs.readFileSync(at(b, 'dest/note.txt'), 'utf8'), 'ancien');
    const ok = await copy(admin, body('~/src/note.txt', { overwrite: true, confirm: true }));
    assert.equal(ok.status, 202);
    assert.equal((await finish(admin, ok.body.copy.id)).state, 'done');
    assert.equal(fs.readFileSync(at(b, 'dest/note.txt'), 'utf8'), 'nouveau');
    // Dossier déjà présent côté destination : refus même avec confirmation
    put(a, 'src/dossier/x.txt', 'x');
    put(b, 'dest/dossier/y.txt', 'y');
    assert.equal((await copy(admin, body('~/src/dossier', { overwrite: true, confirm: true }))).status, 409);
    assert.deepEqual(listing(b, 'dest/dossier'), ['y.txt']);
    // Un dossier occupe le nom du fichier : refus
    put(b, 'dest/vide-ou-non/z', 'z');
    assert.equal((await copy(admin, body('~/src/note.txt', { name: 'vide-ou-non', overwrite: true, confirm: true }))).status, 409);
  });

  test('copie d\'un dossier : arborescence, dossiers vides, liens symboliques ignorés (jamais suivis)', async () => {
    put(a, 'tree/a.txt', 'A');
    put(a, 'tree/sous/b.txt', 'B');
    put(a, 'tree/sous/profond/c.txt', 'C');
    fs.mkdirSync(at(a, 'tree/vide'), { recursive: true });
    fs.symlinkSync('/etc/hostname', at(a, 'tree/lien-vers-hostname'));
    fs.symlinkSync(at(a, 'src'), at(a, 'tree/sous/lien-dossier'));
    const r = await copy(admin, body('~/tree'));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.copy.totalFiles, 3);
    assert.equal(r.body.copy.skipped, 2);
    const done = await finish(admin, r.body.copy.id);
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(fs.readFileSync(at(b, 'dest/tree/sous/profond/c.txt'), 'utf8'), 'C');
    assert.ok(fs.statSync(at(b, 'dest/tree/vide')).isDirectory());
    assert.deepEqual(listing(b, 'dest/tree'), ['a.txt', 'sous', 'vide']);
    assert.deepEqual(listing(b, 'dest/tree/sous'), ['b.txt', 'profond'], 'ni lien recréé ni contenu pointé copié');
    assert.deepEqual(listing(b, 'dest').filter((n) => n.endsWith('.part')), []);
  });

  test('source = lien symbolique : refusée ; source absente : 404 ; même endroit : refusé', async () => {
    fs.symlinkSync('/etc', at(a, 'lien-etc'));
    assert.equal((await copy(admin, body('~/lien-etc'))).status, 400);
    assert.equal((await copy(admin, body('~/n-existe-pas'))).status, 404);
    put(a, 'moi/f.txt', 'f');
    assert.equal((await copy(admin, body('~/moi', { dir: '~/moi', from: ids.a, to: ids.a }))).status, 400, 'un dossier dans lui-même');
    assert.equal((await copy(admin, body('~/moi/f.txt', { dir: '~/moi', from: ids.a, to: ids.a }))).status, 400, 'un fichier sur lui-même');
    assert.equal((await copy(admin, body('~/moi', { dir: '~/moi/..', from: ids.a, to: ids.a }))).status, 400, 'sur lui-même via ..');
    // Copie légitime au sein d'un même hôte
    const ok = await copy(admin, body('~/moi/f.txt', { dir: '~/src', name: 'copie-de-f.txt', from: ids.a, to: ids.a }));
    assert.equal((await finish(admin, ok.body.copy.id)).state, 'done');
    assert.equal(fs.readFileSync(at(a, 'src/copie-de-f.txt'), 'utf8'), 'f');
  });

  test('limites : taille totale, nombre de fichiers, profondeur ; rien n\'est écrit', async () => {
    const before = listing(b, 'dest');
    cfg.copyMaxFiles = 3;
    for (let i = 0; i < 5; i++) put(a, `beaucoup/f${i}`, 'x');
    const many = await copy(admin, body('~/beaucoup'));
    assert.equal(many.status, 413);
    assert.equal(many.body.error?.code ?? many.body.code, 'TOO_MANY');
    cfg.copyMaxFiles = 5000;
    cfg.copyMaxBytes = 1024 * 1024;
    put(a, 'gros.bin', Buffer.alloc(2 * 1024 * 1024));
    assert.equal((await copy(admin, body('~/gros.bin'))).status, 413);
    put(a, 'dossier-gros/un.bin', Buffer.alloc(800 * 1024));
    put(a, 'dossier-gros/deux.bin', Buffer.alloc(800 * 1024));
    assert.equal((await copy(admin, body('~/dossier-gros'))).status, 413, 'la somme dépasse la limite');
    cfg.copyMaxBytes = 2048 * 1024 * 1024;
    let deep = 'profond';
    for (let i = 0; i < 34; i++) deep += '/d';
    put(a, `${deep}/f`, 'x');
    assert.equal((await copy(admin, body('~/profond'))).status, 413, 'trop de niveaux');
    assert.deepEqual(listing(b, 'dest'), before);
  });

  test('annulation en cours de route : aucun fichier partiel, aucun dossier temporaire', async () => {
    cfg.copyMaxBps = 2 * 1024 * 1024;
    put(a, 'lent/un.bin', Buffer.alloc(6 * 1024 * 1024, 1));
    put(a, 'lent/deux.bin', Buffer.alloc(6 * 1024 * 1024, 2));
    const before = listing(b, 'dest');
    // fichier
    const f = await copy(admin, body('~/lent/un.bin', { name: 'lent-fichier.bin' }));
    assert.equal(f.status, 202);
    await waitFor(async () => (await admin.api('GET', `/api/fs/copy/${f.body.copy.id}`)).body.copy.bytes > 0);
    const c1 = await admin.api('DELETE', `/api/fs/copy/${f.body.copy.id}`);
    assert.equal(c1.status, 200);
    assert.equal((await finish(admin, f.body.copy.id)).state, 'cancelled');
    // dossier
    const d = await copy(admin, body('~/lent', { name: 'lent-dossier' }));
    await waitFor(async () => (await admin.api('GET', `/api/fs/copy/${d.body.copy.id}`)).body.copy.bytes > 0);
    await admin.api('DELETE', `/api/fs/copy/${d.body.copy.id}`);
    assert.equal((await finish(admin, d.body.copy.id)).state, 'cancelled');
    assert.deepEqual(listing(b, 'dest'), before, 'ni fichier partiel, ni dossier temporaire, ni cible');
    const j = await admin.api('GET', '/api/journal?type=sftp');
    assert.ok(j.body.entries.some((e) => e.event === 'copy-cancel'));
    cfg.copyMaxBps = 0;
  });

  test('copies simultanées bornées (429), puis annulation', async () => {
    cfg.copyMaxBps = 1024 * 1024;
    const started = [];
    for (let i = 0; i < 3; i++) started.push(await copy(admin, body('~/lent/un.bin', { name: `simultanee-${i}.bin` })));
    assert.deepEqual(started.map((r) => r.status), [202, 202, 429]);
    for (const r of started.filter((x) => x.status === 202)) await admin.api('DELETE', `/api/fs/copy/${r.body.copy.id}`);
    for (const r of started.filter((x) => x.status === 202)) await finish(admin, r.body.copy.id);
    cfg.copyMaxBps = 0;
  });

  test('droits : opérateur sur la destination, lecture sur la source ; hôte non accordé = 404 identique ; lecteur refusé', async () => {
    const { users } = env.corvus.ctx;
    put(a, 'droits/f.txt', 'd');
    const op = makeUser(env.corvus, { username: 'ops', password: 'mot-de-passe-operateur', role: 'operator' });
    users.setGrants(op.id, [{ scope: 'host', target: ids.a, role: 'viewer' }, { scope: 'host', target: ids.b, role: 'operator' }]);
    const cop = await asUser(op);
    const ok = await copy(cop, body('~/droits/f.txt', { name: 'droits.txt' }));
    assert.equal(ok.status, 202, 'viewer sur la source + operator sur la destination');
    assert.equal((await finish(cop, ok.body.copy.id)).state, 'done');
    // Sens inverse : operator seulement sur B, viewer sur A → écrire sur A est refusé (lecture seule)
    const inverse = await copy(cop, body('~/dest/droits.txt', { dir: '~/droits', from: ids.b, to: ids.a }));
    assert.equal(inverse.status, 403);
    // Hôte non accordé : 404, identique à un hôte inexistant, et rien n'est lu ni écrit
    const lone = makeUser(env.corvus, { username: 'seul', password: 'mot-de-passe-seul-12', role: 'operator' });
    users.setGrants(lone.id, [{ scope: 'host', target: ids.b, role: 'operator' }]);
    const cl = await asUser(lone);
    const denied = await copy(cl, body('~/droits/f.txt', { name: 'interdit.txt' }));
    const ghost = await copy(cl, body('~/droits/f.txt', { name: 'interdit.txt', from: 'abcdefabcdef' }));
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.body, ghost.body);
    assert.ok(!fs.existsSync(at(b, 'dest/interdit.txt')));
    // Destination non accordée
    const dstDenied = await copy(cl, body('~/dest/droits.txt', { from: ids.b, to: ids.a }));
    assert.equal(dstDenied.status, 404);
    // Compte « lecture seule » : refus global (rôle), même avec droits
    const ro = makeUser(env.corvus, { username: 'lecteur', password: 'mot-de-passe-lecteur', role: 'viewer' });
    users.setGrants(ro.id, [{ scope: 'host', target: ids.a, role: 'viewer' }, { scope: 'host', target: ids.b, role: 'viewer' }]);
    const cro = await asUser(ro);
    for (const u of ['/api/fs/copy', '/api/Fs/Copy/', '/api/FS/COPY']) assert.equal((await cro.api('POST', u, body('~/droits/f.txt'))).status, 403, `lecteur : ${u}`);
    assert.equal((await cro.api('GET', '/api/fs/copy')).status, 403);
    assert.equal((await fetch(`${env.base}/api/fs/copy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await copy(admin, body('~/droits/f.txt', { name: 'csrf.txt' }), { csrf: false })).status, 403, 'anti-CSRF');
    // Variantes de casse / « / » final : mêmes contrôles pour un compte non accordé
    for (const u of ['/api/Fs/Copy', '/api/fs/copy/']) assert.equal((await cl.api('POST', u, body('~/droits/f.txt', { name: 'interdit.txt' }))).status, 404, u);
  });

  test('une copie n\'est visible et annulable que par son propriétaire', async () => {
    cfg.copyMaxBps = 1024 * 1024;
    const r = await copy(admin, body('~/lent/un.bin', { name: 'privee.bin' }));
    const { users } = env.corvus.ctx;
    const other = makeUser(env.corvus, { username: 'autre', password: 'mot-de-passe-autre-12', role: 'operator' });
    users.setGrants(other.id, [{ scope: 'host', target: ids.a, role: 'viewer' }, { scope: 'host', target: ids.b, role: 'operator' }]);
    const co = await asUser(other);
    assert.equal((await co.api('GET', `/api/fs/copy/${r.body.copy.id}`)).status, 404);
    assert.equal((await co.api('DELETE', `/api/fs/copy/${r.body.copy.id}`)).status, 404);
    assert.deepEqual((await co.api('GET', '/api/fs/copy')).body.copies, []);
    await admin.api('DELETE', `/api/fs/copy/${r.body.copy.id}`);
    await finish(admin, r.body.copy.id);
    cfg.copyMaxBps = 0;
  });

  test('entrées hostiles : noms, chemins, types, valeurs démesurées', async () => {
    put(a, 'h/f.txt', 'h');
    const bad = [
      body('~/h/f.txt', { name: '../evil' }), body('~/h/f.txt', { name: 'a/b' }), body('~/h/f.txt', { name: '..' }), body('~/h/f.txt', { name: 'x'.repeat(300) }),
      body('~/h/f.txt', { name: 'a\nb' }), body('~/h/f.txt', { name: 'a\0b' }),
      body('x'.repeat(5000)), body('a\nb'), body('~/h/f.txt', { dir: 'a\nb' }),
      { from: { hostId: ids.a, path: '~/h/f.txt' } }, { to: { hostId: ids.b, dir: '~/dest' } }, { from: 'x', to: 'y' }, 'texte', [],
      { ...body('~/h/f.txt'), overwrite: 'oui' },
      body('~/h/f.txt', { from: '../x' }), body('~/h/f.txt', { to: 12 }),
    ];
    for (const x of bad) {
      const r = await copy(admin, x);
      assert.equal(r.status, 400, `${JSON.stringify(x).slice(0, 80)} → ${r.status}`);
    }
    assert.equal((await copy(admin, body('~/h/f.txt', { dir: '~/dest/note.txt' }))).status, 400, 'destination qui n\'est pas un dossier');
    // Dossier absent : 404 sur OpenSSH ; le faux sshd répond « échec » générique (400) — dans les deux cas, rien n'est écrit.
    assert.ok([400, 404].includes((await copy(admin, body('~/h/f.txt', { dir: '~/absent' }))).status));
    assert.equal((await admin.api('GET', '/api/fs/copy/nimportequoi1234')).status, 404);
    assert.equal((await admin.api('GET', '/api/fs/copy/court')).status, 400);
    assert.deepEqual(listing(b, 'dest').filter((n) => n.includes('evil')), []);
    assert.ok(!fs.existsSync(path.join(b.root, '..', 'evil')));
  });
});
