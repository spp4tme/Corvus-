// Test d'interface réel : navigateur headless (Edge/Chrome via playwright-core, sans téléchargement),
// viewport mobile 375 px et desktop. Ignoré si aucun navigateur n'est disponible.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus } from './helpers/corvus.js';

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
  await page.getByLabel('Token d\'accès').fill(env.token);
  await page.getByRole('button', { name: 'Se connecter' }).click();
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
  await page.getByLabel('Token d\'accès').fill(env.token);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByRole('heading', { name: 'Pi du salon' }).waitFor();
  await page.getByRole('button', { name: 'Fichiers' }).first().click();
  await page.getByRole('button', { name: 'Nouveau dossier' }).waitFor();

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

  await page.getByText('notes.md', { exact: true }).click();
  const editor = page.getByLabel(/Contenu de/);
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
  await page.getByLabel('Token d\'accès').fill(env.token);
  await page.getByRole('button', { name: 'Se connecter' }).click();
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

test('desktop 1280px : rail latéral et reprise des onglets après rechargement', async (t) => {
  if (!browser) return t.skip('aucun navigateur disponible');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(env.base);
  await page.getByLabel('Token d\'accès').fill(env.token);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByRole('heading', { name: 'Pi du salon' }).waitFor();
  const nav = await page.locator('.app-nav').boundingBox();
  assert.ok(nav.height > nav.width, 'la navigation doit être un rail vertical sur desktop');
  await page.getByRole('link', { name: 'Terminal' }).click();
  // la session ouverte par le test mobile est restaurée
  await page.waitForFunction(() => document.querySelectorAll('.term-tab').length >= 1);
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('ui-42'), null, { timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, 'desktop-terminal.png') });
  await auditLayout(page, 'desktop terminal');
  await ctx.close();
});
