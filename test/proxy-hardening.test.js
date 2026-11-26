// Proxy web : un lien d'accès a une durée de vie absolue ; les jetons Corvus (cv_ et cvu_) ne partent jamais vers un service tiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ProxyService } from '../server/lib/proxy.js';

const svc = { id: 'abc', name: 'test', url: 'http://127.0.0.1:1' };
const make = () => {
  const p = new ProxyService({ db: {}, journal: { add() {} }, config: {} });
  p.list = () => [svc];
  p.checkTarget = async () => '127.0.0.1';
  return p;
};

test('lien de proxy : l\'expiration glissante ne dépasse jamais 24 h', async () => {
  const p = make();
  const real = Date.now;
  const t0 = real();
  try {
    const { url } = await p.open('abc');
    const cap = url.split('/')[2];
    Date.now = () => t0 + 11 * 3600_000;
    assert.ok(p.resolveCap(cap), 'valide à 11 h (et prolongé)');
    Date.now = () => t0 + 22 * 3600_000;
    assert.ok(p.resolveCap(cap), 'valide à 22 h (prolongé encore)');
    Date.now = () => t0 + 25 * 3600_000;
    assert.equal(p.resolveCap(cap), null, 'expiré à 25 h malgré l\'activité');
  } finally { Date.now = real; }
});

test('les jetons d\'API Corvus (cv_ / cvu_) ne sont pas transmis au service amont', async () => {
  const seen = [];
  const up = http.createServer((req, res) => { seen.push(req.headers.authorization || null); res.end('ok'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const p = make();
  svc.url = `http://127.0.0.1:${up.address().port}`;
  const handler = p.handler();
  const { url } = await p.open('abc');
  const cap = url.split('/')[2];
  const front = http.createServer((req, res) => { req.params = { cap }; req.url = '/'; req.protocol = 'http'; handler(req, res); });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  try {
    for (const auth of ['Bearer cvu_secret', 'Bearer cv_secret', 'Bearer autre-jeton']) {
      await (await fetch(`http://127.0.0.1:${front.address().port}/`, { headers: { authorization: auth } })).text();
    }
    assert.deepEqual(seen, [null, null, 'Bearer autre-jeton']);
  } finally { front.close(); up.close(); }
});
