// Recherche plein texte dans un enregistrement asciicast v2, à la volée (aucun index sur disque : un index serait
// un secret en clair). Les séquences d'échappement sont retirées par un petit automate qui GARDE son état d'un
// événement à l'autre : une séquence coupée entre deux paquets ne laisse ni résidu ni faux positif.

export const SEARCH_MAX_Q = 200;
export const SNIPPET = 60;

/** asciicast v2 → { header, events: [[t, type, data]] } ; lignes invalides ignorées. */
export function parseCast(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const lines = text.split('\n');
  let header = {};
  try { header = JSON.parse(lines[0]); } catch { header = {}; }
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'string') events.push(e);
    } catch { /* ligne tronquée */ }
  }
  return { header, events };
}

const ESC = 0x1b;

/**
 * Texte affiché (sans séquences d'échappement ni caractères de contrôle, « \r\n » ramené à « \n »)
 * et position de départ de chaque événement dans ce texte.
 */
export function plainText(events, { deadline = Infinity } = {}) {
  const parts = [];
  const marks = []; // [offsetDansLeTexte, tempsEnSecondes]
  let total = 0;
  // États : 0 normal, 1 après ESC, 2 CSI, 3 chaîne (OSC/DCS/APC/PM/SOS) jusqu'à BEL ou ST, 4 ESC dans une chaîne, 5 ESC + intermédiaire(s)
  let state = 0;
  let lastCR = false;
  let ticks = 0;
  for (const e of events) {
    if (e[1] !== 'o' || typeof e[2] !== 'string') continue;
    if (++ticks % 2000 === 0 && Date.now() > deadline) return { plain: parts.join(''), marks, timedOut: true };
    marks.push([total, e[0]]);
    const s = e[2];
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      switch (state) {
        case 1:
          if (c === 0x5b) state = 2;                                  // ESC [
          else if (c === 0x5d || c === 0x50 || c === 0x5f || c === 0x5e || c === 0x58) state = 3; // ESC ] P _ ^ X
          else if (c >= 0x20 && c <= 0x2f) state = 5;                 // ESC ( B …
          else state = 0;                                              // ESC c, ESC 7, ESC = …
          break;
        case 2:
          if (c >= 0x40 && c <= 0x7e) state = 0;                      // fin de la séquence CSI
          else if (c === ESC) state = 1;                               // séquence interrompue
          break;
        case 3:
          if (c === 0x07) state = 0;                                   // BEL termine une OSC
          else if (c === ESC) state = 4;
          break;
        case 4:
          state = c === 0x5c ? 0 : 3;                                    // ESC \ (ST) termine ; sinon on reste dans la chaîne
          break;
        case 5:
          if (c < 0x20 || c > 0x2f) state = 0;
          break;
        default:
          if (c === ESC) { state = 1; lastCR = false; }
          else if (c === 0x0d) lastCR = true;                          // « \r » seul : on ne l'écrit pas, « \r\n » devient « \n »
          else if (c === 0x0a) { out += '\n'; lastCR = false; }
          else if (c === 0x09) { out += '\t'; lastCR = false; }
          else if (c < 0x20 || c === 0x7f) { /* autres caractères de contrôle ignorés */ }
          else { if (lastCR) { out += '\n'; lastCR = false; } out += s[i]; }
      }
    }
    parts.push(out);
    total += out.length;
  }
  return { plain: parts.join(''), marks, timedOut: false };
}

/** Temps (s) de l'événement qui contient la position `pos` du texte. */
export function timeAt(marks, pos) {
  let lo = 0;
  let hi = marks.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid][0] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return marks[ans]?.[1] ?? 0;
}

const oneLine = (t) => t.replace(/[\n\t]+/g, ' ');

/**
 * Occurrences de `needle` (insensible à la casse) : [{ t, at, snippet }].
 * `offset` / `limit` : pagination ; `total` : nombre d'occurrences trouvées (plafonné par `cap`).
 */
export function findInPlain({ plain, marks }, needle, { offset = 0, limit = 50, cap = 1000, deadline = Infinity } = {}) {
  let hay = plain;
  let n = needle;
  const lo = plain.toLowerCase();
  // Si la mise en minuscules change la longueur (rares caractères spéciaux), on cherche en respectant la casse
  // plutôt que de décaler les positions.
  if (lo.length === plain.length) { hay = lo; n = needle.toLowerCase(); }
  const matches = [];
  let total = 0;
  let from = 0;
  let timedOut = false;
  for (;;) {
    const i = hay.indexOf(n, from);
    if (i < 0) break;
    total++;
    if (total > offset && matches.length < limit) {
      const a = Math.max(0, i - SNIPPET);
      const b = Math.min(plain.length, i + n.length + SNIPPET);
      matches.push({ t: timeAt(marks, i), at: i, snippet: oneLine(plain.slice(a, b)), start: i - a, length: n.length });
    }
    from = i + Math.max(1, n.length);
    if (total >= cap) break;
    if (total % 500 === 0 && Date.now() > deadline) { timedOut = true; break; }
  }
  return { matches, total, capped: total >= cap, timedOut };
}
