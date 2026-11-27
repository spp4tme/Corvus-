// Génère les captures d'écran du README (docs/img/*.png) à partir d'une instance de DÉMONSTRATION :
// un Corvus temporaire, un faux serveur SSH local (celui des tests), un vrai agent Rust et le faux ransomware.
// Rien n'est modifié hors de dossiers temporaires. Utilisation :
//   (cd agent && cargo build --release)       # l'agent (le binaire de debug marche aussi)
//   node scripts/captures.mjs                 # écrit docs/img/*.png
// Variables : CORVUS_AGENT_BIN (binaire de l'agent), CORVUS_TEST_BROWSER (msedge|chrome|chromium),
// CAPTURES_SUDO=1 pour lancer l'agent en root (nécessaire à la prévisualisation ; sudo sans mot de passe).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { startFakeSshd } from '../test/helpers/fake-sshd.js';
import { startCorvus, freshCode, waitFor } from '../test/helpers/corvus.js';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'img');
const DEMO = path.join(ROOT, 'deploy', 'demo', 'fake-ransomware.sh');
const AGENT_BIN = process.env.CORVUS_AGENT_BIN
  || ['release', 'debug'].flatMap((p) => ['', 'aarch64-unknown-linux-musl/', 'x86_64-unknown-linux-musl/'].map((t) => path.join(ROOT, 'agent', 'target', `${t}${p}`, 'corvus-agent'))).find((p) => fs.existsSync(p));
