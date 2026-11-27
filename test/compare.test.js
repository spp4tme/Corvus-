// Étape 1 — Comparer une configuration entre hôtes : diff en JS pur, masquage, droits, entrées hostiles.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';
import { splitLines, diffOps, sideBySide, maskLines, MASK, MAX_LINES } from '../server/lib/diff.js';

describe('diff (JS pur)', () => {
  test('fichiers vides et identiques', () => {
    assert.deepEqual(splitLines(''), []);
    assert.equal(sideBySide([], []).identical, true);
    const l = ['a', 'b', 'c'];
    const r = sideBySide(l, [...l]);
    assert.equal(r.identical, true);
    assert.equal(r.changed, 0);
  });

  test('fins de ligne CRLF ignorées, « \\n » final sans ligne vide', () => {
    assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
    assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
    assert.deepEqual(splitLines('a\n\n'), ['a', '']);
    assert.equal(sideBySide(splitLines('x\r\ny\r\n'), splitLines('x\ny\n')).identical, true);
  });

  test('ajout, suppression et modification', () => {
    const r = sideBySide(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'e', 'f']);
    const kinds = r.rows.map((x) => x.k).join('');
    assert.equal(kinds, '=~=~+');
    assert.equal(r.rows[1].a, 'b');
    assert.equal(r.rows[1].b, 'B');
    const del = sideBySide(['a', 'b'], ['a']);
    assert.deepEqual(del.rows.map((x) => x.k), ['=', '-']);
    const empty = sideBySide([], ['x', 'y']);
    assert.deepEqual(empty.rows.map((x) => x.k), ['+', '+']);
  });

  test('les ops reconstruisent exactement les deux fichiers (propriété sur des cas aléatoires)', () => {
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let t = 0; t < 60; t++) {
      const a = Array.from({ length: rnd(40) }, () => String(rnd(6)));
      const b = Array.from({ length: rnd(40) }, () => String(rnd(6)));
      const ops = diffOps(a, b);
      const ra = ops.filter((o) => o.op !== '+').map((o) => a[o.a]);
      const rb = ops.filter((o) => o.op !== '-').map((o) => b[o.b]);
      assert.deepEqual(ra, a);
      assert.deepEqual(rb, b);
    }
  });

  test('blocs identiques repliés (3 lignes de contexte)', () => {
    const a = Array.from({ length: 100 }, (_, i) => `l${i}`);
    const b = [...a];
    b[50] = 'changé';
    const r = sideBySide(a, b);
    assert.ok(r.rows.some((x) => x.k === '…' && x.n > 40));
    assert.ok(r.rows.length < 20);
  });

  test('bornes : trop de lignes, trop différents, lignes très longues tronquées', () => {
    const big = Array.from({ length: MAX_LINES + 1 }, (_, i) => String(i));
    assert.throws(() => diffOps(big, []), (e) => e.status === 413);
    const x = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const y = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    assert.throws(() => diffOps(x, y), (e) => e.status === 413 && e.code === 'TOO_DIFFERENT');
    const r = sideBySide(['z'.repeat(50000)], ['y']);
    assert.ok(r.rows[0].a.length <= 2001);
  });
});

describe('masquage des valeurs sensibles', () => {
  test('mots de passe, jetons, clés : valeur masquée ; interrupteurs et commentaires conservés', () => {
    const out = maskLines([
      'PasswordAuthentication no',
      'db_password = hunter2',
      'API_TOKEN=abcdef',
      'export SECRET_KEY="xyz"',
      'secret: s3cr3t',
      '# password = en-commentaire',
      'PermitRootLogin prohibit-password',
      'Port 22',
      'PrivateKey = AAAA',
    ]);
    assert.deepEqual(out, [
      'PasswordAuthentication no',
      `db_password = ${MASK}`,
      `API_TOKEN=${MASK}`,
      `export SECRET_KEY=${MASK}`,
      `secret: ${MASK}`,
      '# password = en-commentaire',
      'PermitRootLogin prohibit-password',
      'Port 22',
      `PrivateKey = ${MASK}`,
    ]);
  });

  test('bloc de clé privée entièrement masqué', () => {
    const out = maskLines(['a', '-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaA', 'AAAA', '-----END OPENSSH PRIVATE KEY-----', 'b']);
    assert.deepEqual(out, ['a', MASK, MASK, MASK, MASK, 'b']);
  });
});

