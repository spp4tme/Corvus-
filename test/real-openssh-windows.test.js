// Hôte Windows RÉEL (OpenSSH pour Windows) : détection du système, refus des fonctions POSIX, SFTP et terminal (ConPTY).
// Ignoré tant que CORVUS_REAL_WIN_SSH n'est pas défini : « hôte:port:utilisateur:chemin-de-la-clé-privée-sans-passphrase »
// (ex. 127.0.0.1:2222:antho:C:\essai\cle). Complète test/windows-hosts.test.js, qui n'utilise qu'une SIMULATION de cmd.exe.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startCorvus } from './helpers/corvus.js';

const SPEC = process.env.CORVUS_REAL_WIN_SSH;
const [HOST, PORT, USER, ...KEY] = SPEC ? SPEC.split(':') : [];

describe('OpenSSH pour Windows réel', { skip: SPEC ? false : 'CORVUS_REAL_WIN_SSH non défini (aucun OpenSSH Windows réel fourni)' }, () => {
  let env; let c; let id;
  before(async () => {
    env = await startCorvus();
    c = env.client;
    assert.equal((await c.login()).status, 200);
    const r = await c.api('POST', '/api/hosts', { name: 'Windows réel', hostname: HOST, port: Number(PORT), username: USER, authType: 'key', privateKey: fs.readFileSync(KEY.join(':'), 'utf8') });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    id = r.body.host.id;
  });
  after(async () => { await env?.close(); });

  test('« Tester » : connexion OK, système détecté « windows », pas de tmux', async () => {
    const r = await c.api('POST', `/api/hosts/${id}/test`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.ok, r.body.os, r.body.tmux], [true, 'windows', false], JSON.stringify(r.body));
  });

  test('fonctions POSIX refusées (409 POSIX_ONLY), détection mémorisée', async () => {
    for (const u of ['monitor/stats', 'monitor/processes', 'docker/containers']) {
      const r = await c.api('GET', `/api/hosts/${id}/${u}`);
      assert.equal(r.status, 409, `${u} : ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.equal(r.body.error.code, 'POSIX_ONLY');
    }
    assert.equal((await c.api('GET', `/api/hosts/${id}`)).body.host.osEffective, 'windows');
  });

  test('SFTP : liste de « ~ », chemin en /C:/…, écriture, lecture, suppression', async () => {
    const home = await c.api('GET', `/api/hosts/${id}/fs/list?path=${encodeURIComponent('~')}`);
    assert.equal(home.status, 200, JSON.stringify(home.body).slice(0, 300));
    assert.ok(Array.isArray(home.body.entries) && home.body.entries.length > 0, 'dossier personnel non vide');
    console.log('    ~ résolu en :', home.body.path, '| entrées :', home.body.entries.slice(0, 5).map((e) => e.name).join(', '));
    const dir = `${home.body.path.replace(/\/$/, '')}/corvus-essai-${Date.now()}`;
    assert.ok([200, 201].includes((await c.api('POST', `/api/hosts/${id}/fs/mkdir`, { path: dir })).status));
    const f = `${dir}/accentué é.txt`;
    const w = await c.api('PUT', `/api/hosts/${id}/fs/write`, { path: f, content: 'bonjour\nligne 2\n' });
    assert.equal(w.status, 200, JSON.stringify(w.body).slice(0, 300));
    const r = await c.api('GET', `/api/hosts/${id}/fs/read?path=${encodeURIComponent(f)}`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.match(JSON.stringify(r.body), /bonjour/);
    const l = await c.api('GET', `/api/hosts/${id}/fs/list?path=${encodeURIComponent(dir)}`);
    assert.deepEqual(l.body.entries.map((e) => e.name), ['accentué é.txt']);
    // Nettoyage : suppression demandée avec confirmation (règle de Corvus).
    const d = await c.api('POST', `/api/hosts/${id}/fs/delete`, { path: dir, confirm: true });
    assert.ok([200, 204].includes(d.status), JSON.stringify(d.body).slice(0, 300));
  });

  test('terminal (ConPTY) : une commande tapée renvoie sa sortie, sans tmux', async () => {
    const t = c.terminal({ host: id });
    await t.opened;
    await t.ready();
    assert.ok(!t.ctl.find((x) => x.t === 'error'), JSON.stringify(t.ctl));
    await new Promise((r) => setTimeout(r, 1500));
    t.send('echo corvus-conpty-ok\r');
    await t.waitFor((x) => /corvus-conpty-ok/.test(x.output.replace(/echo corvus-conpty-ok/g, '')), 20000);
    console.log('    sortie du terminal (fin) :', JSON.stringify(t.output.slice(-120)));
    t.send('exit\r');
    t.ws.close();
  });
});
