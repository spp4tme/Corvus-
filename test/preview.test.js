// Prévisualisation de commandes dans un bac à sable OverlayFS, par un agent ROOT (vrai binaire).
// Nécessite `sudo -n` : sinon les tests sont ignorés (CI, machine sans sudo sans mot de passe).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { startCorvus, waitFor } from './helpers/corvus.js';

const run = promisify(execFile);
const AGENT_BIN = process.env.CORVUS_AGENT_BIN
  || ['debug', 'release'].map((p) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'target', p, 'corvus-agent')).find((p) => fs.existsSync(p));
const hasSudo = (() => { try { execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' }); return process.platform === 'linux'; } catch { return false; } })();
const skip = !AGENT_BIN ? 'binaire non compilé' : !hasSudo ? 'sudo -n indisponible (agent root requis)' : false;

describe('prévisualisation (agent root, OverlayFS)', { skip }, () => {
  let env; let hostId; let child; let dir; let work;
  const auth = () => ({ authorization: `Bearer ${env.token}`, 'content-type': 'application/json' });
  const api = async (method, url, body) => {
    const r = await fetch(env.base + url, { method, headers: auth(), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  before(async () => {
    env = await startCorvus();
    const me = os.userInfo().username;
    const h = await api('POST', '/api/hosts', { name: 'Prev', hostname: '127.0.0.1', port: 22, username: me, authType: 'password', password: 'x' });
    hostId = h.body.host.id;
    // Dossier de travail HORS /tmp (le bac à sable monte un /tmp vide) : dans le dossier personnel de l'utilisateur.
    work = fs.mkdtempSync(path.join(os.homedir(), '.corvus-preview-test-'));
    fs.writeFileSync(path.join(work, 'config.txt'), 'valeur=1\n');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-agent-prev-'));
    const t = (await api('POST', '/api/agents/enrollments', { hostId })).body;
    await run(AGENT_BIN, ['enroll', '--server', env.base, '--token', t.token, '--dir', dir]);
    child = spawn('sudo', ['-n', AGENT_BIN, 'run', '--dir', dir, '--watch', work, '--allow-preview', '--interval', '1'], { stdio: 'pipe' });
    await waitFor(() => env.corvus.ctx.agents.forHost(hostId)?.online, 15000);
    await waitFor(() => env.corvus.ctx.agents.list()[0]?.capabilities?.preview, 10000);
  });
  after(async () => {
    child?.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { execFileSync('sudo', ['-n', 'chown', '-R', `${process.getuid()}:${process.getgid()}`, dir]); } catch { /* tant pis */ }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    await env?.close();
  });

  test('la commande est exécutée en bac à sable : le système réel n\'est pas modifié', async () => {
    const f = path.join(work, 'config.txt');
    const r = await api('POST', `/api/hosts/${hostId}/preview`, { command: `echo "valeur=2" > ${f}; echo nouveau > ${work}/cree.txt; rm -f ${work}/inexistant; echo fait` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.exit, 0);
    assert.match(r.body.stdout, /fait/);
    const byName = Object.fromEntries(r.body.entries.filter((e) => e.type === 'file').map((e) => [path.basename(e.path), e]));
    assert.equal(byName['config.txt'].kind, 'modified');
    assert.deepEqual(byName['config.txt'].diff.hunks[0].lines.filter((l) => l.t !== ' ').map((l) => l.t + l.s), ['-valeur=1', '+valeur=2']);
    assert.equal(byName['config.txt'].before, undefined, 'les textes bruts ne sont pas renvoyés au navigateur');
    assert.equal(byName['cree.txt'].kind, 'created');
    assert.equal(fs.readFileSync(f, 'utf8'), 'valeur=1\n', 'le vrai fichier est intact');
    assert.ok(!fs.existsSync(path.join(work, 'cree.txt')));
  });

  test('pas de réseau dans le bac à sable', async () => {
    const r = await api('POST', `/api/hosts/${hostId}/preview`, { command: 'cat /proc/net/dev | tail -n +3 | grep -v " lo:" | wc -l' });
    assert.equal(r.body.stdout.trim(), '0');
  });

  test('appliquer : confirmation obligatoire, puis le diff est rejoué ; conflit détecté', async () => {
    const f = path.join(work, 'config.txt');
    const p1 = (await api('POST', `/api/hosts/${hostId}/preview`, { command: `echo "valeur=3" > ${f}; echo x > ${work}/b.txt; rm ${work}/inexistant 2>/dev/null; true` })).body;
    assert.equal((await api('POST', `/api/hosts/${hostId}/preview/${p1.id}/apply`, {})).status, 400);
    const ok = await api('POST', `/api/hosts/${hostId}/preview/${p1.id}/apply`, { confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(fs.readFileSync(f, 'utf8'), 'valeur=3\n');
    assert.equal(fs.readFileSync(path.join(work, 'b.txt'), 'utf8'), 'x\n');
    assert.equal((await api('POST', `/api/hosts/${hostId}/preview/${p1.id}/apply`, { confirm: true })).status, 404, 'un diff ne s\'applique qu\'une fois');

    // Conflit : le fichier d'origine change entre la prévisualisation et l'application.
    const p2 = (await api('POST', `/api/hosts/${hostId}/preview`, { command: `echo "valeur=4" > ${f}; true` })).body;
    fs.writeFileSync(f, 'modifié entre-temps\n');
    const conflict = await api('POST', `/api/hosts/${hostId}/preview/${p2.id}/apply`, { confirm: true });
    assert.equal(conflict.status, 422);
    assert.match(JSON.stringify(conflict.body), /conflit/);
    assert.equal(fs.readFileSync(f, 'utf8'), 'modifié entre-temps\n', 'rien n\'est écrit en cas de conflit');
  });

  test('suppression et délai dépassé', async () => {
    const f = path.join(work, 'b.txt');
    const r = (await api('POST', `/api/hosts/${hostId}/preview`, { command: `rm ${f}` })).body;
    assert.deepEqual(r.entries.map((e) => [path.basename(e.path), e.kind]), [['b.txt', 'deleted']]);
    assert.ok(fs.existsSync(f), 'le fichier réel existe toujours');
    const slow = (await api('POST', `/api/hosts/${hostId}/preview`, { command: 'sleep 60', timeoutSec: 1 })).body;
    assert.ok(slow.durationMs < 15000);
    assert.equal(slow.timedOut, true);
  });

  test('root exige d\'être administrateur ; les droits sont vérifiés', async () => {
    const noauth = await fetch(`${env.base}/api/hosts/${hostId}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'id' }) });
    assert.equal(noauth.status, 401);
    const rootRun = await api('POST', `/api/hosts/${hostId}/preview`, { command: 'id -u', root: true });
    assert.equal(rootRun.status, 200);
    assert.equal(rootRun.body.stdout.trim(), '0');
    assert.equal(rootRun.body.root, true);
  });
});
