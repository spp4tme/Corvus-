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
  await page.getByText(/Linux seulement, à vous de décider/).waitFor(); // pas de « SIGSTOP » promis là où le gel n'existe pas
  assert.equal(await page.getByText(/SIGSTOP/).count(), 0);

  // Linux complet : l'isolement est proposé normalement.
  await page.goto(`${env.base}/#/xray?host=${linuxId}`);
  await page.getByRole('tab', { name: 'Normal et anomalies' }).or(page.getByRole('button', { name: 'Normal et anomalies' })).first().click();
  await page.getByRole('button', { name: 'Isoler maintenant' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Isoler maintenant' }).isDisabled(), false);
  await page.getByText(/SIGSTOP, à vous de décider/).waitFor();
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

test('hôtes : badge « Windows » sur la carte et champ « Système de l\'hôte » dans le dialogue (valeur enregistrée)', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  env.corvus.ctx.hosts.setDetectedOs(hostId, 'windows'); // détection normalement faite par la sonde SSH
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  await uiLogin(page);
  const card = page.locator('.host-card', { hasText: 'Poste Windows' });
  await card.getByText('Windows', { exact: true }).waitFor();
  assert.equal(await page.locator('.host-card', { hasText: 'Serveur Linux' }).getByText('Windows', { exact: true }).count(), 0, 'pas de badge sur un hôte Linux');
  await card.getByRole('button', { name: 'Modifier' }).click();
  const sel = page.getByLabel('Système de l\'hôte');
  assert.equal(await sel.inputValue(), 'auto');
  await sel.selectOption('windows');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  assert.equal(env.corvus.ctx.hosts.find(hostId).os, 'windows', 'réglage enregistré côté serveur');
});

test('vue Agents : la commande d\'installation suit le système choisi (Linux, macOS expérimental, Windows sans Invoke-Expression)', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  await uiLogin(page);
  await page.goto(`${env.base}/#/agents`);
  const commande = async (systeme) => {
    await page.getByRole('button', { name: /Installer un agent/ }).first().click();
    await page.getByLabel('Système de l\'hôte').selectOption(systeme);
    if (systeme !== 'linux') await page.getByLabel(/Droits complets/).check(); // doit être ignoré hors Linux
    await page.getByRole('button', { name: 'Créer le jeton' }).click();
    const cmd = await page.locator('pre.code').innerText();
    await page.keyboard.press('Escape');
    await page.locator('dialog').waitFor({ state: 'detached' });
    return cmd;
  };
  const linux = await commande('linux');
  assert.match(linux, /^curl -fsSL .*\/api\/agent\/install\.sh \| sudo sh -s -- --server /);
  const mac = await commande('macos');
  assert.match(mac, /install\.sh/);
  assert.ok(!mac.includes('--full'), 'pas de droits complets sous macOS');
  const win = await commande('windows');
  assert.match(win, /^Invoke-WebRequest .*\/api\/agent\/install\.ps1 -OutFile install\.ps1; \.\\install\.ps1 -Server .* -Token /);
  assert.ok(!/Invoke-Expression|iex|\| *sh/i.test(win), 'jamais d\'exécution directe de contenu distant');
});

test('hôte « agent seul » : formulaire sans SSH, carte sans terminal ni fichiers, absent des sélecteurs SSH', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push(String(e)));
  await uiLogin(page);
  await page.goto(`${env.base}/#/hosts`);
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  const dlg = page.locator('dialog');
  await dlg.getByRole('tab', { name: 'Aucune (agent seul)' }).click();
  // Rien de SSH : ni utilisateur, ni port, ni mot de passe ; adresse facultative ; note explicative visible.
  await dlg.getByText(/aucun accès SSH, donc ni terminal/).waitFor();
  assert.equal(await dlg.getByLabel('Utilisateur').isVisible(), false);
  assert.equal(await dlg.getByLabel('Port').isVisible(), false);
  assert.equal(await dlg.getByLabel('Mot de passe').count(), 0);
  assert.equal(await dlg.getByRole('button', { name: 'Tester' }).isVisible(), false, 'rien à tester sans SSH');
  // Alias obligatoire.
  await dlg.getByRole('button', { name: 'Ajouter' }).click();
  await dlg.getByText(/Alias requis/).waitFor();
  await dlg.getByLabel('Alias').fill('PC du bureau');
  await dlg.getByRole('button', { name: 'Ajouter' }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });

  const carte = page.locator('.host-card', { hasText: 'PC du bureau' });
  await carte.waitFor();
  await carte.getByText('agent seul', { exact: true }).waitFor();
  assert.equal(await carte.getByText('secret manquant').count(), 0, 'pas de faux « secret manquant »');
  for (const nom of ['Terminal', 'Fichiers', 'Claude Code', 'Tester']) assert.equal(await carte.getByRole('button', { name: nom }).count(), 0, nom);
  await carte.getByRole('button', { name: /Installer l'agent/ }).waitFor();

  // Stocké sans aucun secret ni utilisateur.
  const h = env.corvus.ctx.hosts.hosts.find((x) => x.name === 'PC du bureau');
  assert.deepEqual([h.authType, h.username, h.hostname], ['none', '', '']);
  assert.ok(!env.corvus.ctx.vault.get(h.id));

  // Les écrans qui ouvrent du SSH ne le proposent pas ; l'écran Agents, si.
  await page.goto(`${env.base}/#/files`);
  await page.locator('select.select').first().waitFor();
  assert.equal(await page.locator('select.select option', { hasText: 'PC du bureau' }).count(), 0, 'absent du sélecteur Fichiers');
  await page.goto(`${env.base}/#/agents`);
  await page.getByRole('button', { name: 'Installer un agent' }).first().click();
  await page.locator('dialog select').first().selectOption({ label: 'PC du bureau' }); // proposé pour l'agent, sans « () »
  assert.deepEqual(erreurs, []);
});

test('hôte « agent seul » : passer un hôte à secrets en « agent seul » demande confirmation, annuler ne change rien', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const { hosts, vault } = env.corvus.ctx;
  const cree = hosts.create({ name: 'À basculer', hostname: '10.9.9.9', username: 'u', authType: 'password', password: 'secret-a-garder' });
  await env.corvus.ctx.hosts.get(cree.id);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  await uiLogin(page);
  await page.goto(`${env.base}/#/hosts`);
  await page.locator('.host-card', { hasText: 'À basculer' }).getByRole('button', { name: 'Modifier' }).click();
  await page.locator('dialog').getByRole('tab', { name: 'Aucune (agent seul)' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Effacer les secrets SSH ?').waitFor();
  await page.getByRole('button', { name: 'Annuler' }).last().click();
  assert.equal(vault.get(cree.id).password, 'secret-a-garder', 'annuler : secret intact');
  assert.equal(hosts.find(cree.id).authType, 'password');
  await page.locator('dialog').getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByRole('button', { name: 'Passer en agent seul' }).click();
  await page.waitForFunction(() => document.querySelectorAll('dialog').length === 0); // confirmation + formulaire fermés
  assert.equal(hosts.find(cree.id).authType, 'none');
  assert.deepEqual(vault.get(cree.id) || {}, {}, 'confirmé : secrets effacés');
});
