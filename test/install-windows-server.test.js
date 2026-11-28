// deploy/windows/install-windows.ps1 (installation du SERVEUR Corvus sur un PC Windows) : choix du port.
// Cause : le port par défaut 7680 est pris par Windows lui-même (optimisation de distribution de Windows Update, `svchost`) ;
// le script échouait alors avec « Corvus ne répond pas » sans dire pourquoi. Exécuté avec le vrai PowerShell : Windows seulement.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'deploy', 'windows', 'install-windows.ps1');
const WIN = process.platform === 'win32';

/** Charge les fonctions du script (CORVUS_INSTALL_LIB=1) puis exécute `cmd` ; renvoie la sortie standard nettoyée. */
async function ps(cmd) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$env:CORVUS_INSTALL_LIB='1'; . '${SCRIPT}'; ${cmd}`],
    { env: process.env, timeout: 60_000 });
  return stdout.trim();
}
const occupe = (port) => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(port, '127.0.0.1', () => resolve(s));
});
const libre = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

describe('install-windows.ps1 : port occupé', { skip: WIN ? false : 'PowerShell Windows requis' }, () => {
  let p1; let busy;
  before(async () => { p1 = await libre(); busy = await occupe(p1); });
  after(() => busy?.close());

  test('le fichier a un BOM UTF-8 (sinon Windows PowerShell 5.1 abîme les accents)', () => {
    assert.deepEqual([...fs.readFileSync(SCRIPT).subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.deepEqual([...fs.readFileSync(path.join(here, '..', 'deploy', 'windows', 'start-corvus.ps1')).subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  });

  test('port libre : conservé', async () => {
    const p = await libre();
    assert.equal(await ps(`Resolve-CorvusPort ${p} $false`), String(p));
  });

  test('port par défaut occupé : on prend le suivant libre, et on le dit', async () => {
    const out = await ps(`$ErrorActionPreference='Continue'; Resolve-CorvusPort ${p1} $false 3>$null`);
    const choisi = Number(out.split(/\r?\n/).pop());
    assert.ok(choisi > p1 && choisi <= p1 + 20, out);
    const msg = await ps(`Resolve-CorvusPort ${p1} $false 3>&1 | Out-String`);
    assert.match(msg, new RegExp(`${p1}.*(utilis|occup)`, 'i'));
  });

  test('port demandé EXPLICITEMENT et occupé : refus clair, jamais un autre port en silence', async () => {
    await assert.rejects(ps(`Resolve-CorvusPort ${p1} $true`), (e) => /d.j. utilis/i.test(e.stderr + e.stdout) && /-Port/.test(e.stderr + e.stdout)); // stderr de PowerShell : encodage OEM, d'où « d.j. »
  });

  test('port invalide ou hostile : refusé', async () => {
    for (const bad of ['0', '80', '70000', '-1']) {
      await assert.rejects(ps(`Resolve-CorvusPort ${bad} $true`), (e) => /invalide/i.test(e.stderr + e.stdout), bad);
    }
  });

  test('Corvus déjà démarré sur ce port : on ne le prend pas pour un conflit', async () => {
    const http = await import('node:http');
    const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    const p = await libre();
    await new Promise((r) => srv.listen(p, '127.0.0.1', r));
    try { assert.equal(await ps(`Resolve-CorvusPort ${p} $false`), String(p)); } finally { srv.close(); }
  });
});

describe('start-corvus.ps1 : le serveur reste en vie', { skip: WIN ? false : 'PowerShell Windows requis' }, () => {
  // Cause : Windows PowerShell 5.1 + `$ErrorActionPreference = 'Stop'` + redirection `*>>` (comme la tâche planifiée) : la ligne
  // « ExperimentalWarning: SQLite » écrite par Node sur stderr devenait une erreur fatale et tuait Corvus une seconde après son démarrage.
  test('lancé comme le fait la tâche planifiée (sortie redirigée), Corvus répond encore après 8 secondes', async () => {
    const os = await import('node:os');
    const port = await libre();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-startwin-'));
    const start = path.join(here, '..', 'deploy', 'windows', 'start-corvus.ps1');
    const log = path.join(data, 'sortie.log');
    const { spawn } = await import('node:child_process');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& '${start}' *>> '${log}'`],
      { env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', CORVUS_DATA: data }, stdio: 'ignore', windowsHide: true });
    try {
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try { ok = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ok; } catch { /* pas encore */ }
      }
      assert.ok(ok, 'Corvus n\'a jamais répondu');
      await new Promise((r) => setTimeout(r, 8000));
      const encore = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      assert.equal(encore.ok, true, 'Corvus est mort après son démarrage');
      // -Uninstall retrouve le serveur par son chemin ABSOLU dans la ligne de commande : il doit donc y figurer.
      const racine = path.resolve(here, '..');
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=$((Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess)").CommandLine`]);
      assert.ok(stdout.toLowerCase().includes(path.join(racine, 'server', 'index.js').toLowerCase()), `ligne de commande de Corvus : ${stdout.trim()}`);
    } finally {
      try { await run('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* déjà arrêté */ }
      // Windows relâche les verrous de fichiers avec un léger retard : on réessaie, et un nettoyage raté ne masque jamais le résultat du test.
      try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* dossier temporaire : sans importance */ }
    }
  });
});
