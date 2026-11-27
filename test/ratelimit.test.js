// Limiteur de débit des routes authentifiées de /api : par compte et par IP, plafond plus strict pour les sauvegardes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBuckets, RequestLimiter, isStrictPath } from '../server/lib/ratelimit.js';
import { startCorvus, makeUser } from './helpers/corvus.js';

const clock = (t0 = 1_000_000) => { let t = t0; const now = () => t; now.advance = (ms) => { t += ms; }; return now; };

describe('seaux à jetons (unitaire)', () => {
  test('capacité, épuisement, rechargement progressif', () => {
    const now = clock();
    const b = new TokenBuckets({ perMinute: 6, now });
    for (let i = 0; i < 6; i++) { assert.equal(b.waitFor('k'), 0); b.spend('k'); }
    assert.equal(b.waitFor('k'), 10_000, 'un jeton toutes les 10 s (6/min)');
    now.advance(4_000);
    assert.equal(b.waitFor('k'), 6_000);
    now.advance(6_000);
    assert.equal(b.waitFor('k'), 0);
    // Jamais au-delà de la capacité, même après une longue inactivité.
    now.advance(3_600_000);
    for (let i = 0; i < 6; i++) b.spend('k');
    assert.ok(b.waitFor('k') > 0);
  });

  test('valeurs invalides refusées (un plafond ne peut pas être « désactivé »)', () => {
    for (const bad of [0, -1, NaN, Infinity, undefined]) assert.throws(() => new TokenBuckets({ perMinute: bad }), RangeError, String(bad));
  });

  test('mémoire bornée : jamais plus de maxKeys seaux, même sous un flot de clés', () => {
    const now = clock();
    const b = new TokenBuckets({ perMinute: 5, maxKeys: 50, now });
    for (let i = 0; i < 5_000; i++) { b.spend(`ip-${i}`); now.advance(1); }
    assert.ok(b.buckets.size <= 50, `taille ${b.buckets.size}`);
  });
});

describe('limiteur de requêtes (unitaire)', () => {
  test('un compte épuisé est refusé ; un autre compte, non (même IP tant que son plafond tient)', () => {
    const now = clock();
    const l = new RequestLimiter({ accountPerMin: 3, ipPerMin: 100, strictPerMin: 2, now });
    for (let i = 0; i < 3; i++) assert.equal(l.check({ accountId: 'a', ip: '10.0.0.1' }).ok, true);
    const r = l.check({ accountId: 'a', ip: '10.0.0.1' });
    assert.equal(r.ok, false);
    assert.equal(r.scope, 'account');
    assert.ok(r.retryAfterMs > 0);
    assert.equal(l.check({ accountId: 'b', ip: '10.0.0.1' }).ok, true);
  });

  test('plafond par IP : plusieurs comptes derrière la même IP le partagent', () => {
    const l = new RequestLimiter({ accountPerMin: 100, ipPerMin: 4, strictPerMin: 2, now: clock() });
    for (const id of ['a', 'b', 'a', 'b']) assert.equal(l.check({ accountId: id, ip: '10.0.0.9' }).ok, true);
    const r = l.check({ accountId: 'c', ip: '10.0.0.9' });
    assert.deepEqual([r.ok, r.scope], [false, 'ip']);
    assert.equal(l.check({ accountId: 'c', ip: '10.0.0.10' }).ok, true, 'une autre IP n\'est pas touchée');
  });

  test('un refus ne débite rien : le seau de l\'autre portée n\'est pas vidé par un refus', () => {
    const l = new RequestLimiter({ accountPerMin: 1, ipPerMin: 5, strictPerMin: 5, now: clock() });
    assert.equal(l.check({ accountId: 'a', ip: '10.0.0.1' }).ok, true);
    for (let i = 0; i < 50; i++) assert.equal(l.check({ accountId: 'a', ip: '10.0.0.1' }).ok, false);
    // Si les refus débitaient le seau de l'IP, il serait vide : un autre compte de la même IP passe encore.
    for (let i = 0; i < 4; i++) assert.equal(l.check({ accountId: `x${i}`, ip: '10.0.0.1' }).ok, true, `x${i}`);
  });

  test('plafond strict : s\'ajoute au global, par compte ET par IP', () => {
    const l = new RequestLimiter({ accountPerMin: 100, ipPerMin: 100, strictPerMin: 2, now: clock() });
    assert.equal(l.check({ accountId: 'a', ip: '1.1.1.1', strict: true }).ok, true);
    assert.equal(l.check({ accountId: 'a', ip: '1.1.1.1', strict: true }).ok, true);
    const r = l.check({ accountId: 'a', ip: '1.1.1.1', strict: true });
    assert.deepEqual([r.ok, r.strict], [false, true]);
    assert.equal(l.check({ accountId: 'a', ip: '1.1.1.1' }).ok, true, 'les routes ordinaires restent permises');
    assert.equal(l.check({ accountId: 'b', ip: '1.1.1.1', strict: true }).ok, false, 'même IP : le plafond strict par IP s\'applique aussi');
    assert.equal(l.check({ accountId: 'b', ip: '2.2.2.2', strict: true }).ok, true);
  });

  test('signalement au journal : au plus une fois par minute et par clé', () => {
    const now = clock();
    const l = new RequestLimiter({ accountPerMin: 1, ipPerMin: 1, strictPerMin: 1, now });
    assert.equal(l.shouldReport('account', false, 'a'), true);
    assert.equal(l.shouldReport('account', false, 'a'), false);
    assert.equal(l.shouldReport('account', true, 'a'), true, 'portée stricte distincte');
    assert.equal(l.shouldReport('ip', false, 'a'), true);
    now.advance(61_000);
    assert.equal(l.shouldReport('account', false, 'a'), true);
  });
});

