#!/usr/bin/env node
// Génère public/icons/logo.svg : un corbeau de profil, plume par plume, dans un médaillon à graduations.
// Tout est calculé ici (aucune image externe) : relancer le script régénère le même fichier.
// Usage : node scripts/make-logo.mjs && npm run icons
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'icons', 'logo.svg');
const f = (n) => Math.round(n * 10) / 10;

// Petit générateur pseudo-aléatoire (graine fixe : le dessin est toujours identique).
let seed = 20261126;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

const C = 256; // centre du médaillon (viewBox 512)
const parts = [];
const add = (s) => parts.push(s);

// ---- Silhouette de la tête (profil tourné vers la droite) ----
const HEAD = 'M446 236 C416 198 374 170 336 150 C312 118 268 98 222 108 C170 120 132 164 122 222 C110 290 96 340 92 396 '
  + 'C150 420 218 424 270 404 C292 366 300 330 318 300 C336 286 352 280 366 274 C400 270 430 256 446 236 Z';
const BEAK_UP = 'M446 236 C416 198 374 170 336 150 C340 176 346 204 350 232 C380 246 418 248 446 236 Z';
const BEAK_LOW = 'M350 232 C380 246 418 248 446 236 C430 256 400 270 366 274 C354 266 348 250 350 232 Z';

// ---- Définitions ----
add(`<defs>
  <linearGradient id="holo" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7df9d0"/><stop offset="0.4" stop-color="#b794ff"/>
    <stop offset="0.75" stop-color="#ff8fcf"/><stop offset="1" stop-color="#ffd27a"/>
  </linearGradient>
  <linearGradient id="holo2" x1="1" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffd27a"/><stop offset="0.35" stop-color="#ff8fcf"/>
    <stop offset="0.7" stop-color="#b794ff"/><stop offset="1" stop-color="#7df9d0"/>
  </linearGradient>
  <linearGradient id="plume" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#2a2540"/><stop offset="0.55" stop-color="#14111f"/><stop offset="1" stop-color="#0c0a14"/>
  </linearGradient>
  <linearGradient id="bec" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#3a3354"/><stop offset="1" stop-color="#0b0912"/>
  </linearGradient>
  <radialGradient id="fond" cx="0.5" cy="0.42" r="0.75">
    <stop offset="0" stop-color="#241d3a"/><stop offset="0.6" stop-color="#110e1c"/><stop offset="1" stop-color="#07060b"/>
  </radialGradient>
  <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="#b794ff" stop-opacity="0.38"/><stop offset="0.6" stop-color="#7df9d0" stop-opacity="0.1"/><stop offset="1" stop-color="#b794ff" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="oeil" cx="0.4" cy="0.35" r="0.7">
    <stop offset="0" stop-color="#fff6c8"/><stop offset="0.45" stop-color="#ffd27a"/><stop offset="1" stop-color="#c2701a"/>
  </radialGradient>
  <clipPath id="tete"><path d="${HEAD}"/></clipPath>
  <clipPath id="medaillon"><circle cx="${C}" cy="${C}" r="196"/></clipPath>
  <filter id="lueur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
</defs>`);

// ---- Fond : carré arrondi, halo, bordure holographique ----
add('<rect x="8" y="8" width="496" height="496" rx="112" fill="url(#fond)"/>');
add(`<circle cx="${C}" cy="${C}" r="236" fill="url(#halo)"/>`);
add('<rect x="14" y="14" width="484" height="484" rx="106" fill="none" stroke="url(#holo)" stroke-width="5" opacity="0.85"/>');
add('<rect x="26" y="26" width="460" height="460" rx="94" fill="none" stroke="url(#holo2)" stroke-width="1.2" opacity="0.4"/>');

// Étoiles discrètes dans les coins
for (let i = 0; i < 46; i++) {
  const a = rnd() * Math.PI * 2; const r = 205 + rnd() * 50;
  const x = C + Math.cos(a) * r; const y = C + Math.sin(a) * r;
  if (x < 40 || x > 472 || y < 40 || y > 472) continue;
  add(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(0.7 + rnd() * 1.5)}" fill="#fff" opacity="${f(0.2 + rnd() * 0.5)}"/>`);
}

