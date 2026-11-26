// Installation de l'agent en une commande : script servi par Corvus, public, sans secret, cohérent avec deploy/agent/.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startCorvus } from './helpers/corvus.js';
import { installScript, UNIT, FULL_CONF } from '../server/lib/agent-install.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.join(here, '..', 'deploy', 'agent');

describe('script d\'installation de l\'agent', () => {
  let env; let script; let file;
  before(async () => {
    env = await startCorvus();
    const r = await fetch(`${env.base}/api/agent/install.sh`); // sans jeton d'accès : public
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /shellscript/);
    script = await r.text();
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-inst-')), 'install.sh');
    fs.writeFileSync(file, script);
  });
  after(async () => { await env?.close(); if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true }); });

  test('les unités embarquées sont identiques aux fichiers de deploy/agent/', () => {
    assert.equal(UNIT, fs.readFileSync(path.join(agentDir, 'corvus-agent.service'), 'utf8'));
    assert.equal(FULL_CONF, fs.readFileSync(path.join(agentDir, 'corvus-agent-full.conf'), 'utf8'));
  });

  test('syntaxe sh valide, version de ce Corvus, aucun secret', async () => {
    await run('sh', ['-n', file]);
    assert.match(script, new RegExp(`VERSION="${env.corvus.ctx.version}"`));
    assert.ok(!script.includes(env.token), 'le jeton d\'accès ne doit jamais apparaître');
    assert.ok(script.includes('sha256sum') && script.includes('SHA256SUMS'), 'vérification de l\'empreinte');
  });

  test('--dry-run : décrit les étapes sans rien modifier, jeton masqué', async function () {
    if (process.platform !== 'linux') return this.skip?.();
    const { stdout } = await run('sh', [file, '--server', 'https://corvus.exemple', '--token', 'SECRET123', '--full', '--dry-run']);
    assert.match(stdout, /simulation\) télécharger https:\/\/github\.com\/spp4tme\/Corvus-\/releases\/download\/v\d+\.\d+\.\d+\/corvus-agent-/);
    assert.match(stdout, /full\.conf/);
    assert.ok(!stdout.includes('SECRET123'), 'le jeton n\'est pas affiché');
    const sans = (await run('sh', [file, '--server', 'https://x', '--token', 'T', '--dry-run'])).stdout;
    assert.ok(!sans.includes('full.conf'), 'sans --full : pas de droits complets');
  });

  test('arguments manquants ou inconnus, et refus sans root', async function () {
    if (process.platform !== 'linux') return this.skip?.();
    await assert.rejects(run('sh', [file]), (e) => e.code === 2 && /Usage/.test(e.stderr));
    await assert.rejects(run('sh', [file, '--bidon']), (e) => e.code === 2);
    if (process.getuid?.() !== 0) await assert.rejects(run('sh', [file, '--server', 'https://x', '--token', 'T']), (e) => e.code === 1 && /sudo/.test(e.stderr));
  });

  test('version invalide refusée', () => {
    assert.throws(() => installScript('1.0; rm -rf /'), /version invalide/);
  });
});
