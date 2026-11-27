// Jalon 1.2, étape 2 : plateforme et capacités des agents. L'interface masque/grise ce qu'un agent ne sait pas faire,
// le serveur refuse proprement (409 UNSUPPORTED) au lieu d'envoyer l'action. `platform` informe ; il ne décide JAMAIS d'un droit.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { startCorvus, waitFor, makeUser } from './helpers/corvus.js';
import { signedText } from '../server/lib/agents.js';
import { normalizePlatform, agentSupport, unsupportedReason, platformLabel, FEATURES, EXPERIMENTAL_PLATFORMS } from '../server/lib/agent-support.js';

const LINUX_FULL = {
  metrics: true, files: true, ransom: true, xray: true, isolation: true, preview: true, fanotify: true,
  actions: ['file.restore', 'file.remove', 'xray.live', 'proc.freeze', 'proc.thaw', 'proc.kill', 'net.status', 'net.isolate', 'net.release', 'preview.run', 'preview.apply'],
};
const WINDOWS_CAPS = { metrics: true, files: true, xray: true, ransom: false, isolation: false, preview: false, fanotify: false, fsnotify: true, actions: ['xray.live'] };

describe('plateforme : normalisation (unitaire)', () => {
  test('absente = linux ; casse et espaces tolérés ; tout le reste = unknown', () => {
    assert.equal(normalizePlatform(undefined), 'linux');
    assert.equal(normalizePlatform(null), 'linux');
    for (const [raw, want] of [['linux', 'linux'], ['Windows', 'windows'], [' MACOS ', 'macos'], ['freebsd', 'unknown'], ['', 'unknown'],
      ['windows; rm -rf /', 'unknown'], ['win\u0000dows', 'unknown'], ['x'.repeat(10_000), 'unknown'], [42, 'unknown'], [{}, 'unknown'], [['linux'], 'unknown'], [true, 'unknown']]) {
      assert.equal(normalizePlatform(raw), want, JSON.stringify(raw).slice(0, 40));
    }
  });

  test('étiquettes : macOS est expérimental, Linux et Windows non', () => {
    assert.deepEqual([...EXPERIMENTAL_PLATFORMS], ['macos']);
    assert.equal(platformLabel('windows'), 'Windows');
    assert.equal(platformLabel('unknown'), 'plateforme inconnue');
    assert.equal(platformLabel('<script>'), 'plateforme inconnue', 'une valeur arbitraire n\'est jamais affichée telle quelle');
  });
});

describe('fonctions disponibles (unitaire)', () => {
  test('agent Linux complet : tout est disponible', () => {
    const s = agentSupport('linux', LINUX_FULL);
    for (const f of FEATURES) assert.deepEqual(s[f], { ok: true, reason: null }, f);
  });

  test('agent Windows : restauration, isolement, ransomware, prévisualisation, gel indisponibles, avec une explication propre à Windows', () => {
    const s = agentSupport('windows', WINDOWS_CAPS);
    assert.equal(s.history.ok, true);
    assert.equal(s.xray.ok, true);
    for (const f of ['restore', 'procActions', 'isolation', 'ransom', 'preview', 'exactWriter']) {
      assert.equal(s[f].ok, false, f);
      assert.match(s[f].reason, /Windows|Linux/, f);
    }
    assert.match(s.exactWriter.reason, /fanotify/);
  });

  test('un agent Linux sans droits complets reçoit l\'explication générique (pas « Windows »)', () => {
    const s = agentSupport('linux', { ...LINUX_FULL, isolation: false, actions: LINUX_FULL.actions.filter((a) => !a.startsWith('net.')) });
    assert.equal(s.isolation.ok, false);
    assert.match(s.isolation.reason, /root|droits complets/);
    assert.equal(/Windows/.test(s.isolation.reason), false);
  });

  test('capacités absentes, nulles ou hostiles : tout est indisponible, jamais d\'exception', () => {
    for (const caps of [undefined, null, {}, [], 'x', 42, { files: 'true', actions: 'file.restore' }, { actions: [{ toString: 1 }] }]) {
      const s = agentSupport('linux', caps);
      for (const f of FEATURES) assert.equal(s[f].ok, false, `${JSON.stringify(caps)} ${f}`);
    }
  });

  test('la plateforme ne débloque rien : mêmes capacités, mêmes fonctions, quelle que soit la plateforme annoncée', () => {
    for (const p of ['linux', 'windows', 'macos', 'unknown']) {
      const s = agentSupport(p, LINUX_FULL);
      for (const f of FEATURES) assert.equal(s[f].ok, true, `${p} ${f}`);
      const w = agentSupport(p, WINDOWS_CAPS);
      assert.equal(w.isolation.ok, false, p);
    }
  });

  test('unsupportedReason : action annoncée → null ; non annoncée → raison ; liste absente → null (on laisse l\'agent trancher)', () => {
    assert.equal(unsupportedReason('windows', WINDOWS_CAPS, 'xray.live'), null);
    assert.match(unsupportedReason('windows', WINDOWS_CAPS, 'net.isolate'), /nftables/);
    assert.match(unsupportedReason('linux', { actions: [] }, 'inconnue.action'), /pas proposée/);
    assert.equal(unsupportedReason('linux', {}, 'net.isolate'), null);
    assert.equal(unsupportedReason('linux', undefined, 'net.isolate'), null);
  });
});

