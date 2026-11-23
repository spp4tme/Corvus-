#!/usr/bin/env node
// Génère les icônes PNG de la PWA à partir de public/icons/logo.svg (Edge/Chrome headless).
// Usage : npm run icons   (nécessite playwright-core en devDependency + un navigateur Chromium installé)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public', 'icons');
const svg = fs.readFileSync(path.join(dir, 'logo.svg'), 'utf8');
const BG = '#141821';

// [fichier, taille, fond plein, échelle du logo]
const ICONS = [
  ['icon-192.png', 192, false, 1],
  ['icon-512.png', 512, false, 1],
  ['icon-maskable-512.png', 512, true, 0.72], // zone de sécurité « maskable » : cercle de 80 %
  ['apple-touch-icon.png', 180, true, 0.86],  // iOS remplit la transparence en noir : fond plein
];

let browser;
for (const channel of ['msedge', 'chrome', 'chromium']) {
  try { browser = await chromium.launch({ channel, headless: true }); break; } catch { /* suivant */ }
}
if (!browser) {
  console.error('Aucun navigateur Chromium/Edge trouvé.');
  process.exit(1);
}
const page = await browser.newPage();
for (const [file, size, filled, scale] of ICONS) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * scale);
  const html = `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${filled ? BG : 'transparent'}">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`;
  await page.setContent(html);
  await page.screenshot({ path: path.join(dir, file), omitBackground: !filled });
  console.log(`✔ ${file} (${size}×${size})`);
}
await browser.close();
