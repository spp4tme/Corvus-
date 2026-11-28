// Hôte « agent seul » (authType « none ») : une machine supervisée UNIQUEMENT par l'agent, sans aucun accès SSH
// (ni utilisateur, ni mot de passe, ni clé). Garanties testées : validation, aucun secret SSH, aucune connexion sortante
// (ni test, ni terminal, ni SFTP, ni sonde de disponibilité), droits (admin seulement), enrôlement de l'agent possible.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';

describe('hôte « agent seul »', () => {
  let env; let c; let listener; let connexions;
  before(async () => {
    env = await startCorvus();
    c = env.client;
    assert.equal((await c.login()).status, 200);
    connexions = 0;
    // Faux « port SSH » : toute connexion sortante de Corvus vers l'hôte agent seul serait comptée.
    listener = net.createServer((s) => { connexions += 1; s.destroy(); });
    await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  });
  after(async () => { listener?.close(); await env?.close(); });

  const creer = (extra = {}) => c.api('POST', '/api/hosts', { name: 'PC Windows', authType: 'none', ...extra });

  test('création : alias et agent seul suffisent, sans utilisateur, mot de passe ni adresse', async () => {
    const r = await creer();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.host.authType, 'none');
    assert.equal(r.body.host.username, '');
    assert.equal(r.body.host.hostname, '');
    assert.deepEqual([r.body.host.hasPassword, r.body.host.hasKey, r.body.host.hasPassphrase], [false, false, false]);
    assert.ok(!env.corvus.ctx.vault.get(r.body.host.id), 'rien dans le coffre');
  });

  test('l\'alias est obligatoire (sans adresse, il est le seul nom de l\'hôte) ; adresse facultative mais validée', async () => {
    assert.equal((await c.api('POST', '/api/hosts', { authType: 'none' })).status, 400);
    assert.equal((await c.api('POST', '/api/hosts', { name: '   ', authType: 'none' })).status, 400);
    assert.equal((await creer({ hostname: '100.64.0.9' })).status, 201);
    for (const bad of ['a b', 'x\u0000y', 'h\nost', 'a'.repeat(300), '-oProxyCommand=x', 'ho;st']) {
      assert.equal((await creer({ hostname: bad })).status, 400, JSON.stringify(bad));
    }
  });

  test('aucun secret SSH n\'est accepté ni stocké pour un hôte agent seul', async () => {
    for (const secret of [{ password: 'x' }, { privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----' }, { passphrase: 'x' }]) {
      const r = await creer(secret);
      assert.equal(r.status, 400, JSON.stringify(secret).slice(0, 40));
    }
    // Un champ vide (formulaire resté vide) n'est pas un secret.
    assert.equal((await creer({ password: '', passphrase: '', privateKey: '' })).status, 201);
  });

  test('régression : un hôte SSH ordinaire exige toujours adresse et utilisateur', async () => {
    assert.equal((await c.api('POST', '/api/hosts', { name: 'x', authType: 'password', password: 'p', username: 'u' })).status, 400, 'sans adresse');
    assert.equal((await c.api('POST', '/api/hosts', { name: 'x', authType: 'password', password: 'p', hostname: '10.0.0.1' })).status, 400, 'sans utilisateur');
    assert.equal((await c.api('POST', '/api/hosts', { name: 'x', authType: 'bidon', hostname: '10.0.0.1', username: 'u' })).status, 400, 'méthode inconnue');
  });

  test('aucune connexion sortante : ni test, ni SFTP, ni supervision, ni terminal, ni sonde de disponibilité', async () => {
    const r = await creer({ hostname: '127.0.0.1', port: listener.address().port });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.host.id;
    const refus = async (method, url, body) => {
      const x = await c.api(method, url, body);
      assert.equal(x.status, 409, `${method} ${url} : ${JSON.stringify(x.body).slice(0, 160)}`);
      assert.equal(x.body.error.code, 'AGENT_ONLY', `${method} ${url}`);
      assert.match(x.body.error.message, /agent seul/i);
    };
    await refus('POST', `/api/hosts/${id}/test`);
    await refus('GET', `/api/hosts/${id}/fs/list?path=${encodeURIComponent('~')}`);
    await refus('GET', `/api/hosts/${id}/monitor/stats`);
    await refus('GET', `/api/hosts/${id}/docker/containers`);
    await refus('POST', '/api/hosts/test', { name: 'brouillon', authType: 'none', hostname: '127.0.0.1', port: listener.address().port });
    await assert.rejects(env.corvus.ctx.terminals.create(id, {}), (e) => e.code === 'AGENT_ONLY' && e.status === 409);
    // Sonde de disponibilité : ignorée (un hôte sans adresse ne doit jamais être « injoignable »), donc aucune alerte.
    const avant = env.corvus.ctx.db.all("SELECT 1 FROM alerts WHERE kind = 'host-down'").length;
    await env.corvus.ctx.hostStatus.check(env.corvus.ctx.hosts.find(id));
    await env.corvus.ctx.hostStatus.tick();
    assert.equal(env.corvus.ctx.db.all("SELECT 1 FROM alerts WHERE kind = 'host-down'").length, avant);
    assert.equal(env.corvus.ctx.hostStatus.get(id), null, 'pas d\'état « injoignable » inventé');
    assert.equal(connexions, 0, `${connexions} connexion(s) sortante(s) vers l'hôte agent seul`);
  });

  test('l\'agent peut s\'enrôler sur un hôte agent seul', async () => {
    const id = (await creer()).body.host.id;
    const t = await c.api('POST', '/api/agents/enrollments', { hostId: id });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.ok(t.body.token);
  });

  test('changer de méthode : vers « aucune » efface les secrets ; en sortir exige utilisateur et adresse', async () => {
    const h = await c.api('POST', '/api/hosts', { name: 'bascule', authType: 'password', hostname: '10.0.0.5', username: 'u', password: 'secret' });
    assert.equal(h.status, 201);
    const id = h.body.host.id;
    assert.equal(h.body.host.hasPassword, true);
    // Effacer des secrets est irréversible : confirmation explicite exigée côté serveur, secrets intacts sans elle.
    const sans = await c.api('PATCH', `/api/hosts/${id}`, { authType: 'none' });
    assert.equal(sans.status, 400, JSON.stringify(sans.body));
    assert.equal(sans.body.error.code, 'CONFIRM_REQUIRED');
    assert.equal(env.corvus.ctx.vault.get(id).password, 'secret', 'secret intact sans confirmation');
    assert.equal(env.corvus.ctx.hosts.find(id).authType, 'password', 'hôte inchangé sans confirmation');
    for (const bad of ['oui', 1, 'true', {}]) assert.equal((await c.api('PATCH', `/api/hosts/${id}`, { authType: 'none', confirm: bad })).status, 400, JSON.stringify(bad));
    // Un compte trop faible ne peut pas non plus le faire (même avec confirm).
    const op = makeUser(env.corvus, { username: 'op-bascule', password: 'mot-de-passe-op-bascule', role: 'operator' });
    const copr = new CorvusClient(env.base, { corvus: env.corvus, user: op });
    assert.equal((await copr.login()).status, 200);
    for (const url of [`/api/hosts/${id}`, `/api/Hosts/${id}`, `/api/hosts/${id}/`]) {
      const r = await copr.api('PATCH', url, { authType: 'none', confirm: true });
      assert.ok([403, 404].includes(r.status), `${url} → ${r.status}`);
    }
    assert.equal(env.corvus.ctx.vault.get(id).password, 'secret', 'secret intact après les tentatives refusées');
    const none = await c.api('PATCH', `/api/hosts/${id}`, { authType: 'none', confirm: true });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.deepEqual([none.body.host.authType, none.body.host.hasPassword], ['none', false]);
    assert.deepEqual(env.corvus.ctx.vault.get(id) || {}, {}, 'secret effacé du coffre');
    // Retour à un hôte SSH sans fournir d'utilisateur : refusé.
    const e = await creer();
    const nid = e.body.host.id;
    assert.equal((await c.api('PATCH', `/api/hosts/${nid}`, { authType: 'password', password: 'p' })).status, 400);
    assert.equal((await c.api('PATCH', `/api/hosts/${nid}`, { authType: 'password', password: 'p', username: 'u' })).status, 400, 'adresse manquante');
    const ok = await c.api('PATCH', `/api/hosts/${nid}`, { authType: 'password', password: 'p', username: 'u', hostname: '10.0.0.6' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.host.authType, ok.body.host.hasPassword], ['password', true]);
  });

  test('droits : seul un administrateur crée un hôte agent seul', async () => {
    for (const role of ['operator', 'viewer']) {
      const u = makeUser(env.corvus, { username: `u-${role}`, password: `mot-de-passe-${role}-test`, role });
      const cl = new CorvusClient(env.base, { corvus: env.corvus, user: u });
      assert.equal((await cl.login()).status, 200);
      for (const url of ['/api/hosts', '/api/Hosts', '/api/hosts/', '/api//hosts']) {
        const r = await cl.api('POST', url, { name: `par-${role}`, authType: 'none' });
        assert.ok([403, 404].includes(r.status), `${role} ${url} → ${r.status}`);
      }
    }
    const noms = env.corvus.ctx.hosts.hosts.map((x) => x.name);
    assert.ok(!noms.some((n) => n.startsWith('par-')), 'aucun hôte créé par un compte trop faible');
  });

  test('journal : la création est tracée sans « () » ni secret', async () => {
    const id = (await creer({ name: 'tracé' })).body.host.id;
    const lignes = env.corvus.ctx.db.all("SELECT host_label FROM audit WHERE host_id = ?", id);
    assert.ok(lignes.length >= 1);
    for (const l of lignes) assert.ok(!/\(\)|@/.test(l.host_label), l.host_label);
  });
});
