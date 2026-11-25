#!/usr/bin/env node
// Point d'entrée : `npm start`.
import { config } from './config.js';
import { classifyAddress } from './lib/netcheck.js';
import { logger } from './lib/log.js';
import { tailscalePeers } from './lib/tailscale.js';

const log = logger('corvus');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  log.error(`Node.js ${process.versions.node} détecté : Corvus requiert Node.js 22.13 ou plus récent (module SQLite intégré). Node 24 LTS recommandé.`);
  process.exit(1);
}

// Le module SQLite de Node affiche un avertissement « expérimental » à chaque démarrage : masqué.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message ?? w)) ? undefined : emitWarning.call(process, w, ...rest));
// Import dynamique : sur un Node trop ancien, le message ci-dessus s'affiche au lieu d'une erreur d'import.
const { createCorvus } = await import('./app.js');

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
  log.info(`Données : ${config.dataDir}${corvus.ctx.storage.custom ? ` · stockage : ${corvus.ctx.storage.dir}` : ''} — secrets chiffrés (clé dérivée ${config.masterPassphrase ? 'de la passphrase maître' : 'du token'})`);
  if (!config.masterPassphrase) {
    log.warn('Secrets chiffrés avec une clé dérivée du token (stocké dans le même dossier) : voler data/ donne accès aux secrets. Définissez CORVUS_MASTER_PASSPHRASE pour une vraie protection au repos.');
  }
  if (kind === 'any') {
    log.warn('BIND sur toutes les interfaces : assurez-vous qu\'un pare-feu limite l\'accès au réseau Tailscale (tailscale0).');
  } else if (kind === 'private' || kind === 'hostname') {
    log.warn(`BIND=${config.bind} : Corvus est joignable depuis ce réseau. Préférez 127.0.0.1 + tailscale serve.`);
  }
  // Origine MagicDNS de cette machine (https://<machine>.<tailnet>.ts.net) autorisée automatiquement,
  // pour que `tailscale serve` fonctionne sans configuration.
  tailscalePeers(config.tailscaleBin).then(({ peers }) => {
    const self = peers.find((p) => p.self);
    if (self?.dnsName) {
      const origin = `https://${self.dnsName}`;
      if (!corvus.config.allowedOrigins.includes(origin)) corvus.config.allowedOrigins.push(origin);
      log.info(`Tailscale détecté : accès recommandé via ${origin} (tailscale serve)`);
    }
  }).catch(() => log.info('CLI tailscale absent : définissez CORVUS_ALLOWED_ORIGINS si vous passez par un reverse-proxy.'));
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