const AS_ROOT = process.env.CAPTURES_SUDO === '1';
fs.mkdirSync(OUT, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Décor : un faux serveur SSH avec des fichiers, un dépôt git et des dossiers surveillés ----------
const HOME_DIR = '/tmp/corvus-demo-home';
fs.rmSync(HOME_DIR, { recursive: true, force: true });
fs.mkdirSync(HOME_DIR);
const sshd = await startFakeSshd({ root: HOME_DIR });
const home = sshd.root;
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
w('docker-compose.yml', 'services:\n  web:\n    image: nginx:alpine\n    ports: ["80:80"]\n');
w('notes/todo.md', '# À faire\n\n- [x] mettre à jour le Pi\n- [ ] tester la restauration\n');
w('sauvegardes/2026-11-24.tar.zst', 'x'.repeat(4096));
w('config/nginx.conf', 'server {\n  listen 80;\n  server_name pi.local;\n  root /var/www;\n}\n');
w('config/app.env', 'MODE=production\nPORT=8080\n');
w('config/hosts.allow', 'sshd: 100.64.0.0/10\n');
w('config/sshd_config', 'Port 22\nPermitRootLogin no\nPasswordAuthentication no\nX11Forwarding no\nClientAliveInterval 300\nAllowUsers antho\n');
// Second faux serveur (le « NAS de la cave ») : sa configuration diffère un peu, pour la capture « Comparer ».
const HOME2 = '/tmp/corvus-demo-home2';
fs.rmSync(HOME2, { recursive: true, force: true });
fs.mkdirSync(HOME2);
const sshd2 = await startFakeSshd({ root: HOME2 });
fs.mkdirSync(path.join(HOME2, 'config'), { recursive: true });
fs.writeFileSync(path.join(HOME2, 'config', 'sshd_config'), 'Port 2222\nPermitRootLogin yes\nPasswordAuthentication yes\nX11Forwarding no\nClientAliveInterval 300\nAllowUsers antho nas\nPassword nas-secret-demo\n');
const git = (...a) => execFileSync('git', ['-C', path.join(home, 'projet-web'), '-c', 'user.name=Antho', '-c', 'user.email=antho@example.org', ...a], { stdio: 'ignore' });
fs.mkdirSync(path.join(home, 'projet-web'), { recursive: true });
git('init', '-q', '-b', 'main');
w('projet-web/index.html', '<h1>Bonjour</h1>\n');
git('add', '.'); git('commit', '-q', '-m', 'Première page');
w('projet-web/style.css', 'body { font-family: sans-serif; }\n');
git('add', '.'); git('commit', '-q', '-m', 'Ajoute la feuille de style');
w('projet-web/index.html', '<h1>Bonjour le tailnet</h1>\n<p>Servi depuis un Raspberry Pi.</p>\n');

// ---------- Corvus de démonstration ----------
// Une passphrase maître est définie : sans elle, Corvus affiche (à raison) un bandeau d'avertissement sur chaque écran.
const env = await startCorvus({ hostProbeSec: 4, metricsIntervalSec: 3, masterPassphrase: 'phrase-de-demonstration-pour-les-captures' });
const auth = { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' };
const api = async (method, url, body) => {
  const r = await fetch(env.base + url, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const mkHost = async (name, extra = {}) => (await api('POST', '/api/hosts', { name, hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password, ...extra })).body.host.id;
const hPi = await mkHost('Pi du salon', { group: 'Maison' });
await api('POST', '/api/hosts', { name: 'NAS de la cave', group: 'Maison', hostname: '127.0.0.1', port: sshd2.port, username: sshd2.user, authType: 'password', password: sshd2.password });
await mkHost('Serveur web', { group: 'Travail' });
await api('PATCH', `/api/hosts/${hPi}`, { repos: [path.join(home, 'projet-web')] });
await api('POST', `/api/hosts/${hPi}/test`);

// ---------- Agent réel sur « Pi du salon » ----------
let agent; let agentDir; let ransomDir; let tAvant = 0;
const pad = (n) => String(n).padStart(2, '0');
const localInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
if (AGENT_BIN) {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-captures-agent-'));
  const t = (await api('POST', '/api/agents/enrollments', { hostId: hPi })).body;
  const pre = AS_ROOT ? ['sudo', '-n', AGENT_BIN] : [AGENT_BIN];
  await run(pre[0], [...pre.slice(1), 'enroll', '--server', env.base, '--token', t.token, '--dir', agentDir]);
  ransomDir = /Dossier de démonstration : (\S+)/.exec((await run('bash', [DEMO, 'prepare'])).stdout)[1];
  agent = spawn(pre[0], [...pre.slice(1), 'run', '--dir', agentDir, '--watch', `${path.join(home, 'config')},${ransomDir}`, '--canary', ransomDir, '--interval', '2', '--scan-interval', '2', ...(AS_ROOT ? ['--allow-preview'] : [])], { stdio: 'ignore' });
  await waitFor(() => env.corvus.ctx.agents.forHost(hPi)?.online, 20000);
  await waitFor(async () => (await api('GET', `/api/hosts/${hPi}/rewind/events?type=file.baseline&limit=50`)).body.events.length >= 36, 30000, 300);
}

// ---------- Navigateur ----------
async function launch() {
  const channels = process.env.CORVUS_TEST_BROWSER ? [process.env.CORVUS_TEST_BROWSER] : ['msedge', 'chrome', 'chromium'];
  for (const channel of channels) { try { return await chromium.launch({ channel, headless: true }); } catch { /* suivant */ } }
  return chromium.launch({ headless: true });
}
const browser = await launch();
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('  ✔', name); };
const go = async (page, route, ms = 1200) => { await page.evaluate((r) => { location.hash = `#/${r}`; }, route); await page.waitForTimeout(ms); };
async function login(page) {
  await page.goto(env.base);
  await page.getByLabel('Identifiant').fill(env.admin.username);
  await page.getByLabel('Mot de passe', { exact: true }).fill(env.admin.password);
  await page.getByLabel('Code à 6 chiffres').fill(freshCode(env.corvus, env.admin));
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.locator('.app-nav').waitFor();
}
const pickHost = async (page, name) => { const sel = page.locator('select').first(); if (await sel.count()) await sel.selectOption({ label: name }).catch(() => {}); await page.waitForTimeout(900); };

try {
  // ===== Bureau 1280×800 =====
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  ⚠ erreur JS :', e.message));
  await login(page);
  await page.waitForTimeout(6000); // sondes d'état + premières mesures
  await shot(page, 'hotes');

  // Comparer une configuration entre deux hôtes (les valeurs sensibles sont masquées)
  await go(page, 'compare', 1500);
  await page.getByLabel('Fichier à comparer').fill('~/config/sshd_config');
  for (const n of ['Pi du salon', 'NAS de la cave']) { const box = page.locator('label.check', { hasText: n }).locator('input'); if (!(await box.isChecked())) await box.check(); }
  await page.getByRole('button', { name: 'Comparer', exact: true }).click();
  await page.waitForTimeout(2500); await shot(page, 'comparer');
  await go(page, 'hosts', 1500);

  // Terminal : quelques commandes réelles dans le faux sshd
  await page.locator('.card, .list-item', { hasText: 'Pi du salon' }).getByRole('button', { name: 'Terminal' }).first().click();
  await page.waitForTimeout(2500);
  const term = page.locator('.xterm-helper-textarea').first();
  if (await term.count()) {
    await term.focus();
    // Le faux sshd n'a pas de vrai pty : `script` en fournit un (retours à la ligne corrects), puis une invite lisible.
    for (const c of ['exec script -qfc "env LC_ALL=C.UTF-8 bash --norc --noediting" /dev/null', "stty -echo; export PS1='antho@pi-du-salon:~$ '; clear", 'uname -srm', 'ls', 'cat notes/todo.md', 'git -C projet-web log --oneline', 'git -C projet-web status -s']) { await page.keyboard.type(c); await page.keyboard.press('Enter'); await page.waitForTimeout(1000); }
  }
  await shot(page, 'terminal');

  await go(page, 'files'); await pickHost(page, 'Pi du salon'); await shot(page, 'fichiers');
  await go(page, 'git'); await pickHost(page, 'Pi du salon'); await shot(page, 'git');
  await go(page, 'monitor'); await pickHost(page, 'Pi du salon'); await page.waitForTimeout(5000); await shot(page, 'supervision');

  if (agent) {
    await go(page, 'agents'); await shot(page, 'agents');

    // Rembobiner : on modifie la configuration surveillée, puis on regarde la frise
    await pause(3500);
    tAvant = Date.now() - 1500;
    w('config/nginx.conf', 'server {\n  listen 80;\n  server_name pi.local;\n  root /var/www;\n  autoindex on;\n}\n');
    fs.writeFileSync(path.join(home, 'config', 'app.env'), 'MODE=debug\nPORT=8080\nSECRET=oups\n');
    fs.rmSync(path.join(home, 'config', 'hosts.allow'));
    await pause(6000);
    await go(page, 'rewind', 1500); await pickHost(page, 'Pi du salon'); await page.waitForTimeout(1500);
    await page.getByLabel('Instant visé').fill(localInput(tAvant)); await page.getByLabel('Instant visé').dispatchEvent('change'); await page.waitForTimeout(2500); await shot(page, 'rembobiner');

    await go(page, 'xray', 1500); await pickHost(page, 'Pi du salon'); await page.waitForTimeout(3000);
    // Filtre : on ne montre que les services système (les autres processus de la machine de démonstration sont privés).
    await page.getByPlaceholder(/Filtrer/).fill('systemd'); await page.waitForTimeout(800); await shot(page, 'radiographie');
    await page.getByPlaceholder(/Filtrer/).fill('');
    const tab = page.getByRole('tab', { name: /Normal/ });
    if (await tab.count()) { await tab.first().click(); await page.waitForTimeout(1200); await shot(page, 'empreinte'); }

    // Anti-ransomware : attaque simulée, puis le journal des alertes
    await run('bash', [DEMO, 'attack', ransomDir]);
    await waitFor(() => env.corvus.ctx.db.get("SELECT 1 AS x FROM alerts WHERE kind LIKE 'ransom:%'"), 40000, 500).catch(() => console.log('  ⚠ pas d\'alerte ransomware'));
    await go(page, 'journal', 1500);
    await page.getByRole('tab', { name: 'Alertes' }).click().catch(() => {}); await page.waitForTimeout(1200); await shot(page, 'alertes-ransomware');
  }

  // Barre de commande : une commande risquée proposée en prévisualisation (agent root requis)
  if (agent && AS_ROOT) {
    // La prévisualisation s'exécute sous le compte SSH de l'hôte : on indique le compte local réel (le faux sshd accepte « tester »).
    env.corvus.ctx.db.run('UPDATE hosts SET username = ? WHERE id = ?', os.userInfo().username, hPi);
    await go(page, 'terminal', 1800);
    const bar = page.locator('.cmdbar-input');
    if (await bar.count()) {
      await bar.fill(`rm -r ${home}/config`);
      await bar.press('Enter');
      await page.waitForTimeout(1500);
      await shot(page, 'commande-risquee');
      const prev = page.getByRole('button', { name: 'Prévisualiser' });
      if (await prev.count()) { await prev.click(); await page.waitForTimeout(3500); await shot(page, 'previsualisation'); }
    }
  }
  await ctx.close();

  // ===== Mobile 390×844 =====
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mp = await m.newPage();
  await login(mp);
  await mp.waitForTimeout(3000); await shot(mp, 'mobile-hotes');
  await go(mp, 'monitor', 1500); await pickHost(mp, 'Pi du salon'); await mp.waitForTimeout(4000); await shot(mp, 'mobile-supervision');
  if (agent) { await go(mp, 'rewind', 1500); await pickHost(mp, 'Pi du salon'); await mp.waitForTimeout(1500); await mp.getByLabel('Instant visé').fill(localInput(tAvant)); await mp.getByLabel('Instant visé').dispatchEvent('change'); await mp.waitForTimeout(2500); await shot(mp, 'mobile-rembobiner'); }
  await m.close();
} finally {
  await browser.close();
  agent?.kill();
  if (AS_ROOT && agentDir) { try { execFileSync('sudo', ['-n', 'rm', '-rf', agentDir]); } catch { /* tant pis */ } } else if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
  if (ransomDir) { try { execFileSync('rm', ['-rf', ransomDir]); } catch { /* tant pis */ } }
  await env.close();
  await sshd.close();
  await sshd2.close();
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
}
