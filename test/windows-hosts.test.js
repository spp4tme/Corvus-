// Jalon 1.2, étape 8 : hôtes Windows (OpenSSH Server) côté SSH. Corvus construit ses commandes pour un shell POSIX ; sur un
// hôte Windows elles sont DÉSACTIVÉES (409 POSIX_ONLY), jamais envoyées. Terminal et SFTP restent disponibles.
//
// HONNÊTETÉ : l'hôte « Windows » de ces tests est une SIMULATION de cmd.exe branchée sur le faux sshd (test/helpers/fake-sshd.js,
// option windowsLike) : elle prouve la logique de détection et de refus, PAS le comportement d'un vrai OpenSSH Server pour
// Windows (SFTP, terminal, chemins « /C:/Users/… »), à valider sur une vraie machine.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';
import { classifyOs, effectiveOs, OS_PROBE } from '../server/lib/hostos.js';

describe('détection du système (unitaire)', () => {
  test('cmd.exe, PowerShell, sh : trois sorties, trois réponses justes', () => {
    assert.equal(classifyOs('corvus-os:Windows_NT:$env:OS\r\n'), 'windows', 'cmd.exe');
    assert.equal(classifyOs('corvus-os:%OS%:Windows_NT\r\n'), 'windows', 'PowerShell');
    assert.equal(classifyOs('corvus-os:%OS%::OS\n'), 'posix', 'sh, bash, zsh, fish (Cygwin/MSYS compris : shell POSIX)');
    assert.equal(classifyOs(Buffer.from('corvus-os:%OS%::OS\n')), 'posix');
  });

  test('sortie inexploitable : on ne conclut rien (null), jamais une supposition', () => {
    for (const out of ['', undefined, null, 'Microsoft Windows [version 10.0]', "'echo' n'est pas reconnu", 'x'.repeat(10_000), '\u0000\u0000']) {
      assert.equal(classifyOs(out), null, String(out).slice(0, 30));
    }
    // Le marqueur au-delà des 4 premiers Ko est ignoré (sortie bornée).
    assert.equal(classifyOs(`${'a'.repeat(5000)}corvus-os:Windows_NT`), null);
  });

  test('l\'écho de la sonde elle-même ne fait pas conclure « windows »', () => {
    assert.equal(classifyOs(`${OS_PROBE}\ncorvus-os:%OS%::OS`), 'posix');
  });

  test('système effectif : le réglage de l\'administrateur prime sur la détection ; valeurs étrangères ignorées', () => {
    assert.equal(effectiveOs({ os: 'posix', osDetected: 'windows' }), 'posix');
    assert.equal(effectiveOs({ os: 'windows', osDetected: 'posix' }), 'windows');
    assert.equal(effectiveOs({ osDetected: 'windows' }), 'windows');
    for (const h of [undefined, null, {}, { os: 'beos' }, { osDetected: '<x>' }, { os: ['windows'] }]) assert.equal(effectiveOs(h), null, JSON.stringify(h));
  });
});

