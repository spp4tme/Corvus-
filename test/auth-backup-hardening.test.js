// Authentification et sauvegardes : changement de mot de passe, mot de passe provisoire, fichiers de sauvegarde hostiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';
import { BackupService, parseHeader } from '../server/lib/backup.js';
import { Challenges } from '../server/lib/webauthn.js';

test('changer son mot de passe coupe les AUTRES sessions du compte, pas la courante', async () => {
  const env = await startCorvus();
  try {
    const u = makeUser(env.corvus, { username: 'multi', password: 'ancien-mot-de-passe-long', role: 'operator' });
    const a = new CorvusClient(env.base, { corvus: env.corvus, user: u });
    const b = new CorvusClient(env.base, { corvus: env.corvus, user: u });
    assert.equal((await a.login()).status, 200);
    assert.equal((await b.login()).status, 200);
    assert.equal((await b.api('GET', '/api/me')).status, 200);
    assert.equal((await a.api('POST', '/api/me/password', { current: 'ancien-mot-de-passe-long', next: 'nouveau-mot-de-passe-long' })).status, 200);
    assert.equal((await a.api('GET', '/api/me')).status, 200, 'la session qui a changé le mot de passe reste ouverte');
    assert.equal((await b.api('GET', '/api/me')).status, 401, 'l\'autre session (peut-être volée) est coupée');
  } finally { await env.close(); }
});

test('mot de passe provisoire : ni jeton d\'API ni passkey avant de l\'avoir changé', async () => {
  const env = await startCorvus();
  try {
    const t = makeUser(env.corvus, { username: 'temp', password: 'provisoire-12345', role: 'operator' });
    env.corvus.ctx.db.run('UPDATE users SET must_change_password = 1 WHERE id = ?', t.id);
    const c2 = new CorvusClient(env.base, { corvus: env.corvus, user: t });
    assert.equal((await c2.login()).status, 200);
    assert.equal((await c2.api('POST', '/api/me/tokens', { name: 'x' })).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await c2.api('POST', '/api/me/passkeys/options', {})).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await c2.api('GET', '/api/me')).status, 200, 'lire son profil reste permis');
    assert.equal((await c2.api('POST', '/api/me/password', { current: 'provisoire-12345', next: 'mot-de-passe-definitif' })).status, 200);
    assert.equal((await c2.api('POST', '/api/me/tokens', { name: 'x' })).status, 201);
  } finally { await env.close(); }
});

test('sauvegarde : un en-tête hostile est refusé proprement (400), jamais un plantage ou une allocation géante', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-bk-'));
  const svc = new BackupService({ db: {}, storage: { dir, backupDir: dir, blobDir: path.join(dir, 'b') }, config: { dataDir: dir }, journal: { add() {} } });
  const mk = (body) => { const f = path.join(dir, `x-${Math.random()}.cvbk`); fs.writeFileSync(f, body); return f; };
  const good = { v: 1, kdf: { alg: 'scrypt', salt: Buffer.alloc(16).toString('base64'), N: 2 ** 15, r: 8, p: 1 }, iv: Buffer.alloc(12).toString('base64') };
  try {
    const huge = { ...good, kdf: { ...good.kdf, N: 2 ** 30 } };
    for (const [label, body] of [
      ['N géant', `CVBK1\n${JSON.stringify(huge)}\n${'x'.repeat(40)}`],
      ['JSON invalide', `CVBK1\n{pas du json\n${'x'.repeat(40)}`],
      ['champs manquants', `CVBK1\n{"v":1}\n${'x'.repeat(40)}`],
      ['fichier minuscule', 'CVBK1\n'],
    ]) {
      const t0 = Date.now();
      await assert.rejects(svc.stage(mk(body), 'un-mot-de-passe-long', null), (e) => e.status === 400, label);
      assert.ok(Date.now() - t0 < 2000, `${label} : refus immédiat`);
    }
    assert.doesNotThrow(() => parseHeader(Buffer.from(`CVBK1\n${JSON.stringify(good)}\n`)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('défis WebAuthn : la mémoire est plafonnée même si /passkey/options est appelé en boucle', () => {
  const c = new Challenges();
  const first = c.issue({});
  for (let i = 0; i < 3000; i++) c.issue({});
  assert.ok(c.map.size <= 1000);
  assert.throws(() => c.take(first.id), 'les plus anciens sont évincés');
});
