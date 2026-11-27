// Étape 5 — « Partager vers Corvus » : manifeste (share_target), stockage temporaire du service worker (isolé, borné,
// propre au compte), repli serveur, et envoi par jeton personnel (Raccourci Apple pour iPhone).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus, makeUser } from './helpers/corvus.js';

const read = (rel) => fs.readFileSync(new URL(`../public/${rel}`, import.meta.url), 'utf8');

/** Faux `caches` : mêmes méthodes que l'API du navigateur (clés = adresses, `keys()` renvoie des objets avec `url`). */
function fakeCaches() {
  const stores = new Map();
  const norm = (k) => new URL(typeof k === 'string' ? k : k.url, 'https://corvus.test').href;
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async put(k, res) { m.set(norm(k), new Response(await res.arrayBuffer(), { headers: res.headers })); },
        async match(k) { const r = m.get(norm(k)); return r ? r.clone() : undefined; },
        async keys() { return [...m.keys()].map((url) => ({ url })); },
        async delete(k) { return m.delete(norm(k)); },
      };
    },
  };
}
const lib = () => {
  const ctx = vm.createContext({ Response, Blob, URL, crypto, Uint8Array, JSON, Date, Number, String, Math, Array, Promise });
  vm.runInContext(read('sw-share.js'), ctx);
  return vm.runInContext('CorvusShare', ctx);
};
// Les objets viennent d'un autre « realm » (machine virtuelle) : on les ramène à du JSON pur avant de les comparer.
const plain = (x) => JSON.parse(JSON.stringify(x));
const form = (entries) => { const f = new FormData(); for (const [k, v] of entries) f.append(k, v); return f; };
const file = (name, content = 'contenu', type = 'text/plain') => new File([content], name, { type });

describe('manifeste', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  test('share_target : POST multipart vers /share-target, fichiers acceptés, dans la portée', () => {
    assert.equal(m.share_target.action, '/share-target');
    assert.equal(m.share_target.method, 'POST');
    assert.equal(m.share_target.enctype, 'multipart/form-data');
    assert.deepEqual(m.share_target.params.files, [{ name: 'files', accept: ['*/*'] }]);
    assert.ok(['title', 'text', 'url'].every((k) => typeof m.share_target.params[k] === 'string'));
    assert.ok(m.share_target.action.startsWith(m.scope), 'l\'action est dans la portée de l\'application');
    assert.equal(m.start_url, '/#/hosts');
    assert.ok(m.icons.some((i) => i.sizes === '512x512'));
  });
});