// ---- Anneau gradué ----
add(`<circle cx="${C}" cy="${C}" r="212" fill="none" stroke="url(#holo)" stroke-width="3"/>`);
add(`<circle cx="${C}" cy="${C}" r="204" fill="none" stroke="url(#holo2)" stroke-width="1" opacity="0.55"/>`);
add(`<circle cx="${C}" cy="${C}" r="196" fill="#0b0912" fill-opacity="0.55" stroke="url(#holo)" stroke-width="1.5" opacity="0.9"/>`);
let ticks = '';
for (let i = 0; i < 96; i++) {
  const a = (i / 96) * Math.PI * 2; const major = i % 8 === 0; const mid = i % 4 === 0;
  const r1 = 218; const r2 = major ? 236 : mid ? 230 : 225;
  ticks += `M${f(C + Math.cos(a) * r1)} ${f(C + Math.sin(a) * r1)}L${f(C + Math.cos(a) * r2)} ${f(C + Math.sin(a) * r2)}`;
}
add(`<path d="${ticks}" stroke="url(#holo)" stroke-width="2" stroke-linecap="round" opacity="0.8"/>`);
// Losanges aux quatre points cardinaux
for (const [x, y] of [[C, 20], [C, 492], [20, C], [492, C]]) {
  add(`<path d="M${x} ${y - 9}L${x + 9} ${y}L${x} ${y + 9}L${x - 9} ${y}Z" fill="url(#holo)"/>`);
}

// ---- Le corbeau ----
add(`<g clip-path="url(#medaillon)">`);
// Ombre portée lumineuse
add(`<path d="${HEAD}" fill="#b794ff" opacity="0.35" filter="url(#lueur)" transform="translate(0 8)"/>`);
add(`<path d="${HEAD}" fill="url(#plume)"/>`);

// Plumes : rangées d'écailles de la nuque vers la poitrine, orientées le long du cou
add('<g clip-path="url(#tete)">');
const feather = (x, y, len, wid, ang, tone) => {
  const a = ang * Math.PI / 180; const ca = Math.cos(a); const sa = Math.sin(a);
  const P = (u, v) => `${f(x + u * ca - v * sa)} ${f(y + u * sa + v * ca)}`;
  const d = `M${P(0, 0)} C${P(len * 0.25, -wid)} ${P(len * 0.8, -wid * 0.7)} ${P(len, 0)} C${P(len * 0.8, wid * 0.7)} ${P(len * 0.25, wid)} ${P(0, 0)}Z`;
  const fill = tone > 0.8 ? 'url(#holo)' : tone > 0.55 ? 'url(#holo2)' : '#1a1628';
  const op = tone > 0.8 ? 0.55 : tone > 0.55 ? 0.35 : 0.95;
  return `<path d="${d}" fill="${fill}" fill-opacity="${op}" stroke="#7a6cc0" stroke-opacity="0.35" stroke-width="0.8"/>`
    + `<path d="M${P(len * 0.08, 0)} L${P(len * 0.92, 0)}" stroke="#d9ccff" stroke-opacity="0.28" stroke-width="0.7"/>`;
};
// Rangées depuis l'arrière vers l'avant (les plumes de devant recouvrent celles de derrière)
for (let row = 0; row < 15; row++) {
  const t = row / 14;
  const baseY = 120 + t * 300;
  const n = 5 + Math.round(t * 6);
  for (let i = 0; i < n; i++) {
    const x = 70 + (i + (row % 2) * 0.5) * (330 / n) + rnd() * 6;
    const y = baseY + rnd() * 8 - (x > 300 ? (x - 300) * 0.6 : 0);
    const ang = 100 + (x - 230) * 0.12 + rnd() * 14; // vers le bas, légèrement inclinées
    add(feather(x, y, 56 + rnd() * 16 + t * 14, 15 + rnd() * 4, ang, rnd()));
  }
}
// Plumes fines du crâne, dirigées vers l'arrière
for (let i = 0; i < 20; i++) {
  const t = i / 19;
  const x = 330 - t * 150; const y = 150 - Math.sin(t * Math.PI) * 38 + t * 55;
  add(feather(x, y, 42 + rnd() * 10, 10, 168 + t * 30 + rnd() * 6, rnd() * 0.9));
}
// Hachures de plumes sous le bec (gorge)
for (let i = 0; i < 9; i++) {
  add(feather(318 + i * 5 - (i % 2) * 4, 292 + i * 8, 44, 8, 118 + i * 3, 0.1 + rnd() * 0.3));
}
// Reflet principal : croissant lumineux sur le dessus de la tête
add('<path d="M130 218 C142 160 190 118 240 114 C282 112 318 132 336 158 C298 138 258 134 218 154 C176 176 146 196 130 218Z" fill="url(#holo)" opacity="0.5"/>');
add('<path d="M150 214 C166 172 200 140 240 134" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.5"/>');
add('</g>');
add(`<path d="${HEAD}" fill="none" stroke="url(#holo)" stroke-width="3" stroke-linejoin="round" opacity="0.9"/>`);

