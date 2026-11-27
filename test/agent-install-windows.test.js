// Script d'installation Windows (install.ps1) : servi par Corvus, public, sans secret, paramètres blindés, SHA-256 vérifié
// AVANT toute exécution. Exécuté avec le vrai PowerShell (Windows PowerShell 5.1 ou pwsh) ; sauté s'il n'y en a pas.
// Ce que ces tests NE couvrent PAS : l'installation réelle du service (elle exige un administrateur, un binaire Windows
// publié et l'agent Windows lui-même) — à valider à la main, voir le wiki, page « Installation-Windows-et-macOS ».
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { startCorvus } from './helpers/corvus.js';
import { installScriptWindows } from '../server/lib/agent-install-windows.js';

function findPowerShell() {
  // install.ps1 est un script WINDOWS (%ProgramFiles%, icacls, sc.exe) : même si `pwsh` existe sous Linux (runners CI),
  // il n'a aucun sens d'y exécuter ces tests. Ils tournent donc sous Windows seulement.
  for (const exe of process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : []) {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return exe;
  }
  return null;
}
const PS = findPowerShell();
const skip = PS ? false : 'script Windows : exécuté sous Windows (PowerShell) seulement';
const ps = (args, env = {}) => spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });

describe('install.ps1 : le serveur le sert', () => {
  let env; let script; let bom;
  before(async () => {
    env = await startCorvus();
    const r = await fetch(`${env.base}/api/agent/install.ps1`); // sans jeton d'accès : public
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    bom = bytes.subarray(0, 3).toString('hex'); // fetch().text() retire le BOM : on lit les octets bruts
    script = bytes.toString('utf8').replace(/^﻿/, '');
  });
  after(() => env?.close());

  test('version de ce Corvus, BOM UTF-8, aucun marqueur restant, aucun secret', () => {
    assert.equal(bom, 'efbbbf', 'BOM UTF-8 pour Windows PowerShell 5.1');
    assert.match(script, new RegExp(`\\$Version = '${env.corvus.ctx.version.replaceAll('.', '\\.')}'`));
    assert.equal(script.includes('@@'), false);
    assert.equal(script.includes(env.token), false);
    assert.ok(script.includes('releases/download/v'), 'release de la même version');
  });

  test('garanties statiques : aucun Invoke-Expression, aucune validation de certificat désactivée, HTTPS obligatoire', () => {
    const code = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // les commentaires disent ce qu'on ne fait PAS
    for (const forbidden of [/Invoke-Expression/i, /\biex\b/i, /DownloadString/i, /Invoke-Command/i, /ServerCertificateValidationCallback/i,
      /SkipCertificateCheck/i, /-Verbose:\$false.*Tls\b/i, /Start-Process[^\n]*-ArgumentList/i, /Set-ExecutionPolicy/i, /\bcmd\s*\/c\b/i]) {
      assert.equal(forbidden.test(code), false, String(forbidden));
    }
    assert.match(code, /HTTPS obligatoire/);
    assert.match(code, /Get-FileHash/);
  });

  test('l\'ordre : la vérification SHA-256 précède toute exécution du binaire téléchargé', () => {
    const iVerify = script.indexOf('Test-FileSha256 -Path $staged');
    const iMove = script.indexOf('Move-Item -LiteralPath $staged');
    const iRun = script.indexOf("Invoke-Native $exe @('version')");
    const iEnroll = script.indexOf("Invoke-Native $exe @('enroll'");
    assert.ok(iVerify > 0 && iVerify < iMove && iMove < iRun && iRun < iEnroll, [iVerify, iMove, iRun, iEnroll].join(' < '));
    assert.ok(script.indexOf("'/inheritance:r'") < script.indexOf('Get-Remote "$BaseUrl/$AssetName"'), 'ACL du dossier posée avant le téléchargement');
  });

  test('refuse de produire un script pour une version invalide', () => {
    for (const bad of ['', '1.2', '1.2.0; calc', "1.2.0'", '../1.2.0', undefined]) assert.throws(() => installScriptWindows(bad), /version invalide/, String(bad));
  });
});

