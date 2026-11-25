// Test d'interface réel : navigateur headless (Edge/Chrome via playwright-core, sans téléchargement),
// viewport mobile 375 px et desktop. Ignoré si aucun navigateur n'est disponible.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus, freshCode } from './helpers/corvus.js';

/** Connexion par l'écran réel : identifiant, mot de passe, code TOTP. */
async function uiLogin(page) {
  await page.getByLabel('Identifiant').fill(env.admin.username);
  await page.getByLabel('Mot de passe', { exact: true }).fill(env.admin.password);
  await page.getByLabel('Code à 6 chiffres').fill(freshCode(env.corvus, env.admin));
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
}

const OUT = path.resolve('test-results');
let sshd;
let env;
let browser;

async function launch() {
  const channels = process.env.CORVUS_TEST_BROWSER ? [process.env.CORVUS_TEST_BROWSER] : ['msedge', 'chrome', 'chromium'];
  for (const channel of channels) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* suivant */ }
  }
  return null;
}

before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  sshd = await startFakeSshd();
  env = await startCorvus();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await env?.close();
  await sshd?.close();
});

/** Vérifie : pas de défilement horizontal, cibles tactiles ≥ 44 px. */
async function auditLayout(page, label) {
  const report = await page.evaluate(() => {
    let overflow = document.documentElement.scrollWidth - window.innerWidth;
    // Débordements masqués par un conteneur à défilement (ex. <main>) : on vérifie chaque bloc visible.
    for (const el of document.querySelectorAll('.card, .list-item, .toolbar, .field, .host-actions, dialog[open]')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > window.innerWidth + 0.5) overflow = Math.max(overflow, Math.round(r.right - window.innerWidth));
    }
    const small = [];
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"]')) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden') continue;
      if (el.closest('.xterm')) continue; // éléments internes d'xterm (textarea de saisie)
      if (el.type === 'checkbox') continue; // la cible est le <label class="check"> entier
      if (r.height < 43.5 || r.width < 43.5) small.push(`${el.tagName.toLowerCase()}.${el.className} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return { overflow, small };
  });
  assert.ok(report.overflow <= 0, `${label} : défilement horizontal de ${report.overflow}px`);
  assert.deepEqual(report.small, [], `${label} : cibles tactiles < 44px`);
}

test('mobile 375px : connexion, ajout d\'hôte, terminal', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|apple-touch|sw\.js/.test(m.text())) errors.push(m.text()); });

  await page.goto(env.base);
  await uiLogin(page);
  await page.getByText('Aucun hôte').waitFor();
  await auditLayout(page, 'hôtes vides');
  await page.screenshot({ path: path.join(OUT, 'mobile-1-hotes-vide.png') });

  // Ajout d'un hôte via le dialogue
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.getByLabel('Alias').fill('Pi du salon');
  await page.getByLabel('Hôte', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('Utilisateur').fill(sshd.user);
  await page.getByLabel('Port').fill(String(sshd.port));
  const pass = page.getByLabel('Mot de passe', { exact: true }).and(page.locator('input'));
  await pass.fill(sshd.password);
  assert.equal(await pass.inputValue(), sshd.password);
  await auditLayout(page, 'dialogue hôte');
  await page.screenshot({ path: path.join(OUT, 'mobile-2-dialogue.png') });
  await page.getByRole('button', { name: 'Tester' }).click();
  const result = page.locator('dialog .test-result');
  await result.waitFor();
  assert.match(await result.innerText(), /Connexion OK/);
  await page.getByRole('button', { name: 'Ajouter', exact: true }).last().click();
  await page.getByRole('heading', { name: 'Pi du salon' }).waitFor();
  await auditLayout(page, 'liste des hôtes');
  await page.screenshot({ path: path.join(OUT, 'mobile-3-hotes.png') });

  // Terminal
  await page.getByRole('button', { name: 'Terminal' }).first().click();
  await page.locator('.xterm').waitFor();
  await page.waitForFunction(() => document.querySelector('.term-tab .dot-ok'));
  await page.locator('.xterm').click();
  await page.keyboard.type('echo ui-$((6*7))');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('ui-42'), null, { timeout: 15000 });
  // barre de touches : ^C visible et utilisable
  await page.getByRole('button', { name: 'Ctrl+C (interrompre)' }).click();
  await auditLayout(page, 'terminal');
  await page.screenshot({ path: path.join(OUT, 'mobile-4-terminal.png') });

  // Le terminal occupe l'espace entre onglets et barre de touches (rien n'est masqué).
  const geo = await page.evaluate(() => {
    const stage = document.querySelector('.term-stage').getBoundingClientRect();
    const bar = document.querySelector('.keybar').getBoundingClientRect();
    return { stageBottom: stage.bottom, barTop: bar.top, stageH: stage.height };
  });
  assert.ok(geo.stageH > 200, `terminal trop petit : ${geo.stageH}px`);
  assert.ok(geo.stageBottom <= geo.barTop + 1, 'la barre de touches recouvre le terminal');

  // Navigation vers Plus → Journal
  await page.getByRole('link', { name: 'Plus' }).click();
  await page.getByRole('link', { name: /Journal/ }).click();
  await page.getByText('terminal · open').first().waitFor();
  await auditLayout(page, 'journal');

  assert.deepEqual(errors, [], 'erreurs JavaScript dans la page');
  await ctx.close();
});

test('mobile 375px : fichiers (dossier, envoi, édition)', async (t) => {
  if (!browser) return t.skip('aucun navigateur disponible');
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(env.base);
  await uiLogin(page);
  await page.getByRole('heading', { name: 'Pi du salon' }).waitFor();
  await page.getByRole('button', { name: 'Fichiers' }).first().click();
  await page.getByRole('button', { name: 'Nouveau dossier' }).waitFor();
  await page.getByText('Dossier vide').waitFor(); // la liste doit être chargée avant d'agir (sinon runner lent : clic trop tôt)

  await page.getByRole('button', { name: 'Nouveau dossier' }).click();
  await page.getByLabel('Nom du dossier').fill('projet-ui');
  await page.getByRole('button', { name: 'Valider' }).click();
  await page.getByText('projet-ui', { exact: true }).click();
  await page.getByText('Dossier vide').waitFor();

  const tmp = path.join(OUT, 'notes.md');
  fs.writeFileSync(tmp, '# Notes\n\nligne 1\n');
  await page.locator('input[type=file]').setInputFiles(tmp);
  await page.getByText('notes.md', { exact: true }).waitFor();
  await auditLayout(page, 'fichiers');
  await page.screenshot({ path: path.join(OUT, 'mobile-5-fichiers.png') });

  // L'envoi recharge la liste : on attend qu'il soit terminé (fichier écrit, réseau calme) avant de cliquer,
  // sinon le clic tombe sur un élément remplacé (runner lent).
  for (let k = 0; k < 100 && !fs.existsSync(path.join(sshd.root, 'projet-ui', 'notes.md')); k++) await new Promise((r) => setTimeout(r, 100));
  await page.waitForLoadState('networkidle');
  const editor = page.getByLabel(/Contenu de/);
  await page.getByText('notes.md', { exact: true }).click();
  await editor.waitFor({ timeout: 8000 }).catch(async () => { await page.getByText('notes.md', { exact: true }).click(); });
  await editor.waitFor();
  assert.match(await editor.inputValue(), /ligne 1/);
  await editor.press('End');
  await editor.type('ligne 2 ajoutée depuis le téléphone\n');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText(/· enregistré/).waitFor();
  await page.screenshot({ path: path.join(OUT, 'mobile-6-editeur.png') });
  const written = fs.readFileSync(path.join(sshd.root, 'projet-ui', 'notes.md'), 'utf8');
  assert.match(written, /ligne 2 ajoutée depuis le téléphone/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('mobile 375px : git (découverte, diff, commit, historique)', async (t) => {
  if (!browser) return t.skip('aucun navigateur disponible');
  const repoDir = path.join(sshd.root, 'repo-ui');
  fs.mkdirSync(repoDir);
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'UI');
  git('config', 'user.email', 'ui@corvus.local');
  fs.writeFileSync(path.join(repoDir, 'app.txt'), 'v1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial');
  fs.writeFileSync(path.join(repoDir, 'app.txt'), 'v1\nv2\n');

  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${env.base}/#/git`);
  await uiLogin(page);
  await page.getByText('Choisissez un hôte').first().waitFor();
  await page.getByLabel('Hôte').selectOption({ label: 'Pi du salon' });
  await page.getByRole('button', { name: 'Découvrir', exact: true }).click();
  await page.getByRole('button', { name: '~/repo-ui' }).click();
  await page.getByText('app.txt').waitFor();
  await page.getByText('app.txt').click();
  await page.locator('.diff .d-add', { hasText: '+v2' }).waitFor();
  await page.screenshot({ path: path.join(OUT, 'mobile-7-git-diff.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Indexer app.txt' }).click();
  await page.getByRole('heading', { name: /Indexés/ }).waitFor();
  await page.getByLabel('Message de commit').fill('Version 2 depuis Corvus');
  await page.getByRole('button', { name: /Commit \(1\)/ }).click();
  await page.getByText('Arbre de travail propre').waitFor();
  await auditLayout(page, 'git statut');
  await page.screenshot({ path: path.join(OUT, 'mobile-8-git-statut.png') });
  await page.getByRole('tab', { name: 'Historique' }).click();
  await page.getByText('Version 2 depuis Corvus').waitFor();
  await auditLayout(page, 'git historique');
  assert.equal(git('log', '-1', '--format=%s').trim(), 'Version 2 depuis Corvus');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('mobile 375px : supervision (tuiles, graphiques, processus, docker)', async (t) => {
  if (!browser) return t.skip('aucun navigateur disponible');
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${env.base}/#/monitor`);
  await uiLogin(page);
  await page.getByLabel('Hôte').selectOption({ label: 'Pi du salon' });
  await page.locator('.tile').first().waitFor();
  // 3 relevés : le CPU devient un nombre et les courbes ont des points
  await page.waitForFunction(() => document.querySelectorAll('.values-table tbody tr').length >= 3, null, { timeout: 20000 });
  const cpuText = await page.locator('.tile').first().locator('.tile-value').innerText();
  assert.match(cpuText, /\d+ %/);
  await auditLayout(page, 'supervision');
  await page.screenshot({ path: path.join(OUT, 'mobile-9-supervision.png'), fullPage: false });
  // survol d'un graphique : infobulle
  const canvas = page.locator('.chart-canvas').first();
  await canvas.scrollIntoViewIfNeeded(); // plus de tuiles (E/S, TCP, cœurs) : les graphiques sont plus bas
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2);
  await page.locator('.chart-tip').first().waitFor();

  await page.getByRole('tab', { name: 'Historique' }).click();
  await page.getByRole('tab', { name: '1 h' }).click();
  await page.locator('.chart-canvas, .state').first().waitFor();
  await auditLayout(page, 'historique');

  await page.getByRole('tab', { name: 'Processus' }).click();
  await page.getByText(/processus — \d+ affichés/).waitFor();
  await auditLayout(page, 'processus');
  await page.getByRole('tab', { name: 'Docker' }).click();
  await page.getByText('nginx:alpine', { exact: false }).waitFor();
  await auditLayout(page, 'docker');
  await page.screenshot({ path: path.join(OUT, 'mobile-10-docker.png') });
  await page.getByRole('button', { name: 'Logs' }).first().click();
  await page.getByText('journal de web').waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('mobile 375px : services web et réglages', async (t) => {
  if (!browser) return t.skip('aucun navigateur disponible');
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${env.base}/#/proxy`);
  await uiLogin(page);
  await page.getByText('Aucun service').waitFor();
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.getByLabel('Nom').fill('Tableau de bord');
  await page.getByLabel('URL du service').fill(`${env.base}/`);
  await page.getByRole('button', { name: 'Ajouter', exact: true }).last().click();
  await page.getByText('Tableau de bord').waitFor();
  await auditLayout(page, 'services web');
  await page.screenshot({ path: path.join(OUT, 'mobile-11-services.png') });
  await page.getByRole('link', { name: 'Plus' }).click();
  await page.getByRole('link', { name: /Réglages/ }).click();
  await page.getByText('Taille de police').waitFor();
  await page.getByText('Notifications', { exact: true }).waitFor();
  await auditLayout(page, 'réglages');
  await page.screenshot({ path: path.join(OUT, 'mobile-12-reglages.png') });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop 1280px : rail latéral et reprise des onglets après rechargement', async (t) => {
  if (!browser) return t.skip('aucun navigateur disponible');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(env.base);
  await uiLogin(page);
  await page.getByRole('heading', { name: 'Pi du salon' }).waitFor();
  const nav = await page.locator('.app-nav').boundingBox();
  assert.ok(nav.height > nav.width, 'la navigation doit être un rail vertical sur desktop');
  await page.getByRole('link', { name: 'Terminal' }).click();
  // la session ouverte par le test mobile est restaurée
  await page.waitForFunction(() => document.querySelectorAll('.term-tab').length >= 1);
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('ui-42'), null, { timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, 'desktop-terminal.png') });
  await auditLayout(page, 'desktop terminal');
  await page.getByRole('link', { name: 'Supervision' }).click();
  await page.getByLabel('Hôte').selectOption({ label: 'Pi du salon' });
  await page.waitForFunction(() => document.querySelectorAll('.values-table tbody tr').length >= 4, null, { timeout: 25000 });
  const net = page.locator('.chart-canvas').nth(2);
  const nb = await net.boundingBox();
  await page.mouse.move(nb.x + nb.width * 0.9, nb.y + nb.height / 2);
  await page.screenshot({ path: path.join(OUT, 'desktop-supervision.png') });
  await auditLayout(page, 'desktop supervision');
  await ctx.close();
});

test('mobile 375px : page Claude Code (navigation, session tmux, reprise, arrêt)', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const sshd2 = await startFakeSshd({ fakeTmux: true });
  try {
    await env.client.login();
    const created = await env.client.api('POST', '/api/hosts', {
      name: 'Claude Pi', hostname: '127.0.0.1', port: sshd2.port, username: sshd2.user, authType: 'password', password: sshd2.password,
    });
    assert.equal(created.status, 201);
    const hostId = created.body.host.id;
    const live = '.term-pane:not([hidden]) .xterm-rows';

    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|manifest|apple-touch|sw\.js/.test(m.text())) errors.push(m.text()); });
    await page.goto(env.base);
    await uiLogin(page);
    const card = page.locator('article.host-card', { hasText: 'Claude Pi' });
    await card.waitFor();
    await auditLayout(page, 'hôtes avec bouton Claude');

    // « Claude » est un onglet de la navigation, comme Hôtes, Terminal, Fichiers.
    const navLink = page.locator('.app-nav').getByRole('link', { name: 'Claude' });
    assert.ok(await navLink.isVisible(), 'onglet Claude dans la barre de navigation');
    const labels = await page.locator('.app-nav .nav-item:visible').allInnerTexts();
    assert.deepEqual(labels.slice(0, 3).map((x) => x.trim()), ['Hôtes', 'Terminal', 'Claude']);

    // Le bouton de la fiche d'hôte ouvre cette page sur l'hôte choisi.
    await card.getByRole('button', { name: 'Claude Code' }).click();
    await page.getByText('Aucune session Claude active').waitFor();
    await auditLayout(page, 'page Claude vide');
    await page.screenshot({ path: path.join(OUT, 'mobile-claude-1-page.png') });

    // Nouvelle session → onglet du terminal ordinaire (même barre d'onglets), touches Claude visibles.
    await page.getByRole('button', { name: 'Nouvelle session' }).click();
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes('FAKE-CLAUDE'), live, { timeout: 20000 });
    assert.equal(await page.locator('.app-header').isVisible(), true, 'pas de plein écran : en-tête conservé');
    assert.equal(await page.locator('.app-nav').isVisible(), true, 'pas de plein écran : navigation conservée');
    assert.equal(await page.locator('.term-actions').count(), 0, 'barre d\'onglets d\'origine');
    assert.ok((await page.locator('.term-tab[aria-selected="true"]').innerText()).includes('Claude'));
    for (const name of ['Shift+Tab (changer de mode dans Claude Code)', 'Entrée']) {
      assert.ok(await page.getByRole('button', { name }).isVisible(), `touche ${name} visible`);
    }
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.xterm-helper-textarea')).fontSize), '16px');
    await auditLayout(page, 'terminal Claude');
    await page.screenshot({ path: path.join(OUT, 'mobile-claude-2-terminal.png') });
    assert.deepEqual((await env.client.api('GET', `/api/hosts/${hostId}/claude`)).body.sessions.map((s) => s.name), ['corvus-claude-claude-pi-1']);

    // Un onglet de terminal ordinaire n'affiche pas ces touches.
    await page.getByRole('link', { name: 'Hôtes' }).click();
    await card.getByRole('button', { name: 'Terminal' }).click();
    await page.waitForFunction(() => document.querySelector('.term-tab[aria-selected="true"] .dot-ok'), null, { timeout: 15000 });
    assert.equal(await page.getByRole('button', { name: 'Shift+Tab (changer de mode dans Claude Code)' }).isVisible(), false);

    // Retour sur la page : la session est listée (Reprendre / Tuer).
    await navLink.click();
    await page.locator('.host-name.mono', { hasText: 'corvus-claude-claude-pi-1' }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Reprendre' }).isVisible());
    await auditLayout(page, 'page Claude avec session');
    await page.screenshot({ path: path.join(OUT, 'mobile-claude-3-sessions.png') });
    await page.getByRole('button', { name: 'Nouvelle session' }).click();
    await page.waitForFunction(async (id) => (await (await fetch(`/api/hosts/${id}/claude`)).json()).sessions.length === 2, hostId, { timeout: 20000 });

    // Tuer la première depuis la page.
    await navLink.click();
    await page.getByRole('button', { name: 'Tuer corvus-claude-claude-pi-1', exact: true }).click();
    await page.getByRole('button', { name: 'Tuer', exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.host-name.mono')].some((e) => e.textContent === 'corvus-claude-claude-pi-1'), null, { timeout: 15000 });
    assert.deepEqual((await env.client.api('GET', `/api/hosts/${hostId}/claude`)).body.sessions.map((s) => s.name), ['corvus-claude-claude-pi-2']);
    await page.screenshot({ path: path.join(OUT, 'mobile-claude-4-apres-kill.png') });
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await sshd2.close();
  }
});

