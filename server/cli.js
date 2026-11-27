#!/usr/bin/env node
// Outils en ligne de commande : afficher / renouveler le token d'amorçage.
import { config } from './config.js';
import { loadToken, generateToken } from './lib/auth.js';
import { ensureDir, writeFileSecure } from './lib/store.js';

const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message ?? w)) ? undefined : emitWarning.call(process, w, ...rest));

const cmd = process.argv[2];
ensureDir(config.dataDir);

if (cmd === 'token') {
  const { token, created } = loadToken(config.dataDir);
  process.stdout.write(`${created ? '(nouveau) ' : ''}${token}\n`);
} else if (cmd === 'rotate-token') {
  const { Db } = await import('./db/index.js');
  const { Vault } = await import('./lib/vault.js');
  const { resolveStorage } = await import('./lib/storage.js');
  const { token: old, file } = loadToken(config.dataDir);
  const db = new Db(resolveStorage(config).dbFile);
  const vault = new Vault(db, { token: old, passphrase: config.masterPassphrase });
  const next = generateToken();
  // Ré-emballage de la clé des secrets AVANT d'écrire le nouveau token (si elle dépend du token).
  vault.rekey({ token: next, passphrase: config.masterPassphrase });
  writeFileSecure(file, next + '\n');
  db.run('DELETE FROM auth_sessions');
  db.close();
  process.stdout.write(`Nouveau token (toutes les sessions ont été révoquées — redémarrez Corvus) :\n${next}\n`);
} else if (cmd === 'journal-head') {
  // Empreinte de tête du journal d'audit : à NOTER (ou exporter) pour détecter plus tard une réécriture complète de la
  // chaîne par quelqu'un qui aurait les droits root sur ce serveur. Sortie : 0 = chaîne intacte, 2 = chaîne rompue.
  const { Db } = await import('./db/index.js');
  const { Journal } = await import('./lib/journal.js');
  const { resolveStorage } = await import('./lib/storage.js');
  const db = new Db(resolveStorage(config).dbFile);
  const journal = new Journal(db);
  const head = journal.head();
  const check = journal.verify();
  db.close();
  process.stdout.write([
    `Empreinte de tête : ${head.hash}`,
    `Entrées : ${check.count}`,
    `Dernière entrée : ${head.ts ? new Date(head.ts).toISOString() : '(aucune)'}`,
    check.ok ? 'Chaîne : intacte' : `Chaîne : ROMPUE à l'entrée ${check.brokenAt} (${check.reason})`,
    'Notez cette empreinte ailleurs que sur ce serveur : elle permet de prouver plus tard que le journal n\'a pas été réécrit.',
  ].join('\n') + '\n');
  process.exit(check.ok ? 0 : 2);
} else {
  process.stdout.write('Usage : node server/cli.js token | rotate-token | journal-head\n');
  process.exit(1);
}
