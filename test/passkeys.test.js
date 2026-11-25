// Passkeys (WebAuthn) : un authentificateur logiciel (clé ES256 générée ici) joue le rôle du
// téléphone / de la clé de sécurité, pour tester l'enregistrement puis la connexion de bout en bout.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startCorvus, CorvusClient } from './helpers/corvus.js';
import { cborDecode, coseToJwk, verifySignature } from '../server/lib/webauthn.js';

const b64u = (b) => Buffer.from(b).toString('base64url');

// Encodeur CBOR minimal (entiers, octets, texte, tables) pour fabriquer les réponses.
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('type non géré');
}

function softAuthenticator(origin) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  const rpId = new URL(origin).hostname;
  let counter = 0;
  const authData = (flags, extra = Buffer.alloc(0)) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
    return Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), c, extra]);
  };
  return {
    create(challenge) {
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const ad = authData(0x45, Buffer.concat([Buffer.alloc(16), len, credId, cose]));
      return {
        id: b64u(credId), type: 'public-key',
        response: {
          clientDataJSON: b64u(JSON.stringify({ type: 'webauthn.create', challenge, origin })),
          attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]))),
        },
      };
    },
    get(challenge, { flags = 0x05, tamper = false } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const ad = authData(flags);
      const sig = crypto.sign('sha256', Buffer.concat([ad, crypto.createHash('sha256').update(clientDataJSON).digest()]), privateKey);
      if (tamper) sig[sig.length - 1] ^= 1;
      return { id: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(ad), signature: b64u(sig) } };
    },
  };
}

describe('passkeys (WebAuthn)', () => {
  let env;
  let auth;
  before(async () => {
    env = await startCorvus();
    await env.client.login();
    auth = softAuthenticator(env.base);
  });
  after(() => env.close());

  test('CBOR et clés COSE : décodage et vérification de signature', () => {
    const [m] = cborDecode(cbor(new Map([['a', 1], [-2, Buffer.from([1, 2])]])));
    assert.equal(m.a, 1);
    assert.deepEqual([...m['-2']], [1, 2]);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'jwk' });
    const k = coseToJwk({ 1: 1, '-1': 6, '-2': Buffer.from(raw.x, 'base64url') });
    const data = Buffer.from('message');
    assert.equal(verifySignature(k, data, crypto.sign(null, data, privateKey)), true);
  });

  test('enregistrement depuis « Mon compte », puis connexion sans mot de passe', async () => {
    const c = env.client;
    const opt = await c.api('POST', '/api/me/passkeys/options');
    assert.equal(opt.status, 200, JSON.stringify(opt.body));
    assert.equal(opt.body.publicKey.authenticatorSelection.userVerification, 'required');
    const reg = await c.api('POST', '/api/me/passkeys', { challengeId: opt.body.challengeId, name: 'Téléphone', credential: auth.create(opt.body.publicKey.challenge) });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal((await c.api('GET', '/api/me/passkeys')).body.passkeys.length, 1);

    const anon = new CorvusClient(env.base, {});
    const lo = await anon.api('POST', '/api/auth/passkey/options');
    const res = await fetch(`${env.base}/api/auth/passkey/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: env.base },
      body: JSON.stringify({ challengeId: lo.body.challengeId, credential: auth.get(lo.body.publicKey.challenge) }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    anon.cookie = res.headers.get('set-cookie').split(';')[0];
    assert.equal((await anon.api('GET', '/api/me')).body.user.username, 'admin');
  });

  test('refus : défi rejoué, signature falsifiée, utilisateur non vérifié', async () => {
    const anon = new CorvusClient(env.base, {});
    const lo = await anon.api('POST', '/api/auth/passkey/options');
    const cred = auth.get(lo.body.publicKey.challenge);
    const send = (body) => anon.api('POST', '/api/auth/passkey/login', body);
    assert.equal((await send({ challengeId: lo.body.challengeId, credential: cred })).status, 200);
    assert.equal((await send({ challengeId: lo.body.challengeId, credential: cred })).status, 400, 'défi à usage unique');
    const lo2 = await anon.api('POST', '/api/auth/passkey/options');
    assert.equal((await send({ challengeId: lo2.body.challengeId, credential: auth.get(lo2.body.publicKey.challenge, { tamper: true }) })).status, 401);
    const lo3 = await anon.api('POST', '/api/auth/passkey/options');
    const r3 = await send({ challengeId: lo3.body.challengeId, credential: auth.get(lo3.body.publicKey.challenge, { flags: 0x01 }) });
    assert.equal(r3.status, 401);
    assert.match(r3.body.error.message, /vérification/);
  });
});