describe('plateforme et capacités : serveur réel', () => {
  let env; let adminTok; let viewerTok; let viewer; const hosts = {};
  const api = (method, url, tok, body) => fetch(env.base + url, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const hostInfo = async (id) => (await api('GET', '/api/hosts', adminTok)).body.hosts.find((h) => h.id === id);

  const newKey = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, publicB64: spki.subarray(spki.length - 32).toString('base64') };
  };

  /** Enrôle un agent sur l'hôte puis le connecte et envoie hello_agent ; renvoie le client. */
  async function bringOnline(hostId, { platform, capabilities, enrollPlatform }) {
    const key = newKey();
    const t = (await api('POST', '/api/agents/enrollments', adminTok, { hostId })).body;
    const e = await (await fetch(`${env.base}/api/agent/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: t.token, publicKey: key.publicB64, version: '1.2.0', hostname: 'h', capabilities, ...(enrollPlatform !== undefined ? { platform: enrollPlatform } : {}) }),
    })).json();
    const ws = new WebSocket(`${env.base.replace('http', 'ws')}/agent`);
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    const send = (type, body = {}) => ws.send(JSON.stringify({ v: 1, id: crypto.randomUUID(), type, ts: Date.now(), body }));
    const hello = await waitFor(() => inbox.find((m) => m.type === 'hello'), 5000);
    send('auth', { agentId: e.agentId, signature: crypto.sign(null, signedText('agent', hello.body.challenge), key.privateKey).toString('base64'), challenge: crypto.randomBytes(32).toString('base64') });
    await waitFor(() => inbox.find((m) => m.type === 'auth_ok'), 5000);
    send('hello_agent', { version: '1.2.0', capabilities, ...(platform !== undefined ? { platform } : {}) });
    await waitFor(async () => (await hostInfo(hostId))?.agent?.online === true, 5000);
    return { ws, inbox, send, agentId: e.agentId };
  }

  before(async () => {
    env = await startCorvus();
    adminTok = env.token;
    viewer = makeUser(env.corvus, { username: 'lecteur', password: 'Un-mot-de-passe-solide-9', role: 'viewer' });
    viewerTok = env.corvus.ctx.users.createToken(viewer.id, 't').token;
    for (const n of ['linux', 'vieux', 'windows', 'macos', 'hostile']) {
      hosts[n] = (await api('POST', '/api/hosts', adminTok, { name: n, hostname: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' })).body.host.id;
    }
  });
  after(() => env?.close());

  test('agent sans « platform » (1.0/1.1) : traité comme linux, protocole inchangé', async () => {
    const a = await bringOnline(hosts.vieux, { platform: undefined, capabilities: LINUX_FULL });
    const ag = (await hostInfo(hosts.vieux)).agent;
    assert.equal(ag.platform, 'linux');
    assert.equal(ag.experimental, false);
    assert.equal(ag.support.isolation.ok, true);
    a.ws.close();
  });

  test('agent Windows : plateforme, fonctions grisées avec explication, jamais « expérimental »', async () => {
    const a = await bringOnline(hosts.windows, { platform: 'windows', capabilities: WINDOWS_CAPS, enrollPlatform: 'windows' });
    const ag = (await hostInfo(hosts.windows)).agent;
    assert.deepEqual([ag.platform, ag.platformLabel, ag.experimental], ['windows', 'Windows', false]);
    assert.equal(ag.support.history.ok, true);
    assert.equal(ag.support.restore.ok, false);
    assert.match(ag.support.isolation.reason, /nftables/);
    assert.equal((await api('GET', '/api/agents', adminTok)).body.agents.find((x) => x.id === a.agentId).platform, 'windows', 'enrôlement + hello_agent');
    a.ws.close();
  });

  test('agent macOS : expérimental', async () => {
    const a = await bringOnline(hosts.macos, { platform: 'macos', capabilities: WINDOWS_CAPS });
    const ag = (await hostInfo(hosts.macos)).agent;
    assert.deepEqual([ag.platform, ag.experimental], ['macos', true]);
    a.ws.close();
  });

  test('plateforme hostile : devient « unknown », jamais reflétée telle quelle', async () => {
    const evil = '<img src=x onerror=alert(1)>'.repeat(50);
    const a = await bringOnline(hosts.hostile, { platform: evil, capabilities: WINDOWS_CAPS, enrollPlatform: evil });
    const ag = (await hostInfo(hosts.hostile)).agent;
    assert.deepEqual([ag.platform, ag.platformLabel], ['unknown', 'plateforme inconnue']);
    assert.equal(JSON.stringify(ag).includes('onerror'), false);
    assert.equal(env.corvus.ctx.db.get('SELECT platform FROM agents WHERE id = ?', a.agentId).platform, 'unknown');
    a.ws.close();
  });

  test('action non annoncée : 409 UNSUPPORTED avec explication, rien n\'est envoyé à l\'agent', async () => {
    const a = await bringOnline(hosts.linux, { platform: 'windows', capabilities: WINDOWS_CAPS });
    const before = a.inbox.length;
    const r = await api('POST', `/api/hosts/${hosts.linux}/isolation`, adminTok, { action: 'isolate', ttlSec: 900, confirm: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'UNSUPPORTED');
    assert.match(r.body.error.message, /nftables/);
    const st = await api('GET', `/api/hosts/${hosts.linux}/isolation`, adminTok);
    assert.equal(st.status, 409);
    const x = await api('POST', `/api/hosts/${hosts.linux}/xray/proc`, adminTok, { pid: 4242, start: 1, action: 'kill', confirm: true });
    assert.equal(x.status, 409);
    assert.equal(a.inbox.slice(before).some((m) => m.type === 'action'), false, 'aucune action transmise');
    a.ws.close();
  });

  test('la plateforme annoncée ne change aucun droit : un lecteur reste refusé (403), hôte non accordé = 404', async () => {
    // Windows ou Linux, peu importe : les rôles décident, pas `platform`. Le refus de rôle précède tout contrôle de capacités.
    const isolate = (h) => api('POST', `/api/hosts/${h}/isolation`, viewerTok, { action: 'isolate', ttlSec: 900, confirm: true }).then((r) => r.status);
    assert.equal(await isolate(hosts.windows), 404, 'hôte non accordé = 404, jamais 403');
    env.corvus.ctx.users.setGrants(viewer.id, [{ scope: 'host', target: hosts.windows, role: 'viewer' }]);
    assert.equal(await isolate(hosts.windows), 403, 'hôte accordé en lecture : refus de rôle');
    assert.equal(await isolate(hosts.vieux), 404, 'les autres hôtes restent invisibles');
    assert.equal((await api('GET', '/api/agents', viewerTok)).status, 403, 'liste des agents : administrateurs seulement');
    assert.equal((await api('GET', '/api/agents')).status, 401, 'sans compte');
  });
});