describe('API /api/compare (faux sshd)', () => {
  let env; let admin; let a; let b; let c;
  const ids = {};
  const asUser = async (user) => {
    const cl = new CorvusClient(env.base, { corvus: env.corvus, user });
    assert.equal((await cl.login()).status, 200);
    return cl;
  };
  const put = (s, rel, content) => {
    fs.mkdirSync(path.dirname(path.join(s.root, rel)), { recursive: true });
    fs.writeFileSync(path.join(s.root, rel), content);
  };

  before(async () => {
    [a, b, c] = await Promise.all([startFakeSshd(), startFakeSshd(), startFakeSshd()]);
    put(a, 'conf/sshd_config', 'Port 22\nPermitRootLogin no\nPassword hunter2\nX11Forwarding yes\n');
    put(b, 'conf/sshd_config', 'Port 2222\nPermitRootLogin no\nPassword hunter3\nX11Forwarding yes\n');
    put(c, 'conf/sshd_config', 'Port 22\n');
    put(b, 'conf/binaire', Buffer.from([1, 2, 0, 3]));
    put(a, 'conf/binaire', Buffer.from([1, 2, 0, 3]));
    put(a, 'conf/gros', 'x'.repeat(600 * 1024));
    put(b, 'conf/gros', 'x');
    put(b, 'conf/seulement-a', 'y');
    env = await startCorvus();
    admin = env.client;
    await admin.login();
    for (const [name, s] of [['a', a], ['b', b], ['c', c]]) {
      const r = await admin.api('POST', '/api/hosts', { name, hostname: '127.0.0.1', port: s.port, username: s.user, authType: 'password', password: s.password });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids[name] = r.body.host.id;
    }
  });
  after(async () => { await env?.close(); await Promise.all([a, b, c].map((s) => s?.close())); });

  const cmp = (cl, body, url = '/api/compare') => cl.api('POST', url, body);
  // Chemin relatif au dossier personnel : le même sur tous les hôtes (chacun a sa propre racine).
  const P = () => '~/conf/sshd_config';

  test('compare deux hôtes : différences, valeur sensible masquée, journalisé sans contenu', async () => {
    const r = await cmp(admin, { path: P(a), hostIds: [ids.a, ids.b] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.masked, true);
    assert.equal(r.body.reference, ids.a);
    const rows = r.body.diffs[0].rows;
    assert.ok(rows.some((x) => x.k === '~' && x.a === 'Port 22' && x.b === 'Port 2222'));
    // « Password hunter2 / hunter3 » : jamais en clair, mais la différence est signalée
    const pw = rows.find((x) => /^Password/.test(x.a || ''));
    assert.equal(pw.k, '~');
    assert.ok(!JSON.stringify(r.body).includes('hunter'));
    const j = await admin.api('GET', '/api/journal?type=sftp');
    const e = j.body.entries.find((x) => x.event === 'compare');
    assert.ok(e && /sur 2 hôtes/.test(e.detail) && !e.detail.includes('hunter'));
  });

  test('révéler : valeurs en clair, journalisé à part', async () => {
    const r = await cmp(admin, { path: P(a), hostIds: [ids.a, ids.b], reveal: true });
    assert.equal(r.body.masked, false);
    assert.ok(JSON.stringify(r.body).includes('hunter2'));
    const j = await admin.api('GET', '/api/journal?type=sftp');
    assert.ok(j.body.entries.some((x) => x.event === 'compare-reveal'));
  });

  test('trois hôtes, fichier absent sur un d\'eux : erreur par hôte, le reste est comparé', async () => {
    const r = await cmp(admin, { path: '~/conf/seulement-a', hostIds: [ids.a, ids.b, ids.c] });
    assert.equal(r.status, 200);
    assert.equal(r.body.hosts[0].ok, false);
    assert.equal(r.body.hosts[0].error.status, 404);
    assert.ok(r.body.diffs.every((d) => d.skipped));
  });

  test('refus : binaire, trop gros, un seul hôte, doublons, plus de 5, entrées hostiles', async () => {
    const bin = await cmp(admin, { path: '~/conf/binaire', hostIds: [ids.a, ids.b] });
    assert.equal(bin.body.hosts[0].error.status, 415);
    const gros = await cmp(admin, { path: '~/conf/gros', hostIds: [ids.a, ids.b] });
    assert.equal(gros.body.hosts[0].error.status, 413);
    assert.equal((await cmp(admin, { path: P(a), hostIds: [ids.a] })).status, 400);
    assert.equal((await cmp(admin, { path: P(a), hostIds: [ids.a, ids.a] })).status, 400);
    const extra = [];
    for (const n of ['d', 'e', 'f']) extra.push((await admin.api('POST', '/api/hosts', { name: n, hostname: `${n}.example`, username: 'pi', password: 'x' })).body.host.id);
    assert.equal((await cmp(admin, { path: P(a), hostIds: [ids.a, ids.b, ids.c, ...extra] })).status, 400, 'plus de 5 hôtes');
    assert.equal((await cmp(admin, { path: P(a), hostIds: Array.from({ length: 50 }, () => ids.a) })).status, 400, 'liste démesurée');
    assert.equal((await cmp(admin, { path: P(a), hostIds: 'x' })).status, 400);
    assert.equal((await cmp(admin, { path: 'x'.repeat(5000), hostIds: [ids.a, ids.b] })).status, 400);
    assert.equal((await cmp(admin, { path: 'a\nb', hostIds: [ids.a, ids.b] })).status, 400);
    assert.equal((await cmp(admin, { path: 'a\0b', hostIds: [ids.a, ids.b] })).status, 400);
    assert.equal((await cmp(admin, { path: P(a), hostIds: [ids.a, '../x'] })).status, 400);
    // « ../ » : le fichier est simplement lu à son chemin normalisé (aucun shell), jamais hors de l'hôte demandé.
    const t = await cmp(admin, { path: '~/conf/../conf/sshd_config', hostIds: [ids.a, ids.b] });
    assert.equal(t.status, 200);
  });

  test('droits : lecteur autorisé sur les hôtes accordés, hôte non accordé = 404 sans rien lire', async () => {
    const ro = makeUser(env.corvus, { username: 'lecteur', password: 'mot-de-passe-lecteur', role: 'viewer' });
    env.corvus.ctx.users.setGrants(ro.id, [{ scope: 'host', target: ids.a, role: 'viewer' }, { scope: 'host', target: ids.b, role: 'viewer' }]);
    const cl = await asUser(ro);
    assert.equal((await cmp(cl, { path: P(a), hostIds: [ids.a, ids.b] })).status, 200);
    const denied = await cmp(cl, { path: P(a), hostIds: [ids.a, ids.c] });
    assert.equal(denied.status, 404, 'hôte non accordé invisible');
    assert.ok(!JSON.stringify(denied.body).includes('conf'));
    // Un hôte inexistant donne la même réponse qu'un hôte non accordé.
    const ghost = await cmp(cl, { path: P(a), hostIds: [ids.a, 'abcdefabcdef'] });
    assert.equal(ghost.status, 404);
    assert.deepEqual(ghost.body, denied.body);
    assert.equal((await cmp(admin, { path: P(a), hostIds: [ids.a, ids.b] })).status, 200);
  });

  test('variantes de casse et « / » final : mêmes contrôles', async () => {
    const ro = env.corvus.ctx.users.byName('lecteur');
    const cl = await asUser({ ...ro, password: 'mot-de-passe-lecteur', secret: env.corvus.ctx.users.totpSecret(ro.id) });
    for (const url of ['/api/Compare', '/api/compare/', '/api/COMPARE']) {
      const r = await cmp(cl, { path: P(a), hostIds: [ids.a, ids.c] }, url);
      assert.ok([404, 403].includes(r.status) && r.status !== 200, `${url} → ${r.status}`);
    }
    assert.equal((await cmp(cl, { path: P(a), hostIds: [ids.a, ids.b] }, '/api/Compare/')).status, 200);
    // Sans session : refusé
    assert.equal((await fetch(`${env.base}/api/compare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  });
});
