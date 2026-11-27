// Étape 2 — Recherche plein texte dans les enregistrements, export .cast, droits et journal.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';
import { parseCast, plainText, findInPlain, timeAt } from '../server/lib/castsearch.js';

const ESC = '\u001b';
const cast = (events, extra = {}) => `${JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 1, ...extra })}\n${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

describe('castsearch (unitaire)', () => {
  test('séquences d\'échappement retirées, y compris coupées entre deux événements', () => {
    const ev = [
      [0.1, 'o', `${ESC}[1;3`], [0.2, 'o', '1mrou'], [0.3, 'o', `ge${ESC}[0m va`],
      [0.4, 'o', `${ESC}]0;titre de fenêtre`], [0.5, 'o', `\u0007lide\r\n`], [0.6, 'o', `${ESC}`], [0.7, 'o', '[2Jfin'],
    ];
    const p = plainText(ev);
    assert.equal(p.plain, 'rouge valide\nfin');
    assert.ok(!p.plain.includes(ESC));
    assert.ok(!p.plain.includes('titre de fenêtre'), 'OSC retirée même coupée');
    const f = findInPlain(p, 'rouge va');
    assert.equal(f.total, 1, 'une phrase affichée à cheval sur trois événements est trouvée');
    assert.equal(f.matches[0].t, 0.2, 'instant de l\'événement où la correspondance commence');
    assert.equal(findInPlain(p, '1;31m').total, 0, 'jamais de reste de séquence');
    assert.equal(findInPlain(p, 'fin').matches[0].t, 0.7);
  });

  test('UTF-8, casse, caractères de contrôle, occurrences multiples et pagination', () => {
    const ev = [[0, 'o', 'Déjà vu — ÉTÉ été\n'], [1, 'o', 'été encore\u0000\u0007\n']];
    const p = plainText(ev);
    const f = findInPlain(p, 'ÉTÉ');
    assert.equal(f.total, 3);
    assert.deepEqual(f.matches.map((m) => m.t), [0, 0, 1]);
    const page = findInPlain(p, 'été', { offset: 1, limit: 1 });
    assert.equal(page.matches.length, 1);
    assert.equal(page.total, 3);
    assert.equal(findInPlain(p, 'déjà vu — ').total, 1);
    assert.equal(findInPlain(p, 'absent').total, 0);
  });

  test('ordre inverse du temps et cast sans événement : pas d\'erreur', () => {
    assert.equal(findInPlain(plainText([]), 'x').total, 0);
    assert.equal(timeAt([], 5), 0);
    const { events } = parseCast('pas du json\n[1,"o","a"]\n[2,"o",');
    assert.equal(events.length, 1, 'ligne tronquée ignorée');
  });

  test('borne de temps : une échéance dépassée interrompt le travail', () => {
    const big = Array.from({ length: 6000 }, (_, i) => [i, 'o', 'ligne\n']);
    const p = plainText(big, { deadline: Date.now() - 1 });
    assert.equal(p.timedOut, true);
  });
});

describe('API des enregistrements', () => {
  let env; let admin; const ids = {}; let alice; let bob; let ca; let cb; let cadm;
  const mkSession = ({ id, hostId, user, events, startedAt = Date.now() - 3600_000, label }) => {
    const { db, blobs } = env.corvus.ctx;
    const text = cast(events);
    const sha = blobs.put(Buffer.from(text, 'utf8'), 'recording');
    db.run(`INSERT INTO term_sessions (id, host_id, user_id, username, host_label, title, tmux, started_at, ended_at, cols, rows, recording_sha, recording_bytes, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 80, 24, ?, ?, 5000)`, id, hostId, user.id, user.username, label, 'test', startedAt, startedAt + 5000, sha, text.length);
    return text;
  };
  const asUser = async (u) => { const c = new CorvusClient(env.base, { corvus: env.corvus, user: u }); assert.equal((await c.login()).status, 200); return c; };

  before(async () => {
    env = await startCorvus();
    admin = env.client; await admin.login(); cadm = admin;
    for (const n of ['h1', 'h2']) ids[n] = (await admin.api('POST', '/api/hosts', { name: n, hostname: `${n}.example`, username: 'pi', password: 'x' })).body.host.id;
    alice = makeUser(env.corvus, { username: 'alice', password: 'mot-de-passe-alice-1', role: 'operator' });
    bob = makeUser(env.corvus, { username: 'bob', password: 'mot-de-passe-bob-123', role: 'operator' });
    for (const u of [alice, bob]) env.corvus.ctx.users.setGrants(u.id, [{ scope: 'host', target: ids.h1, role: 'operator' }]);
    mkSession({ id: 'sessionalice0001', hostId: ids.h1, user: alice, label: 'h1', startedAt: Date.now() - 7200_000,
      events: [[0.5, 'o', 'alice$ echo SecretAlice\r\n'], [1.5, 'o', `${ESC}[32mSecretAlice${ESC}[0m\r\n`], [9.25, 'o', 'fin de session\r\n']] });
    mkSession({ id: 'sessionbob000001', hostId: ids.h1, user: bob, label: 'h1', startedAt: Date.now() - 3600_000,
      events: [[0.2, 'o', 'bob$ echo SecretBob\r\n']] });
    ca = await asUser(alice); cb = await asUser(bob);
  });
  after(() => env.close());

  test('recherche dans une session : instants, extraits, pagination, journalisée sans la requête', async () => {
    const r = await ca.api('GET', '/api/recordings/sessionalice0001/search?q=secretalice');
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 2);
    assert.deepEqual(r.body.matches.map((m) => m.t), [0.5, 1.5]);
    assert.match(r.body.matches[0].snippet, /echo SecretAlice/);
    const p2 = await ca.api('GET', '/api/recordings/sessionalice0001/search?q=secretalice&offset=1&limit=1');
    assert.equal(p2.body.matches.length, 1);
    assert.equal(p2.body.matches[0].t, 1.5);
    const j = await admin.api('GET', '/api/journal?type=terminal');
    const e = j.body.entries.find((x) => x.event === 'search' && x.user === 'alice');
    assert.ok(e, 'recherche journalisée');
    assert.ok(!JSON.stringify(j.body).toLowerCase().includes('secretalice'), 'la requête n\'est jamais écrite dans le journal');
  });

  test('droits : un opérateur ne trouve rien dans les sessions des autres, 404 identique à une session inexistante', async () => {
    const other = await cb.api('GET', '/api/recordings/sessionalice0001/search?q=SecretAlice');
    const none = await cb.api('GET', '/api/recordings/inexistante00001/search?q=SecretAlice');
    assert.equal(other.status, 404);
    assert.deepEqual(other.body, none.body);
    assert.equal((await cb.api('GET', '/api/recordings/sessionalice0001/export')).status, 404);
    assert.equal((await cb.api('GET', '/api/recordings/sessionalice0001')).status, 404);
    const all = await cb.api('GET', '/api/recordings/search?q=SecretAlice');
    assert.equal(all.status, 200);
    assert.equal(all.body.results.length, 0);
    const mine = await cb.api('GET', '/api/recordings/search?q=SecretBob');
    assert.deepEqual(mine.body.results.map((x) => x.id), ['sessionbob000001']);
    // L'administrateur voit tout
    const adm = await cadm.api('GET', '/api/recordings/search?q=Secret');
    assert.deepEqual(adm.body.results.map((x) => x.id).sort(), ['sessionalice0001', 'sessionbob000001']);
  });

  test('accès à l\'hôte retiré : plus de recherche ni d\'export', async () => {
    env.corvus.ctx.users.setGrants(alice.id, []);
    const c = await asUser(alice);
    assert.equal((await c.api('GET', '/api/recordings/sessionalice0001/search?q=Secret')).status, 404);
    assert.equal((await c.api('GET', '/api/recordings/sessionalice0001/export')).status, 404);
    assert.equal((await c.api('GET', '/api/recordings/search?q=Secret')).body.results.length, 0);
    env.corvus.ctx.users.setGrants(alice.id, [{ scope: 'host', target: ids.h1, role: 'operator' }]);
  });

  test('export : fichier .cast valide et rejouable, en-têtes sûrs, journalisé', async () => {
    const r = await ca.raw('GET', '/api/recordings/sessionalice0001/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="corvus-h1-\d{4}-\d{2}-\d{2}\.cast"$/);
    assert.match(r.headers.get('content-type'), /asciicast/);
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    const text = await r.text();
    const parsed = parseCast(text);
    assert.equal(parsed.header.version, 2);
    assert.equal(parsed.events.length, 3);
    assert.ok(parsed.events.every((e) => e[1] === 'o'), 'seulement la sortie');
    const j = await admin.api('GET', '/api/journal?type=terminal');
    assert.ok(j.body.entries.some((x) => x.event === 'export' && x.user === 'alice'));
  });

  test('entrées hostiles : requête vide, démesurée, caractères de contrôle, doublée, bornes', async () => {
    const base = '/api/recordings/sessionalice0001/search';
    assert.equal((await ca.api('GET', `${base}`)).status, 400);
    assert.equal((await ca.api('GET', `${base}?q=`)).status, 400);
    assert.equal((await ca.api('GET', `${base}?q=${'a'.repeat(201)}`)).status, 400);
    assert.equal((await ca.api('GET', `${base}?q=a%00b`)).status, 400);
    assert.equal((await ca.api('GET', `${base}?q=a%0Ab`)).status, 400);
    assert.equal((await ca.api('GET', `${base}?q=a&q=b`)).status, 400);
    assert.equal((await ca.api('GET', `${base}?q=a&limit=100000`)).status, 400);
    assert.equal((await ca.api('GET', `${base}?q=a&offset=-1`)).status, 400);
    assert.equal((await ca.api('GET', '/api/recordings/search?q=a&before=abc')).status, 400);
    assert.equal((await ca.api('GET', '/api/recordings/..%2f..%2fetc/search?q=a')).status, 404);
    assert.equal((await ca.api('GET', `${base}?q=${encodeURIComponent('%.*[a-z](')}`)).status, 200, 'pas d\'expression régulière : le texte est cherché tel quel');
  });

  test('variantes de casse et « / » final : mêmes contrôles', async () => {
    for (const u of ['/api/Recordings/sessionalice0001/Search?q=Secret', '/api/recordings/sessionalice0001/search/?q=Secret', '/api/RECORDINGS/search/?q=Secret']) {
      const forBob = await cb.api('GET', u);
      assert.ok(forBob.status === 404 || (forBob.status === 200 && !JSON.stringify(forBob.body).includes('sessionalice')), `${u} → ${forBob.status}`);
    }
    assert.equal((await cb.api('GET', '/api/Recordings/sessionalice0001/Export/')).status, 404);
    assert.equal((await fetch(`${env.base}/api/recordings/search?q=a`)).status, 401);
  });

  test('pagination entre sessions : curseur « next » quand le budget est atteint', () => {
    const r = env.corvus.ctx.recorder.searchMany(Array.from({ length: 3 }, () => env.corvus.ctx.db.get('SELECT * FROM term_sessions WHERE id = ?', 'sessionalice0001')), 'secret', { maxSessions: 2 });
    assert.equal(r.scanned, 2);
    assert.ok(r.next, 'reprise possible');
  });
});
