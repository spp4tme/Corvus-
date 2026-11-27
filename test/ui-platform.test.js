// Interface réelle (navigateur headless) : un agent qui ne propose pas une fonction (Windows, macOS, Linux sans droits)
// ne la voit jamais « proposée puis en échec » — elle est masquée ou grisée, avec l'explication du serveur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startCorvus, freshCode } from './helpers/corvus.js';

let env; let browser; let hostId; let linuxId;

async function launch() {
  const channels = process.env.CORVUS_TEST_BROWSER ? [process.env.CORVUS_TEST_BROWSER] : ['msedge', 'chrome', 'chromium'];
  for (const channel of channels) { try { return await chromium.launch({ channel, headless: true }); } catch { /* suivant */ } }
  try { return await chromium.launch({ headless: true }); } catch { return null; }
}

async function uiLogin(page) {
  await page.goto(env.base);
  await page.getByLabel('Identifiant').fill(env.admin.username);
  await page.getByLabel('Mot de passe', { exact: true }).fill(env.admin.password);
  await page.getByLabel('Code à 6 chiffres').fill(freshCode(env.corvus, env.admin));
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.locator('.host-card').first().waitFor();
}

/** Agent enrôlé « à la main » dans la base : l'interface ne lit que ce que le serveur calcule (platform + capabilities). */
function addAgent(host, platform, capabilities) {
  env.corvus.ctx.db.run('INSERT INTO agents (id, host_id, public_key, version, capabilities, enrolled_at, platform) VALUES (?, ?, ?, ?, ?, ?, ?)',
    `a${host}`.slice(0, 24), host, 'AAAA', '1.2.0', JSON.stringify(capabilities), Date.now(), platform);
}

before(async () => {
  env = await startCorvus();
  const mk = async (name) => (await fetch(`${env.base}/api/hosts`, {
    method: 'POST', headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, hostname: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' }),
  }).then((r) => r.json())).host.id;
  hostId = await mk('Poste Windows');
  linuxId = await mk('Serveur Linux');
  // Windows : surveillance de fichiers seulement, rien d'autre.
  addAgent(hostId, 'windows', { files: false, xray: false, ransom: false, isolation: false, preview: false, fanotify: false, actions: [] });
  addAgent(linuxId, 'linux', {
    files: true, xray: true, ransom: true, isolation: true, preview: false, fanotify: true,
    actions: ['file.restore', 'file.remove', 'xray.live', 'proc.freeze', 'proc.thaw', 'proc.kill', 'net.status', 'net.isolate', 'net.release'],
  });
  browser = await launch();
});
after(async () => { await browser?.close(); await env?.close(); });

test('Radiographie, onglet Normal : isolement et gel grisés avec l\'explication Windows ; rien de grisé sur Linux complet', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await uiLogin(page);

  await page.goto(`${env.base}/#/xray?host=${hostId}`);
  await page.locator('h2.section-title', { hasText: 'Radiographie' }).waitFor();
  // Processus : la radiographie n'existe pas pour cet agent → explication, pas d'erreur.
  await page.getByText('Non disponible sur cet hôte').waitFor();
  await page.getByText(/lecture des processus/).waitFor();

  await page.getByRole('tab', { name: 'Normal et anomalies' }).or(page.getByRole('button', { name: 'Normal et anomalies' })).first().click();
  await page.getByText(/nftables/).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Isoler maintenant' }).isDisabled(), true, 'isolement grisé');
  assert.equal(await page.getByRole('button', { name: 'Lever l\'isolement' }).isDisabled(), true);
  for (const cb of await page.locator('input[type=checkbox]').all()) assert.equal(await cb.isDisabled(), true, 'réglages de défense grisés');
  assert.ok((await page.getByRole('button', { name: 'Isoler maintenant' }).getAttribute('title')).includes('nftables'), 'explication en infobulle');

  // Linux complet : l'isolement est proposé normalement.
  await page.goto(`${env.base}/#/xray?host=${linuxId}`);
  await page.getByRole('tab', { name: 'Normal et anomalies' }).or(page.getByRole('button', { name: 'Normal et anomalies' })).first().click();
  await page.getByRole('button', { name: 'Isoler maintenant' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Isoler maintenant' }).isDisabled(), false);
  assert.deepEqual(errors, []);
});

test('Rembobiner : l\'agent sans surveillance de fichiers reçoit une explication, pas une frise vide', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  await uiLogin(page);
  await page.goto(`${env.base}/#/rewind`);
  await page.locator('h2.section-title', { hasText: 'Rembobiner' }).waitFor();
  await page.getByRole('combobox').first().selectOption({ label: 'Poste Windows' });
  await page.getByText('Non disponible sur cet hôte').waitFor();
  await page.getByText(/surveillance de fichiers n'est pas active/).waitFor();
});

test('vue Agents : plateforme affichée, raisons des fonctions manquantes, macOS marqué expérimental', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const macId = (await fetch(`${env.base}/api/hosts`, { method: 'POST', headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Mac mini', hostname: '127.0.0.1', port: 22, username: 'u', authType: 'password', password: 'x' }) }).then((r) => r.json())).host.id;
  addAgent(macId, 'macos', { files: true, xray: true, actions: ['xray.live'] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  await uiLogin(page);
  await page.goto(`${env.base}/#/agents`);
  await page.getByText('Mac mini').waitFor();
  const mac = page.locator('li', { hasText: 'Mac mini' });
  await mac.getByText('macOS', { exact: true }).waitFor();
  await mac.getByText('expérimental', { exact: true }).waitFor();
  await mac.getByText(/aucune machine réelle/).waitFor();
  const win = page.locator('li', { hasText: 'Poste Windows' });
  await win.getByText('Windows', { exact: true }).waitFor();
  assert.equal(await win.getByText('expérimental', { exact: true }).count(), 0, 'Windows n\'est pas marqué expérimental');
  await win.getByText(/nftables/).waitFor();
});
