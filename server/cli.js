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
} else {
  process.stdout.write('Usage : node server/cli.js token | rotate-token\n');
  process.exit(1);
}