describe('stockage temporaire (service worker)', () => {
  const S = lib();

  test('un partage : stocké, listé, relu ; noms assainis', async () => {
    const caches = fakeCaches();
    const st = S.create({ caches });
    const meta = await st.store(form([['files', file('../../etc/passwd', 'x')], ['files', file('C:\\Users\\moi\\photo.jpg', 'jpeg')], ['files', file('..', 'y')], ['files', file('a\u0000b\nc.txt', 'z')]]), 'u1');
    assert.deepEqual(plain(meta.files.map((f) => f.name)), ['passwd', 'photo.jpg', 'fichier-3', 'abc.txt']);
    assert.match(meta.id, /^sh[0-9a-f]{16}$/);
    const list = await st.list('u1');
    assert.equal(list.length, 1);
    const f = await st.blob(meta.id, 1, 'u1');
    assert.equal(await f.blob.text(), 'jpeg');
    assert.equal(S.safeName('x'.repeat(500), 'f').length, 200);
  });

  test('isolation entre comptes : un autre compte ne voit, ne lit et ne supprime rien', async () => {
    const st = S.create({ caches: fakeCaches() });
    const a = await st.store(form([['files', file('secret-de-alice.txt', 'tres secret')]]), 'alice');
    assert.deepEqual(plain(await st.list('bob')), []);
    assert.equal(await st.blob(a.id, 0, 'bob'), null);
    assert.equal(await st.remove(a.id, 'bob'), false);
    assert.equal((await st.list('alice')).length, 1, 'toujours là pour son propriétaire');
    assert.equal(await st.blob('../x', 0, 'alice'), null);
    assert.equal(await st.blob(a.id, -1, 'alice'), null);
    assert.equal(await st.blob(a.id, 5, 'alice'), null);
    assert.equal(await st.remove(a.id, 'alice'), true);
    assert.deepEqual(plain(await st.list('alice')), []);
  });

  test('nettoyage : expiration à 30 min, suppression totale (déconnexion), aucune clé résiduelle', async () => {
    let t = 1_000_000;
    const caches = fakeCaches();
    const st = S.create({ caches, now: () => t });
    await st.store(form([['files', file('vieux.txt')]]), 'u');
    t += S.MAX_AGE_MS + 1;
    await st.store(form([['files', file('neuf.txt')]]), 'u');
    const list = await st.list('u');
    assert.deepEqual(plain(list.map((x) => x.files[0].name)), ['neuf.txt'], 'le périmé a été purgé');
    await st.purge({ all: true });
    assert.deepEqual(plain(await st.list('u')), []);
    assert.equal([...caches.stores.get(S.CACHE).keys()].length, 0, 'plus aucune entrée dans le cache');
  });

  test('bornes : connexion requise, rien à partager, 20 fichiers, 200 Mo, texte seul', async () => {
    const st = S.create({ caches: fakeCaches() });
    await assert.rejects(st.store(form([['files', file('a')]]), ''), /Connexion requise/);
    await assert.rejects(st.store(form([]), 'u'), /Rien à partager/);
    await assert.rejects(st.store(form(Array.from({ length: 21 }, (_, i) => ['files', file(`f${i}`)])), 'u'), /Plus de 20 fichiers/);
    const fake = { name: 'gros', size: 150 * 1024 * 1024, type: 'x' };
    const f = { getAll: () => [fake, fake], get: () => '' };
    await assert.rejects(st.store(f, 'u'), /trop volumineux/);
    const t = await st.store(form([['text', 'bonjour'], ['url', 'https://exemple.test'], ['title', 'Titre']]), 'u');
    assert.equal(t.files[0].name, 'partage.txt');
    assert.equal(await (await st.blob(t.id, 0, 'u')).blob.text(), 'Titre\nbonjour\nhttps://exemple.test');
  });

  test('sw.js : n\'intercepte que POST /share-target, vérifie la session, ne contacte aucun autre serveur', () => {
    const sw = read('sw.js');
    assert.match(sw, /req\.method === 'POST' && url\.origin === self\.location\.origin && url\.pathname === '\/share-target'/);
    assert.match(sw, /fetch\('\/api\/me'/);
    assert.match(sw, /, 303\)/);
    assert.ok(!/fetch\('https?:/.test(sw), 'aucune requête vers un autre serveur');
    assert.ok(!/\/fs\/upload/.test(sw), 'le service worker n\'envoie rien : l\'envoi se fait dans l\'écran, après le choix');
  });
});

describe('serveur : repli et envoi par jeton (Raccourci iPhone)', () => {
  let env; let sshd; const ids = {};
  before(async () => {
    sshd = await startFakeSshd();
    env = await startCorvus();
    await env.client.login();
    const r = await env.client.api('POST', '/api/hosts', { name: 'pi', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
    ids.pi = r.body.host.id;
    ids.autre = (await env.client.api('POST', '/api/hosts', { name: 'autre', hostname: 'autre.example', username: 'pi', password: 'x' })).body.host.id;
  });
  after(async () => { await env?.close(); await sshd?.close(); });

  test('POST /share-target sans service worker : redirection 303, rien de lu ni de gardé, sans authentification', async () => {
    const r = await fetch(`${env.base}/share-target`, { method: 'POST', redirect: 'manual', body: form([['files', file('x.txt', 'a'.repeat(1000))]]) });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/#/share?unavailable=1');
    assert.equal((await fetch(`${env.base}/share-target`)).status, 404, 'GET : rien');
  });

  test('envoi par jeton personnel : écrit sur l\'hôte, journalisé, jamais d\'écrasement', async () => {
    const url = (n, extra = '') => `${env.base}/api/hosts/${ids.pi}/fs/upload?dir=~&name=${encodeURIComponent(n)}${extra}`;
    const h = { authorization: `Bearer ${env.token}`, 'content-type': 'application/octet-stream' };
    const r = await fetch(url('IMG_0001.jpg'), { method: 'POST', headers: h, body: Buffer.from('photo-de-test') });
    assert.equal(r.status, 201, await r.text());
    assert.equal(fs.readFileSync(`${sshd.root}/IMG_0001.jpg`, 'utf8'), 'photo-de-test');
    assert.equal((await fetch(url('IMG_0001.jpg'), { method: 'POST', headers: h, body: 'autre' })).status, 409, 'pas d\'écrasement');
    const j = await env.client.api('GET', '/api/journal?type=sftp');
    assert.ok(j.body.entries.some((e) => e.event === 'upload' && /IMG_0001/.test(e.detail)));
    for (const bad of ['../evil', 'a/b', '..', '']) assert.equal((await fetch(url(bad), { method: 'POST', headers: h, body: 'x' })).status, 400, `nom ${bad}`);
  });

  test('droits du jeton : lecteur refusé, hôte non accordé = 404, taille limitée', async () => {
    const { users, config } = env.corvus.ctx;
    const ro = makeUser(env.corvus, { username: 'lecteur', password: 'mot-de-passe-lecteur', role: 'viewer' });
    users.setGrants(ro.id, [{ scope: 'host', target: ids.pi, role: 'viewer' }]);
    const op = makeUser(env.corvus, { username: 'ops', password: 'mot-de-passe-operateur', role: 'operator' });
    users.setGrants(op.id, [{ scope: 'host', target: ids.pi, role: 'operator' }]);
    const post = (token, host, n, body = 'x') => fetch(`${env.base}/api/hosts/${host}/fs/upload?dir=~&name=${n}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body });
    const tRo = users.createToken(ro.id, 'iphone').token;
    const tOp = users.createToken(op.id, 'iphone').token;
    assert.equal((await post(tRo, ids.pi, 'ro.txt')).status, 403, 'lecture seule : refusé');
    assert.equal((await post(tOp, ids.autre, 'op.txt')).status, 404, 'hôte non accordé : introuvable');
    assert.equal((await post(tOp, 'abcdefabcdef', 'op.txt')).status, 404, 'même réponse pour un hôte inexistant');
    assert.equal((await post(tOp, ids.pi, 'op.txt')).status, 201);
    config.maxUploadBytes = 1024;
    assert.equal((await post(tOp, ids.pi, 'gros.bin', Buffer.alloc(4096))).status, 413);
    assert.ok(!fs.existsSync(`${sshd.root}/gros.bin`), 'aucun fichier partiel');
    assert.deepEqual(fs.readdirSync(sshd.root).filter((n) => n.endsWith('.part')), []);
    // Un jeton révoqué ne sert plus
    const revoked = users.createToken(op.id, 'perdu');
    users.revokeToken?.(op.id, revoked.id);
    if (users.revokeToken) assert.equal((await post(revoked.token, ids.pi, 'apres.txt')).status, 401);
    // Variantes de casse / « / » final : mêmes contrôles
    for (const u of [`/api/Hosts/${ids.pi}/FS/Upload`, `/api/hosts/${ids.pi}/fs/upload/`]) {
      const r = await fetch(`${env.base}${u}?dir=~&name=casse.txt`, { method: 'POST', headers: { authorization: `Bearer ${tRo}`, 'content-type': 'application/octet-stream' }, body: 'x' });
      assert.equal(r.status, 403, u);
    }
    config.maxUploadBytes = 1024 * 1024 * 1024;
  });
});
