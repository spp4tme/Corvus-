// Durcissement transverse : HSTS uniquement en https, en-têtes de sécurité toujours présents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCorvus } from './helpers/corvus.js';

test('HSTS n\'est envoyé que pour une requête https (proxy de confiance)', async () => {
  const env = await startCorvus();
  try {
    const plain = await fetch(`${env.base}/api/health`);
    assert.equal(plain.headers.get('strict-transport-security'), null);
    assert.equal(plain.headers.get('x-content-type-options'), 'nosniff');
    const tls = await fetch(`${env.base}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(tls.headers.get('strict-transport-security') || '', /max-age=\d{7,}/);
  } finally { await env.close(); }
});
