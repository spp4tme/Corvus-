// Suggestions de commandes SANS IA : uniquement des comptages sur votre propre historique.
//  - complétion : commandes commençant par le préfixe, classées par « fréquence × récence » ;
//  - commande suivante : modèle n-gramme (on compte ce qui a suivi les 1 ou 2 commandes précédentes) ;
//  - séquences répétées : suites de 2 à 4 commandes revenues plusieurs fois → candidates à un bouton.

const HALF_LIFE_MS = 14 * 24 * 3600_000;

/** Classement fréquence × récence (une utilisation récente compte plus qu'une ancienne). */
export function rankHistory(history, prefix = '', { limit = 10, now = Date.now() } = {}) {
  const score = new Map();
  const p = prefix.trim();
  for (const h of history) {
    const c = h.command.trim();
    if (!c || c === p || (p && !c.startsWith(p))) continue;
    const w = 0.5 ** ((now - h.ts) / HALF_LIFE_MS);
    score.set(c, (score.get(c) || 0) + w);
  }
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([command, s]) => ({ command, score: Number(s.toFixed(3)) }));
}

/**
 * Prochaine commande probable après `prev` (liste des dernières commandes, la plus récente en
 * dernier). Trigramme d'abord (2 commandes de contexte), sinon bigramme.
 */
export function nextCommands(history, prev, { limit = 5 } = {}) {
  const seq = history.map((h) => h.command.trim()).filter(Boolean);
  const last = prev.map((x) => x.trim()).filter(Boolean);
  const count = (ctxLen) => {
    const ctx = last.slice(-ctxLen);
    if (ctx.length < ctxLen) return [];
    const m = new Map();
    for (let i = ctxLen; i < seq.length; i++) {
      let match = true;
      for (let k = 0; k < ctxLen; k++) if (seq[i - ctxLen + k] !== ctx[k]) { match = false; break; }
      if (match && seq[i] !== ctx[ctxLen - 1]) m.set(seq[i], (m.get(seq[i]) || 0) + 1);
    }
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return [...m].sort((a, b) => b[1] - a[1]).map(([command, n]) => ({ command, count: n, probability: Number((n / total).toFixed(2)), context: ctxLen }));
  };
  const tri = count(2).filter((x) => x.count >= 2);
  const out = [...tri];
  for (const b of count(1)) if (!out.some((x) => x.command === b.command)) out.push(b);
  return out.slice(0, limit);
}

/** Suites de 2 à 4 commandes répétées au moins `minRepeat` fois (sans chevauchement). */
export function repeatedSequences(history, { minRepeat = 3, maxLen = 4, limit = 10 } = {}) {
  const seq = history.map((h) => h.command.trim()).filter(Boolean);
  const found = new Map();
  for (let len = maxLen; len >= 2; len--) {
    const counts = new Map();
    const lastEnd = new Map();
    for (let i = 0; i + len <= seq.length; i++) {
      const part = seq.slice(i, i + len);
      if (new Set(part).size < len) continue; // « ls ls ls » n'est pas une routine
      const key = part.join('\n');
      if ((lastEnd.get(key) ?? -1) > i) continue; // pas de chevauchement
      counts.set(key, (counts.get(key) || 0) + 1);
      lastEnd.set(key, i + len);
    }
    for (const [key, n] of counts) {
      if (n < minRepeat) continue;
      // Une sous-suite d'une suite plus longue déjà retenue n'apporte rien.
      if ([...found.keys()].some((k) => k.includes(key))) continue;
      found.set(key, n);
    }
  }
  return [...found].sort((a, b) => b[1] * b[0].split('\n').length - a[1] * a[0].split('\n').length)
    .slice(0, limit).map(([key, n]) => ({ commands: key.split('\n'), count: n }));
}

/**
 * Lecture d'un historique de shell distant (bash ou zsh « étendu » : `: 1700000000:0;commande`).
 * Les commandes sans date reçoivent des dates croissantes fictives (l'ordre est conservé).
 */
export function parseShellHistory(text, { now = Date.now() } = {}) {
  const lines = String(text).split('\n');
  const out = [];
  let ts = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const bashTs = /^#(\d{9,11})$/.exec(line);
    if (bashTs) { ts = Number(bashTs[1]) * 1000; continue; }
    const zsh = /^: (\d{9,11}):\d+;(.*)$/.exec(line);
    if (zsh) { out.push({ command: zsh[2], ts: Number(zsh[1]) * 1000 }); continue; }
    out.push({ command: line, ts });
    ts = null;
  }
  const n = out.length;
  return out.map((h, i) => ({ command: h.command.slice(0, 2000), ts: h.ts ?? now - (n - i) * 60_000 }));
}
