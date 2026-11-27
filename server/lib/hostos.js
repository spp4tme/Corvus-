// Système d'un hôte SSH (POSIX ou Windows). Corvus construit TOUTES ses commandes distantes pour un shell POSIX
// (`sh -c`, quotes simples, /proc, systemd…). Sur un hôte Windows (OpenSSH Server pour Windows, shell cmd.exe ou
// PowerShell) elles échoueraient de façon obscure, ou pire : un argument échappé à la POSIX serait mal interprété par
// cmd/PowerShell. Plutôt que d'adapter (et de maintenir deux jeux d'échappement), les fonctions qui supposent un shell
// POSIX sont DÉSACTIVÉES pour ces hôtes, avec un message clair. Le terminal interactif et SFTP, eux, restent disponibles.
//
// La détection INFORME et RESTREINT ; elle n'accorde jamais un droit : un hôte qui mentirait en se disant Windows perd des
// fonctions, il n'en gagne aucune.
import { HttpError } from './validate.js';

/**
 * Sonde valable dans cmd.exe, PowerShell ET sh/bash/zsh/fish, sans erreur de syntaxe dans aucun :
 *   cmd.exe     → corvus-os:Windows_NT:$env:OS
 *   PowerShell  → corvus-os:%OS%:Windows_NT
 *   sh & co     → corvus-os:%OS%::OS
 * (Cygwin/MSYS : un shell POSIX, donc traité comme POSIX — ce qui est juste.)
 */
export const OS_PROBE = 'echo corvus-os:%OS%:$env:OS';

/** @returns {'windows'|'posix'|null} null = pas de marqueur (réponse inexploitable : on ne conclut rien). */
export function classifyOs(output) {
  const text = Buffer.isBuffer(output) ? output.subarray(0, 4096).toString('utf8') : String(output ?? '').slice(0, 4096);
  const m = /corvus-os:([^\r\n]*)/.exec(text);
  if (!m) return null;
  return m[1].includes('Windows_NT') ? 'windows' : 'posix';
}

/** Système effectif : réglage explicite de l'administrateur, sinon détection ; null = inconnu (traité comme POSIX). */
export function effectiveOs(host) {
  if (host?.os === 'posix' || host?.os === 'windows') return host.os;
  if (host?.osDetected === 'posix' || host?.osDetected === 'windows') return host.osDetected;
  return null;
}

export const POSIX_ONLY_MESSAGE = 'Cet hôte tourne sous Windows : cette fonction repose sur un shell POSIX (sh, /proc, systemd…) '
  + 'et n\'est pas disponible. Le terminal et les fichiers (SFTP) restent utilisables.';

export const posixOnly = () => new HttpError(409, 'POSIX_ONLY', POSIX_ONLY_MESSAGE);
