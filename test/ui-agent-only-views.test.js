// Correctif 1.3.1 : (1) les vues secondaires (Agents, Rembobiner, Radiographie, Playbooks, Comparer, Services web) sont accessibles sur ORDINATEUR (la barre
// latérale ne les proposait pas : elles n'existaient que dans « Plus », réservé au mobile) ; (2) un hôte « agent seul » a un écran de métriques (Supervision).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startCorvus, freshCode } from './helpers/corvus.js';

let env; let browser; let solo;

async function launch() {
  const channels = process.env.CORVUS_TEST_BROWSER ? [process.env.CORVUS_TEST_BROWSER] : ['msedge', 'chrome', 'chromium'];
  for (const channel of channels) { try { return await chromium.launch({ channel, headless: true }); } catch { /* suivant */ } }
  try { return await chromium.launch({ headless: true }); } catch { return null; }
}
async function login(page) {
  await page.goto(env.base);
  await page.getByLabel('Identifiant').fill(env.admin.username);
  await page.getByLabel('Mot de passe', { exact: true }).fill(env.admin.password);
  await page.getByLabel('Code à 6 chiffres').fill(freshCode(env.corvus, env.admin));
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.locator('.host-card').first().waitFor();
}

before(async () => {
  env = await startCorvus();
  const { hosts, db } = env.corvus.ctx;
  solo = hosts.create({ name: 'PC du bureau', authType: 'none' });
  db.run('INSERT INTO agents (id, host_id, public_key, version, capabilities, enrolled_at, platform, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'agentwin0000000000000001', solo.id, 'AAAA', '1.3.0', JSON.stringify({ files: true, xray: true, actions: ['xray.live'] }), Date.now(), 'windows', Date.now());
  // Dix minutes de métriques telles que les envoie l'agent Windows (cpu, mem, df:<disque>, net:rx/tx).
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    const ts = now - (20 - i) * 30_000;
    for (const [metric, value] of Object.entries({ cpu: 10 + i, mem: 55, swap: 5, 'df:C:': 71.5, 'net:rx': 20_000 + i * 100, 'net:tx': 5_000, uptime: 1000 + i })) {
      db.run('INSERT OR REPLACE INTO metrics_raw (host_id, metric, ts, value) VALUES (?, ?, ?, ?)', solo.id, metric, ts, value);
    }
  }
  browser = await launch();
});
after(async () => { await browser?.close(); await env?.close(); });

test('ORDINATEUR : la barre latérale propose Playbooks, Comparer, Agents, Rembobiner, Radiographie et Services web', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await login(page);
  const nav = page.getByRole('navigation', { name: 'Navigation principale' });
  for (const nom of ['Playbooks', 'Comparer', 'Agents', 'Rembobiner', 'Radiographie', 'Services web', 'Journal', 'Supervision']) {
    assert.ok(await nav.getByRole('link', { name: nom }).first().isVisible(), `« ${nom} » absent de la barre latérale sur ordinateur`);
  }
  await nav.getByRole('link', { name: 'Rembobiner' }).click();
  await page.waitForURL(/#\/rewind/);
  await nav.getByRole('link', { name: 'Playbooks' }).click();
  await page.waitForURL(/#\/playbooks/);
  assert.deepEqual(errors, []);
});

test('MOBILE : « Plus » liste aussi Playbooks, et la barre du bas reste celle d\'avant', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const page = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  await login(page);
  await page.goto(`${env.base}/#/more`);
  for (const nom of ['Playbooks', 'Agents', 'Rembobiner', 'Radiographie', 'Comparer']) await page.getByText(nom, { exact: true }).first().waitFor();
});

test('hôte « agent seul » : Supervision affiche les métriques de l\'agent (CPU, mémoire, disque, réseau), sans onglets SSH', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await login(page);
  // depuis la carte de l'hôte : le bouton « Métriques » mène à Supervision avec cet hôte choisi
  const carte = page.locator('.host-card', { hasText: 'PC du bureau' });
  await carte.getByRole('button', { name: 'Métriques' }).click();
  await page.waitForURL(/#\/monitor/);
  await page.getByText('Hôte « agent seul »').waitFor();
  await page.getByText(/Agent HORS LIGNE/).waitFor(); // l'agent de ce test n'est pas connecté : on le dit, et on montre les dernières métriques
  await page.locator('.tiles').waitFor();
  await page.getByText('Disque C:', { exact: true }).waitFor();
  await page.locator('.tile', { hasText: 'Disque C:' }).getByText('72 %').waitFor(); // disque à 71,5 %
  assert.ok((await page.locator('.charts > *').count()) >= 4, 'graphiques CPU, mémoire, réseau, disques');
  // pas d'onglets SSH (Système / Processus / Docker) pour cet hôte
  assert.equal(await page.getByRole('tab', { name: 'Docker' }).isVisible().catch(() => false), false);
  assert.equal(await page.getByRole('tab', { name: 'Processus' }).isVisible().catch(() => false), false);
  // l'hôte est bien dans le sélecteur de Supervision (il n'y était pas : le sélecteur SSH l'excluait)
  assert.ok(await page.locator('select.select option', { hasText: 'PC du bureau' }).count() >= 1);
  assert.deepEqual(errors, []);
});

test('hôte « agent seul » sans aucune métrique reçue : message clair (agent absent, ou connecté mais en attente)', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const vide = env.corvus.ctx.hosts.create({ name: 'PC sans agent', authType: 'none' });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  await login(page);
  await page.goto(`${env.base}/#/hosts`);
  const carte = page.locator('.host-card', { hasText: 'PC sans agent' });
  await carte.getByRole('button', { name: /Installer l'agent/ }).waitFor();
  assert.equal(await carte.getByRole('button', { name: 'Métriques' }).count(), 0, 'pas de bouton Métriques tant qu\'aucun agent n\'existe');
  env.corvus.ctx.hosts.get(vide.id);
});
