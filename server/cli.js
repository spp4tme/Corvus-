#!/usr/bin/env node
// Outils en ligne de commande : afficher / renouveler le token d'accès.
import path from 'node:path';
import { config } from './config.js';
import { loadToken, generateToken, Auth } from './lib/auth.js';
import { Vault } from './lib/vault.js';
import { ensureDir, writeFileSecure } from './lib/store.js';

const cmd = process.argv[2];
ensureDir(config.dataDir);

if (cmd === 'token') {
  const { token, created } = loadToken(config.dataDir);
  process.stdout.write(`${created ? '(nouveau) ' : ''}${token}\n`);
} else if (cmd === 'rotate-token') {
  const { token: old, file } = loadToken(config.dataDir);
  const vault = new Vault(path.join(config.dataDir, 'secrets.enc.json'), { token: old, passphrase: config.masterPassphrase });
  const next = generateToken();
  // Re-chiffrement des secrets AVANT d'écrire le nouveau token (si la clé dépend du token).
  vault.rekey({ token: next, passphrase: config.masterPassphrase });
  writeFileSecure(file, next + '\n');
  new Auth({ dataDir: config.dataDir, token: next, sessionTtlDays: 1 }).revokeAll();
  process.stdout.write(`Nouveau token (toutes les sessions ont été révoquées — redémarrez Corvus) :\n${next}\n`);
} else {
  process.stdout.write('Usage : node server/cli.js token | rotate-token\n');
  process.exit(1);
}