describe('hôte Windows simulé (cmd.exe) : serveur réel', () => {
  let win; let nix; let env; let c; let winId; let nixId;
  const hostBody = (s, extra = {}) => ({ name: 'h', hostname: '127.0.0.1', port: s.port, username: s.user, authType: 'password', password: s.password, ...extra });
  const host = async (id) => (await c.api('GET', `/api/hosts/${id}`)).body.host;

  before(async () => {
    win = await startFakeSshd({ windowsLike: true });
    nix = await startFakeSshd();
    env = await startCorvus();
    c = env.client;
    assert.equal((await c.login()).status, 200);
    winId = (await c.api('POST', '/api/hosts', hostBody(win, { name: 'Windows' }))).body.host.id;
    nixId = (await c.api('POST', '/api/hosts', hostBody(nix, { name: 'Linux' }))).body.host.id;
  });
  after(async () => { await env?.close(); await win?.close(); await nix?.close(); });

  test('première commande POSIX : sonde (1 seule commande), détection mémorisée, puis 409 POSIX_ONLY — rien de POSIX n\'atteint l\'hôte', async () => {
    assert.equal((await host(winId)).osEffective, null, 'pas encore sondé');
    const r = await c.api('GET', `/api/hosts/${winId}/monitor/stats`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'POSIX_ONLY');
    assert.match(r.body.error.message, /Windows/);
    // Rien d'autre : plusieurs fonctions POSIX de suite, toujours refusées sans aucune nouvelle commande.
    for (const url of [`/api/hosts/${winId}/monitor/processes`, `/api/hosts/${winId}/docker/containers`]) assert.equal((await c.api('GET', url)).status, 409, url);
    assert.deepEqual(win.stats.execs, [OS_PROBE], 'la sonde, et rien d\'autre');
    assert.equal((await host(winId)).osEffective, 'windows');
    assert.equal(env.corvus.ctx.hosts.find(winId).osDetected, 'windows', 'mémorisé en base');
  });

  test('hôte POSIX : sonde une fois, tout fonctionne comme avant', async () => {
    const r = await c.api('GET', `/api/hosts/${nixId}/monitor/stats`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal((await host(nixId)).osEffective, 'posix');
    assert.equal(nix.stats.execs.filter((e) => e === OS_PROBE).length, 1);
    await c.api('GET', `/api/hosts/${nixId}/monitor/processes`);
    assert.equal(nix.stats.execs.filter((e) => e === OS_PROBE).length, 1, 'pas de nouvelle sonde');
  });

  test('« Tester » : connexion OK annoncée pour Windows (pas un faux échec), système rapporté', async () => {
    const r = await c.api('POST', `/api/hosts/${winId}/test`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.ok, r.body.os, r.body.tmux], [true, 'windows', false]);
    assert.match(r.body.uname, /Windows/);
    const t = await c.api('POST', `/api/hosts/${nixId}/test`);
    assert.deepEqual([t.body.ok, t.body.os], [true, 'posix']);
    const draft = await c.api('POST', '/api/hosts/test', hostBody(win));
    assert.equal(draft.body.os, 'windows', 'test d\'un hôte pas encore enregistré');
    assert.ok(!win.stats.execs.some((e) => /uname|sh -c/.test(e)), 'aucun script POSIX n\'a été envoyé à l\'hôte Windows');
  });

  test('SFTP reste disponible : liste de dossier sur l\'hôte Windows', async () => {
    const r = await c.api('GET', `/api/hosts/${winId}/fs/list?path=${encodeURIComponent('~')}`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(Array.isArray(r.body.entries));
  });

  test('terminal : ouvert sans tmux (même si l\'hôte le demande), Claude Code refusé', async () => {
    const { terminals } = env.corvus.ctx;
    const before = win.stats.execs.length;
    const s = await terminals.create(winId, { tmux: true });
    assert.equal(s.tmux, null, 'pas de tmux sur Windows');
    assert.equal(win.stats.shells, 1, 'shell interactif de l\'hôte');
    assert.equal(win.stats.execs.length, before, 'aucune commande tmux (sh -c) envoyée');
    terminals.close(s.id);
    await assert.rejects(terminals.create(winId, { claude: { dir: '~' } }), (e) => e.code === 'POSIX_ONLY' && e.status === 409);
  });

  test('réglage de l\'administrateur : « posix » force l\'envoi, « windows » désactive sans rien envoyer, « auto » rend la main', async () => {
    const n = nix.stats.execs.length;
    assert.equal((await c.api('PATCH', `/api/hosts/${nixId}`, { os: 'windows' })).status, 200);
    assert.equal((await c.api('GET', `/api/hosts/${nixId}/monitor/stats`)).status, 409);
    assert.equal(nix.stats.execs.length, n, 'refusé sans rien envoyer à l\'hôte');
    assert.equal((await host(nixId)).osEffective, 'windows');
    assert.equal((await c.api('PATCH', `/api/hosts/${nixId}`, { os: 'auto' })).status, 200);
    assert.equal((await host(nixId)).osEffective, 'posix', 'retour à la détection mémorisée');
    assert.equal((await c.api('GET', `/api/hosts/${nixId}/monitor/stats`)).status, 200);
    // Forcer « posix » sur l'hôte Windows : l'administrateur prend la responsabilité, la commande part (et échoue chez cmd.exe).
    assert.equal((await c.api('PATCH', `/api/hosts/${winId}`, { os: 'posix' })).status, 200);
    const sent = win.stats.execs.length;
    await c.api('GET', `/api/hosts/${winId}/monitor/stats`);
    assert.ok(win.stats.execs.length > sent, 'réglage explicite respecté');
    await c.api('PATCH', `/api/hosts/${winId}`, { os: 'auto' });
  });

  test('valeurs hostiles pour « os » refusées (400) ; changer l\'adresse oublie la détection', async () => {
    for (const bad of ['beos', '', 'Windows ', '<script>', null, 42, ['windows'], { a: 1 }, 'x'.repeat(5000)]) {
      const r = await c.api('PATCH', `/api/hosts/${nixId}`, { os: bad });
      if (bad === '' || bad === null) continue; // « absent / vide » = auto : accepté
      assert.equal(r.status, 400, JSON.stringify(bad)?.slice(0, 30));
    }
    assert.equal(env.corvus.ctx.hosts.find(winId).osDetected, 'windows');
    await c.api('PATCH', `/api/hosts/${winId}`, { hostname: 'localhost' });
    assert.equal(env.corvus.ctx.hosts.find(winId).osDetected, undefined, 'autre adresse = autre machine : on resondera');
  });

  test('droits : seul un administrateur règle « os » (opérateur 403, hôte non accordé 404, sans compte 401)', async () => {
    const op = makeUser(env.corvus, { username: 'oper', password: 'Un-mot-de-passe-solide-7', role: 'operator' });
    env.corvus.ctx.users.setGrants(op.id, [{ scope: 'host', target: nixId, role: 'operator' }]);
    const oc = new CorvusClient(env.base, { corvus: env.corvus, user: op });
    assert.equal((await oc.login()).status, 200);
    assert.equal((await oc.api('PATCH', `/api/hosts/${nixId}`, { os: 'windows' })).status, 403);
    assert.equal((await oc.api('PATCH', `/api/hosts/${winId}`, { os: 'windows' })).status, 404);
    assert.equal(await fetch(`${env.base}/api/hosts/${nixId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"os":"windows"}' }).then((r) => r.status), 401);
    assert.notEqual((await host(nixId)).os, 'windows', 'aucun changement');
  });
});