describe('chemins sensibles (variantes de casse, « / » final, « // »)', () => {
  test('toutes les formes de /backups sont strictes ; les voisines non', () => {
    for (const p of ['/backups', '/Backups', '/BACKUPS/', '/backups/', '//backups', '///backups//x', '/backups/x.cvbk/restore', '/backups/restore']) {
      assert.equal(isStrictPath(p), true, p);
    }
    for (const p of ['/', '/backup', '/backupsx', '/hosts/abc/backups', '/system/status', '/x/backups', '', undefined, null]) {
      assert.equal(isStrictPath(p), false, String(p));
    }
  });
});

describe('limiteur de débit : intégration (serveur réel)', () => {
  let env; let alice; let bob; let tokA; let tokB;
  before(async () => {
    env = await startCorvus({ rateAccountPerMin: 8, rateIpPerMin: 1000, rateBackupPerMin: 3 });
    alice = makeUser(env.corvus, { username: 'alice', password: 'Un-mot-de-passe-solide-1', role: 'admin' });
    bob = makeUser(env.corvus, { username: 'bob', password: 'Un-mot-de-passe-solide-2', role: 'viewer' });
    tokA = env.corvus.ctx.users.createToken(alice.id, 't').token;
    tokB = env.corvus.ctx.users.createToken(bob.id, 't').token;
  });
  after(() => env?.close());

  const get = (path, token) => fetch(env.base + path, { headers: { authorization: `Bearer ${token}` } });
  const entries = () => env.corvus.ctx.journal.list({ type: 'ratelimit' });

  test('plafond par compte : 429 + Retry-After ; l\'autre compte n\'est pas touché ; la santé publique non plus', async () => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await get('/api/me', tokA)).status);
    assert.equal(codes.filter((c) => c === 200).length, 8, `8 requêtes permises (obtenu : ${codes})`);
    assert.ok(codes.slice(8).every((c) => c === 429));
    const refused = await get('/api/me', tokA);
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) >= 1);
    assert.equal((await refused.json()).error.code, 'RATE_LIMITED');
    assert.equal((await get('/api/me', tokB)).status, 200, 'un autre compte garde son propre plafond');
    assert.equal((await fetch(`${env.base}/api/health`)).status, 200, 'route publique : hors limiteur');
  });

  test('journal : UNE entrée pour une rafale de refus, avec compte et IP, sans secret', () => {
    const e = entries().filter((x) => x.user === 'alice');
    assert.equal(e.length, 1, `entrées : ${e.length}`);
    assert.equal(e[0].ok, false);
    assert.equal(e[0].event, 'exceeded');
    assert.ok(e[0].ip);
    assert.match(e[0].detail, /global par compte/);
    assert.equal(JSON.stringify(e).includes(tokA), false, 'le jeton n\'apparaît jamais');
    assert.equal(env.corvus.ctx.journal.verify().ok, true, 'la chaîne du journal reste intacte');
  });

  test('routes de sauvegarde : plafond strict, y compris variantes de casse et « / » final', async () => {
    const carol = makeUser(env.corvus, { username: 'carol', password: 'Un-mot-de-passe-solide-3', role: 'admin' });
    const tok = env.corvus.ctx.users.createToken(carol.id, 't').token;
    const first = [];
    for (const p of ['/api/backups', '/api/Backups', '/api/BACKUPS/']) first.push((await get(p, tok)).status);
    assert.deepEqual(first, [200, 200, 200], 'trois requêtes permises (plafond strict = 3)');
    for (const p of ['/api/backups', '/api/Backups/', '/api/backups/x.cvbk/download', '/api//backups']) {
      assert.equal((await get(p, tok)).status, 429, p);
    }
    assert.equal((await get('/api/me', tok)).status, 200, 'les routes ordinaires de ce compte restent permises');
    const e = entries().filter((x) => x.user === 'carol');
    assert.equal(e.length, 1);
    assert.match(e[0].detail, /sauvegardes par compte/);
  });

});