test('mobile 375px : barre de commande (règles de risque) et vues Commandes / Admin', async (t) => {
  if (!browser) return t.skip('aucun navigateur disponible');
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(env.base);
  await uiLogin(page);
  await page.getByRole('heading', { name: 'Pi du salon' }).waitFor();
  await page.goto(`${env.base}/#/terminal`);
  await page.waitForFunction(() => document.querySelectorAll('.term-tab').length >= 1);
  const bar = page.getByLabel('Barre de commande');
  await bar.fill('rm -rf dossier-ui');
  await bar.press('Enter');
  await page.getByRole('heading', { name: 'Commande à risque' }).waitFor();
  await page.getByText('dangereuse').waitFor();
  await auditLayout(page, 'barre de commande');
  await page.screenshot({ path: path.join(OUT, 'mobile-11-risque.png') });
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await page.goto(`${env.base}/#/commands`);
  await page.getByRole('tab', { name: 'Multi-hôtes' }).click();
  await page.getByLabel('Commande', { exact: true }).fill('echo depuis-ui');
  await page.locator('.card label.check', { hasText: 'Pi du salon' }).click();
  await page.getByRole('button', { name: 'Exécuter' }).click();
  await page.locator('.exec-out', { hasText: 'depuis-ui' }).waitFor();
  await auditLayout(page, 'multi-hôtes');
  await page.goto(`${env.base}/#/admin`);
  await page.getByLabel('Hôte').selectOption({ label: 'Pi du salon' });
  await page.getByRole('tab', { name: 'Sudo' }).click();
  await page.getByText(/sudo -n|Aucun outil/).first().waitFor();
  await auditLayout(page, 'admin');
  assert.deepEqual(errors, []);
  await ctx.close();
});
