// Interface Playbooks dans un vrai navigateur : interrupteur, éditeur à validation en direct, lancement confirmé, historique, sortie affichée
// comme TEXTE (jamais interprétée), arrêt d'urgence, hôtes indisponibles grisés, et un lecteur qui ne voit que l'historique.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startCorvus, freshCode, CorvusClient, makeUser } from './helpers/corvus.js';
import { startFakeSshd } from './helpers/fake-sshd.js';

let env; let sshd; let browser; let linux; let win; let solo;

async function launch() {
  const channels = process.env.CORVUS_TEST_BROWSER ? [process.env.CORVUS_TEST_BROWSER] : ['msedge', 'chrome', 'chromium'];
  for (const channel of channels) { try { return await chromium.launch({ channel, headless: true }); } catch { /* suivant */ } }
  try { return await chromium.launch({ headless: true }); } catch { return null; }
}
async function login(page, user) {
  await page.goto(env.base);
  await page.getByLabel('Identifiant').fill(user.username);
  await page.getByLabel('Mot de passe', { exact: true }).fill(user.password);
  await page.getByLabel('Code à 6 chiffres').fill(freshCode(env.corvus, user));
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await page.locator('.host-card').first().waitFor();
}
const newPage = async () => {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { page, errors };
};

before(async () => {
  sshd = await startFakeSshd();
  env = await startCorvus({ rateBackupPerMin: 1000 });
  const { hosts } = env.corvus.ctx;
  linux = hosts.create({ name: 'Serveur Linux', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
  win = hosts.create({ name: 'Poste Windows', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password, os: 'windows' });
  solo = hosts.create({ name: 'PC agent seul', authType: 'none' });
  browser = await launch();
});
after(async () => { await browser?.close(); await env?.close(); await sshd?.close(); });

test('Playbooks : désactivé par défaut, création avec validation en direct, activation confirmée, lancement, historique, sortie affichée comme TEXTE', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const { page, errors } = await newPage();
  await login(page, env.admin);
  await page.goto(`${env.base}/#/playbooks`);
  await page.getByText('désactivée', { exact: false }).first().waitFor();
  assert.equal(env.corvus.ctx.automation.enabled, false);
  await page.getByRole('button', { name: 'Arrêt d\'urgence' }).waitFor();

  // Création : JSON invalide → erreur immédiate ; JSON valide → validation serveur en direct (risque affiché), enregistrement possible.
  await page.getByRole('button', { name: 'Nouveau playbook' }).click();
  const dlg = page.locator('dialog');
  const editor = dlg.getByLabel('Définition du playbook (JSON)');
  await editor.fill('{ pas du json');
  await dlg.getByText('JSON invalide').waitFor();
  assert.equal(await dlg.getByRole('button', { name: 'Créer' }).isDisabled(), true, 'impossible d\'enregistrer un JSON invalide');
  const piege = '<img src=x onerror="window.__pwn=1">';
  const def = {
    name: 'Dire bonjour', description: 'test navigateur', params: [{ name: 'texte', type: 'string', max: 100 }],
    steps: [{ name: 'echo', run: 'printf "%s" {{texte}}' }], targets: { hostIds: [linux.id] },
  };
  await editor.fill(JSON.stringify(def));
  await dlg.getByText(/Valide · risque/).waitFor();
  // Hôte Windows ou agent seul : jamais proposé comme cible, avec l'explication.
  const options = await dlg.locator('select option').allTextContents();
  assert.ok(options.some((o) => /Poste Windows — indisponible : hôte Windows/.test(o)), JSON.stringify(options));
  assert.ok(options.some((o) => /PC agent seul — indisponible/.test(o)));
  await editor.fill(JSON.stringify({ ...def, targets: { hostIds: [win.id] } }));
  await dlg.locator('.test-result.ko', { hasText: /hôte Windows/ }).waitFor(); // refus du serveur affiché en direct
  assert.equal(await dlg.getByRole('button', { name: 'Créer' }).isDisabled(), true);
  await editor.fill(JSON.stringify(def));
  await dlg.getByText(/Valide · risque/).waitFor();
  await dlg.getByRole('button', { name: 'Créer' }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await page.getByText('Dire bonjour').waitFor();

  // « Lancer » grisé tant que l'automatisation est désactivée.
  assert.equal(await page.getByRole('button', { name: 'Lancer' }).first().isDisabled(), true);
  // Activation : confirmation explicite.
  await page.getByRole('button', { name: 'Activer l\'automatisation' }).click();
  await page.getByText('Activer l\'automatisation ?').waitFor();
  await page.getByRole('button', { name: 'Activer', exact: true }).click();
  for (let i = 0; i < 60 && !env.corvus.ctx.automation.enabled; i++) await page.waitForTimeout(100); // « activée » est aussi contenu dans « désactivée » : on attend l'état réel
  assert.equal(env.corvus.ctx.automation.enabled, true);
  await page.locator('p', { hasText: /Automatisation\s+activée/ }).waitFor();

  // Lancement avec un paramètre qui ressemble à du HTML : il doit s'afficher tel quel, sans jamais s'exécuter.
  await page.getByRole('button', { name: 'Lancer' }).first().click();
  const run = page.locator('dialog');
  await run.getByLabel('texte').fill(piege);
  await run.getByRole('button', { name: 'Lancer', exact: true }).click();
  await page.locator('dialog >> text=Détails du lancement').waitFor();
  await page.locator('pre.code', { hasText: 'img src=x' }).waitFor();
  assert.equal(await page.locator('pre.code', { hasText: 'img src=x' }).first().innerText(), piege, 'affiché comme texte');
  assert.equal(await page.locator('dialog img').count(), 0, 'aucune balise HTML créée à partir de la sortie');
  assert.equal(await page.evaluate(() => window.__pwn), undefined, 'aucun script exécuté');
  await page.getByText('réussi').first().waitFor();
  assert.deepEqual(errors, []);
});

test('Playbooks : un playbook « danger » demande une confirmation avant de partir ; annuler n\'exécute rien', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  env.corvus.ctx.automation.setEnabled(true, {});
  const pb = env.corvus.ctx.automation.create({ name: 'Dangereux', steps: [{ run: 'rm -rf ~/dossier-inexistant-ui' }], targets: { hostIds: [linux.id] } }, {});
  const { page } = await newPage();
  await login(page, env.admin);
  await page.goto(`${env.base}/#/playbooks`);
  const row = page.locator('li', { hasText: 'Dangereux' });
  await row.getByText('danger', { exact: true }).waitFor();
  const avant = sshd.stats.execs.length;
  await row.getByRole('button', { name: 'Lancer' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Lancer', exact: true }).click();
  await page.getByText(/Playbook à risque « danger »/).waitFor();
  await page.getByRole('button', { name: 'Annuler' }).last().click();
  await page.waitForTimeout(400);
  assert.equal(sshd.stats.execs.length, avant, 'annuler la confirmation : rien n\'a été exécuté');
  assert.equal(env.corvus.ctx.db.get('SELECT COUNT(*) AS n FROM playbook_runs WHERE playbook_id = ?', pb.id).n, 0);
});

test('Playbooks : un playbook dont l\'hôte est devenu Windows a « Lancer » grisé avec l\'explication', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const pb = env.corvus.ctx.automation.create({ name: 'Bientôt Windows', steps: [{ run: 'echo x' }], targets: { hostIds: [linux.id] } }, {});
  env.corvus.ctx.hosts.update(linux.id, { os: 'windows' });
  try {
    const { page } = await newPage();
    await login(page, env.admin);
    await page.goto(`${env.base}/#/playbooks`);
    const row = page.locator('li', { hasText: 'Bientôt Windows' });
    await row.getByText(/hôte Windows/).waitFor();
    assert.equal(await row.getByRole('button', { name: 'Lancer' }).isDisabled(), true);
    assert.ok(pb.id);
  } finally { env.corvus.ctx.hosts.update(linux.id, { os: 'auto' }); }
});

test('Playbooks : un lecteur ne voit que l\'historique (ni playbooks, ni administration, ni arrêt d\'urgence)', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  const u = makeUser(env.corvus, { username: 'lecteur-ui', password: 'mot-de-passe-lecteur-ui', role: 'viewer' });
  env.corvus.ctx.users.setGrants(u.id, [{ scope: 'host', target: linux.id, role: 'viewer' }]);
  const { page } = await newPage();
  await login(page, u);
  await page.goto(`${env.base}/#/playbooks`);
  await page.getByRole('tab', { name: 'Historique' }).waitFor();
  for (const nom of ['Playbooks', 'Planifications', 'Alertes', 'Webhooks', 'Secrets', 'Webhook sortant']) assert.equal(await page.getByRole('tab', { name: nom, exact: true }).count(), 0, nom);
  assert.equal(await page.getByRole('button', { name: 'Arrêt d\'urgence' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /automatisation/ }).count(), 0, 'pas d\'interrupteur pour un lecteur');
  void CorvusClient;
});

test('Playbooks : arrêt d\'urgence — confirmation, puis le lancement en cours est interrompu', async (t) => {
  if (!browser) return t.skip('aucun navigateur Chromium/Edge disponible');
  env.corvus.ctx.automation.setEnabled(true, {});
  const pb = env.corvus.ctx.automation.create({ name: 'Très long', steps: [{ run: 'sleep 20' }], targets: { hostIds: [linux.id] } }, {});
  const { page } = await newPage();
  await login(page, env.admin);
  await page.goto(`${env.base}/#/playbooks`);
  const started = await env.corvus.ctx.automationRuns.start({ playbookId: pb.id, trigger: 'manual', user: { id: 'u', username: 'admin', role: 'admin' } });
  await page.getByRole('button', { name: 'Arrêt d\'urgence' }).click();
  await page.getByText('Tous les playbooks en cours reçoivent l\'ordre').waitFor();
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Tout arrêter' }).click();
  for (let i = 0; i < 100 && env.corvus.ctx.db.get('SELECT status FROM playbook_runs WHERE id = ?', started.runId).status === 'running'; i++) await page.waitForTimeout(50);
  assert.equal(env.corvus.ctx.db.get('SELECT status FROM playbook_runs WHERE id = ?', started.runId).status, 'cancelled');
  assert.ok(Date.now() - t0 < 8000);
});