describe('install.ps1 : exécuté par PowerShell', { skip }, () => {
  let dir; let file; let lib;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-ps-'));
    file = path.join(dir, 'install.ps1');
    fs.writeFileSync(file, installScriptWindows('9.9.9'));
    lib = (expr) => ps(['-Command', `$env:CORVUS_INSTALL_LIB='1'; . '${file}'; ${expr}`]);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const TOKEN = 'A'.repeat(43);

  test('syntaxe valide (analyseur PowerShell)', () => {
    const r = ps(['-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e); if($e){$e|%{$_.Message}; exit 1}`]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('-DryRun : montre le plan, ne télécharge rien, ne modifie rien, ne répète jamais le jeton', () => {
    const before = fs.existsSync(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Corvus Agent'));
    const r = ps(['-File', file, '-Server', 'https://corvus.exemple.ts.net', '-Token', TOKEN, '-DryRun']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /simulation\) telecharger https:\/\/github\.com\/spp4tme\/Corvus-\/releases\/download\/v9\.9\.9\/corvus-agent-9\.9\.9-windows-x86_64\.exe/);
    assert.match(r.stdout, /SHA-256 avec .*SHA256SUMS avant toute execution/);
    assert.match(r.stdout, /NT SERVICE\\CorvusAgent/);
    assert.equal(r.stdout.includes(TOKEN), false, 'le jeton n\'est jamais affiché');
    assert.equal(fs.existsSync(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Corvus Agent')), before, 'rien n\'a été créé');
  });

  test('-DryRun -Uninstall : plan seulement', () => {
    const r = ps(['-File', file, '-Uninstall', '-DryRun']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /supprimer le service CorvusAgent/);
    assert.match(r.stdout, /conserver .* \(utilisez -RemoveData/);
  });

  test('paramètres hostiles refusés AVANT toute action : pas d\'injection', () => {
    const marker = path.join(dir, 'injection.txt').replaceAll('\\', '/');
    const hostile = [
      ['-Server', `https://a.b'; Set-Content '${marker}' x #`, '-Token', TOKEN],
      ['-Server', 'https://a.b$(Set-Content ' + marker + ' x)', '-Token', TOKEN],
      ['-Server', 'https://a.b', '-Token', `${TOKEN}'; Set-Content '${marker}' x #`],
      ['-Server', 'https://a.b', '-Token', `${TOKEN} --extra`],
      ['-Server', 'https://a.b', '-Token', 'court'],
      ['-Server', 'https://a.b', '-Token', `${TOKEN}\n`],
      ['-Server', 'file:///c:/windows', '-Token', TOKEN],
      ['-Server', 'https://a.b/chemin?x=1', '-Token', TOKEN],
      ['-Server', 'https://' + 'a'.repeat(400), '-Token', TOKEN],
      ['-Server', 'https://a.b', '-Token', 'B'.repeat(5000)],
    ];
    for (const args of hostile) {
      const r = ps(['-File', file, ...args, '-DryRun']);
      assert.notEqual(r.status, 0, `accepté à tort : ${args.join(' ').slice(0, 80)}`);
    }
    assert.equal(fs.existsSync(marker), false, 'aucune commande injectée n\'a été exécutée');
  });

  test('http:// refusé hors localhost ; manque de paramètres = usage', () => {
    const r = ps(['-File', file, '-Server', 'http://corvus.exemple.ts.net', '-Token', TOKEN, '-DryRun']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /http:\/\/ refusee/);
    const ok = ps(['-File', file, '-Server', 'http://localhost:7680', '-Token', TOKEN, '-DryRun']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const bare = ps(['-File', file, '-DryRun']);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stdout + bare.stderr, /Usage/);
  });

  test('Get-ExpectedHash : nom EXACT seulement (casse comprise), CRLF toléré, hexadécimal de 64 caractères', () => {
    const good = 'a'.repeat(64); const other = 'b'.repeat(64);
    const sums = `${other}  corvus-agent-9.9.9-windows-x86_64.exe.sig\r\n${good.toUpperCase()}  corvus-agent-9.9.9-windows-x86_64.exe\r\n${other} *autre.exe\r\n`;
    const r = lib(`Write-Output ('[' + (Get-ExpectedHash -SumsText @'\n${sums}\n'@ -Name 'corvus-agent-9.9.9-windows-x86_64.exe') + ']')`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`\\[${good}\\]`));
    for (const [text, name] of [[`${good}  CORVUS-AGENT.EXE`, 'corvus-agent.exe'], [`${good.slice(1)}  x.exe`, 'x.exe'], [`${good}  x.exe.bak`, 'x.exe'], ['', 'x.exe']]) {
      const n = lib(`Write-Output ('[' + (Get-ExpectedHash -SumsText @'\n${text}\n'@ -Name '${name}') + ']')`);
      assert.match(n.stdout, /\[\]/, `${text.slice(0, 30)} / ${name}`);
    }
  });

  test('Test-FileSha256 : vrai si identique ; faux si le fichier change d\'un octet, si l\'empreinte est invalide ou vide', () => {
    const f = path.join(dir, 'binaire.exe');
    fs.writeFileSync(f, 'contenu de test');
    const sha = crypto.createHash('sha256').update('contenu de test').digest('hex');
    const t = (expected) => lib(`Write-Output (Test-FileSha256 -Path '${f.replaceAll('\\', '/')}' -Expected '${expected}')`).stdout.trim();
    assert.equal(t(sha), 'True');
    assert.equal(t(sha.toUpperCase()), 'False', 'empreinte attendue déjà normalisée en minuscules par Get-ExpectedHash');
    assert.equal(t('0'.repeat(64)), 'False');
    assert.equal(t('pas-un-hash'), 'False');
    fs.appendFileSync(f, '!');
    assert.equal(t(sha), 'False', 'un octet de plus');
  });

  test('Assert-AdminOnlyWritable : refuse un dossier modifiable par l\'utilisateur, accepte un dossier système', { skip: process.platform === 'win32' ? false : 'ACL Windows' }, () => {
    const mine = lib(`Assert-AdminOnlyWritable -Path '${dir.replaceAll('\\', '/')}'`);
    assert.notEqual(mine.status, 0, 'un dossier du profil de l\'utilisateur est modifiable par lui');
    assert.match(mine.stdout + mine.stderr, /modifiable par des non-administrateurs/);
    const sys = lib(`Assert-AdminOnlyWritable -Path '${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32').replaceAll('\\', '/')}'`);
    assert.equal(sys.status, 0, sys.stdout + sys.stderr);
  });

  test('sans droits d\'administrateur, une vraie installation est refusée avant tout téléchargement', { skip: process.platform === 'win32' ? false : 'Windows' }, () => {
    const admin = ps(['-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)']).stdout.trim();
    if (admin === 'True') return; // en administrateur on ne lance JAMAIS une vraie installation depuis un test
    const r = ps(['-File', file, '-Server', 'https://a.b', '-Token', TOKEN]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /administrateur/);
  });
});
