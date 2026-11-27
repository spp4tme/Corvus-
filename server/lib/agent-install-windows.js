// Script d'installation de l'agent pour Windows, servi par Corvus (GET /api/agent/install.ps1, public, comme install.sh).
// Le texte vit dans server/assets/install.ps1 (le Dockerfile copie tout server/). Aucun secret : le jeton à usage unique
// est passé en paramètre, et le script valide ses paramètres. Il télécharge le binaire de la MÊME version que ce Corvus
// et vérifie son SHA-256 avant de l'exécuter.
import fs from 'node:fs';

const TEMPLATE = fs.readFileSync(new URL('../assets/install.ps1', import.meta.url), 'utf8');
const BOM = '﻿'; // Windows PowerShell 5.1 lit un fichier sans BOM en ANSI : les accents seraient abîmés

export function installScriptWindows(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('version invalide');
  return BOM + TEMPLATE.replaceAll('@@VERSION@@', version);
}
