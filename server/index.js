#!/usr/bin/env node
// Point d'entrée : `npm start`.
import { createCorvus } from './app.js';
import { config } from './config.js';
import { classifyAddress } from './lib/netcheck.js';
import { logger } from './lib/log.js';

const log = logger('corvus');

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  log.error(`Node.js ${process.versions.node} détecté : Corvus requiert Node.js 20 ou plus récent.`);
  process.exit(1);
}

const kind = classifyAddress(config.bind);
if (kind === 'public' && !config.allowPublicBind) {
  log.error(`BIND=${config.bind} est une adresse PUBLIQUE. Corvus est un shell distant : ne l'exposez jamais sur Internet.`);
  log.error('Utilisez 127.0.0.1 (+ tailscale serve) ou votre IP Tailscale 100.x.y.z.');
  process.exit(1);
}

let corvus;
try {
  corvus = createCorvus();
} catch (err) {
  log.error(`Démarrage impossible : ${err.message}`);
  process.exit(1);
}

try {
  const addr = await corvus.listen();
  const shown = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  log.info(`Corvus ${corvus.ctx.version} à l'écoute sur http://${shown}:${addr.port}`);
  log.info(`Données : ${config.dataDir} — secrets chiffrés (clé dérivée ${config.masterPassphrase ? 'de la passphrase maître' : 'du token'})`);
  if (kind === 'any') {
    log.warn('BIND sur toutes les interfaces : assurez-vous qu\'un pare-feu limite l\'accès au réseau Tailscale (tailscale0).');
  } else if (kind === 'private' || kind === 'hostname') {
    log.warn(`BIND=${config.bind} : Corvus est joignable depuis ce réseau. Préférez 127.0.0.1 + tailscale serve.`);
  }
  if (corvus.ctx.tokenCreated) {
    const line = '='.repeat(64);
    process.stdout.write(`\n${line}\n  PREMIER LANCEMENT — token d'accès Corvus (à coller dans l'app) :\n\n  ${corvus.ctx.token}\n\n  Réaffichable avec : npm run token   (fichier data/token, chmod 600)\n${line}\n\n`);
  } else {
    log.info('Token d\'accès : `npm run token` pour l\'afficher.');
  }
} catch (err) {
  log.error(`Écoute impossible sur ${config.bind}:${config.port} : ${err.message}`);
  process.exit(1);
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} reçu, arrêt…`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  await corvus.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('Promesse rejetée non gérée', err));