describe('limiteur de débit : un compte sans droit est limité aussi (serveur réel)', () => {
  let env;
  // Serveur à part : le plafond strict par IP est partagé par tous les comptes de 127.0.0.1 dans les autres tests.
  before(async () => { env = await startCorvus({ rateAccountPerMin: 1000, rateIpPerMin: 1000, rateBackupPerMin: 3 }); });
  after(() => env?.close());

  test('un viewer reçoit 403 tant que son plafond tient, puis 429 : les tentatives interdites comptent aussi', async () => {
    const dave = makeUser(env.corvus, { username: 'dave', password: 'Un-mot-de-passe-solide-4', role: 'viewer' });
    const tok = env.corvus.ctx.users.createToken(dave.id, 't').token;
    const get = (p) => fetch(env.base + p, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.status);
    assert.deepEqual([await get('/api/backups'), await get('/api/backups'), await get('/api/backups')], [403, 403, 403]);
    assert.equal(await get('/api/backups'), 429);
    assert.equal(await get('/api/Backups/'), 429, 'variante de casse + « / » final : même plafond');
  });
});

describe('limiteur de débit : plafond par IP (serveur réel)', () => {
  let env;
  before(async () => { env = await startCorvus({ rateAccountPerMin: 1000, rateIpPerMin: 6, rateBackupPerMin: 3 }); });
  after(() => env?.close());

  test('deux comptes depuis la même IP partagent le plafond de l\'IP ; journal « par IP »', async () => {
    const a = makeUser(env.corvus, { username: 'ea', password: 'Un-mot-de-passe-solide-5', role: 'admin' });
    const b = makeUser(env.corvus, { username: 'eb', password: 'Un-mot-de-passe-solide-6', role: 'admin' });
    const ta = env.corvus.ctx.users.createToken(a.id, 't').token;
    const tb = env.corvus.ctx.users.createToken(b.id, 't').token;
    const call = (t) => fetch(`${env.base}/api/me`, { headers: { authorization: `Bearer ${t}` } }).then((r) => r.status);
    // env.token (admin de départ) n'est pas utilisé ici : 6 requêtes au total pour cette IP.
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push(await call(ta));
    for (let i = 0; i < 3; i++) codes.push(await call(tb));
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 200]);
    assert.equal(await call(ta), 429);
    assert.equal(await call(tb), 429);
    const e = env.corvus.ctx.journal.list({ type: 'ratelimit' });
    assert.ok(e.some((x) => /global par IP/.test(x.detail)), e.map((x) => x.detail).join(' | '));
  });
});
