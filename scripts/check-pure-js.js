#!/usr/bin/env node
// Vérifie que les dépendances de production ne contiennent aucun module natif (.node, binding.gyp),
// condition pour tourner tel quel sur Raspberry Pi ARM64 comme sur PC x64.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function deps(name, seen) {
  if (seen.has(name)) return;
  seen.add(name);
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')); } catch { return; }
  for (const d of Object.keys(p.dependencies || {})) deps(d, seen);
}
const prod = new Set();
for (const d of Object.keys(pkg.dependencies)) deps(d, prod);

const offenders = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); }
    else if (e.name.endsWith('.node') || e.name === 'binding.gyp') offenders.push(path.relative(root, f));
  }
}
for (const name of prod) {
  const dir = path.join(root, 'node_modules', name);
  if (fs.existsSync(dir)) walk(dir);
}
const compiled = offenders.filter((o) => o.endsWith('.node'));
if (compiled.length) {
  console.error('ÉCHEC — binaires natifs compilés :\n  ' + compiled.join('\n  '));
  process.exit(1);
}
for (const o of offenders) console.log(`info : ${o} présent mais jamais compilé (.npmrc : ignore-scripts=true)`);
console.log(`OK : ${prod.size} dépendances de production, aucun binaire natif.`);