// ---- Bec ----
add(`<path d="${BEAK_UP}" fill="url(#bec)" stroke="url(#holo)" stroke-width="2.6" stroke-linejoin="round"/>`);
add(`<path d="${BEAK_LOW}" fill="#0d0b16" stroke="url(#holo2)" stroke-width="2.6" stroke-linejoin="round"/>`);
add('<path d="M350 232 C380 244 418 246 446 236" fill="none" stroke="#05040a" stroke-width="3.4" stroke-linecap="round"/>');
add('<path d="M350 166 C380 180 412 202 434 226" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity="0.55"/>');
add('<path d="M342 158 C360 170 376 184 390 198" fill="none" stroke="#7df9d0" stroke-width="1.6" stroke-linecap="round" opacity="0.6"/>');
add('<ellipse cx="342" cy="198" rx="3.4" ry="7" transform="rotate(-24 342 198)" fill="#04030a"/>'); // narine
// Vibrisses à la base du bec
for (let i = 0; i < 6; i++) {
  add(`<path d="M${330 + i * 3} ${150 + i * 14} C${318 + i * 2} ${158 + i * 14} ${304 + i} ${166 + i * 13} ${292} ${170 + i * 12}" fill="none" stroke="#b9a8ff" stroke-opacity="0.55" stroke-width="1.6" stroke-linecap="round"/>`);
}

// ---- Œil : anneau doré, iris, pupille, reflets ----
add('<circle cx="296" cy="186" r="30" fill="#05040a" stroke="url(#holo)" stroke-width="2.4"/>');
add('<circle cx="296" cy="186" r="24" fill="url(#oeil)"/>');
add('<circle cx="296" cy="186" r="24" fill="none" stroke="#8a4a10" stroke-width="1.2" opacity="0.6"/>');
let iris = '';
for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2; iris += `M${f(296 + Math.cos(a) * 11)} ${f(186 + Math.sin(a) * 11)}L${f(296 + Math.cos(a) * 23)} ${f(186 + Math.sin(a) * 23)}`; }
add(`<path d="${iris}" stroke="#9a560f" stroke-width="0.9" opacity="0.55"/>`);
add('<ellipse cx="297" cy="187" rx="9" ry="12.5" fill="#05040a"/>');
add('<circle cx="288" cy="177" r="6" fill="#fff" opacity="0.95"/>');
add('<circle cx="304" cy="196" r="2.6" fill="#fff" opacity="0.7"/>');
// Arcade sourcilière
add('<path d="M262 170 C276 152 304 148 326 160" fill="none" stroke="url(#holo2)" stroke-width="3" stroke-linecap="round" opacity="0.85"/>');

// ---- Curseur d'invite (clin d'œil au terminal) posé dans le col : « > _ » ----
add('<path d="M168 372 L192 388 L168 404" fill="none" stroke="#7df9d0" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>');
add('<rect x="206" y="398" width="34" height="9" rx="3" fill="#ff8fcf"/>');
add('</g>');

// ---- Constellation de « nœuds » (réseau) autour de la tête ----
const nodes = [[96, 150], [150, 82], [372, 86], [430, 150], [440, 330], [380, 420], [112, 300]];
let net = '';
for (let i = 0; i < nodes.length - 1; i++) net += `M${nodes[i][0]} ${nodes[i][1]}L${nodes[i + 1][0]} ${nodes[i + 1][1]}`;
add(`<path d="${net}" stroke="url(#holo)" stroke-width="1" opacity="0.28" fill="none"/>`);
for (const [x, y] of nodes) add(`<circle cx="${x}" cy="${y}" r="3.4" fill="#0b0912" stroke="url(#holo)" stroke-width="1.6"/>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Logo Corvus : un corbeau dans un médaillon">\n${parts.join('\n')}\n</svg>\n`;
fs.writeFileSync(out, svg);
console.log(`✔ ${path.relative(root, out)} (${Math.round(svg.length / 1024)} Ko)`);
