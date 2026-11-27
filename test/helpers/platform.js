// Capacités de la machine qui exécute les tests. Un test qui en dépend est SAUTÉ avec une raison écrite
// (jamais passé sous silence) : sous Windows, créer un lien symbolique exige le mode développeur ou un
// droit particulier, et un nom de fichier ne peut pas contenir « : ».
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function probeSymlink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'cible'), 'x');
    fs.symlinkSync(path.join(dir, 'cible'), path.join(dir, 'lien'));
    return true;
  } catch { return false; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export const canSymlink = probeSymlink();
export const canColonNames = process.platform !== 'win32';

export const skipUnlessSymlink = canSymlink ? false : 'liens symboliques non créables sur cette machine (Windows sans mode développeur)';
export const skipUnlessColonNames = canColonNames ? false : 'Windows interdit « : » dans un nom de fichier';
