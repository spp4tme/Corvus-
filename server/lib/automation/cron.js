// Expressions cron en JavaScript pur (aucune dépendance), avec FUSEAU HORAIRE EXPLICITE. Module PUR, portable.
//
// Syntaxe : 5 champs « minute heure jour-du-mois mois jour-de-semaine ».
//   `*`, `5`, `1-5`, `*/15`, `10-50/10`, listes `1,15,30`, noms `JAN-DEC` et `SUN-SAT` (insensibles à la casse), dimanche = 0 ou 7.
//   Raccourcis : @hourly @daily @weekly @monthly @yearly.
//   Refusés (jamais ignorés en silence) : secondes, `?`, `L`, `W`, `#`, valeurs hors bornes, plages inversées, pas nul.
// Comportement (comme cron) : si le jour du mois ET le jour de semaine sont tous deux restreints, l'un OU l'autre suffit.
//
// HEURE D'ÉTÉ / D'HIVER (choix documentés, testés avec de vraies transitions) :
//   - une heure qui n'EXISTE PAS (passage à l'heure d'été) est SAUTÉE ce jour-là, jamais décalée ;
//   - une heure qui existe DEUX FOIS (retour à l'heure d'hiver) ne déclenche QU'UNE fois, à la première occurrence.
//   - jamais de « rattrapage » : `nextRun` ne rend que des instants FUTURS (voir scheduler.js pour la tolérance de retard).

export class CronError extends Error {
  constructor(message) { super(message); this.name = 'CronError'; this.code = 'INVALID_CRON'; }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MACROS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const FIELDS = [
  { name: 'minute', min: 0, max: 59 }, { name: 'heure', min: 0, max: 23 }, { name: 'jour du mois', min: 1, max: 31 },
  { name: 'mois', min: 1, max: 12, names: MONTHS, base: 1 }, { name: 'jour de semaine', min: 0, max: 7, names: DAYS, base: 0 },
];
const MAX_LEN = 100;
const MAX_SEARCH_DAYS = 366 * 8; // une expression « 29 février » doit pouvoir être trouvée

function value(token, f) {
  if (/^\d{1,2}$/.test(token)) return Number(token);
  const i = f.names ? f.names.indexOf(token.toUpperCase()) : -1;
  if (i >= 0) return i + (f.base ?? 0);
  throw new CronError(`${f.name} : « ${token.slice(0, 20)} » invalide`);
}

function parseField(text, f) {
  const out = new Set();
  for (const part of text.split(',')) {
    if (!part) throw new CronError(`${f.name} : élément vide`);
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`${f.name} : « / » en trop`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,3}$/.test(stepText) || Number(stepText) < 1) throw new CronError(`${f.name} : pas invalide`);
      step = Number(stepText);
    }
    let lo; let hi;
    if (range === '*') { lo = f.min; hi = f.name === 'jour de semaine' ? 6 : f.max; } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined || !a || !b) throw new CronError(`${f.name} : plage invalide`);
      lo = value(a, f); hi = value(b, f);
      if (lo > hi) throw new CronError(`${f.name} : plage inversée`);
    } else {
      lo = value(range, f);
      hi = stepText !== undefined ? f.max : lo; // « 5/10 » = de 5 jusqu'à la fin, par 10
    }
    if (lo < f.min || hi > f.max) throw new CronError(`${f.name} : hors bornes (${f.min}-${f.max})`);
    for (let v = lo; v <= hi; v += step) out.add(f.name === 'jour de semaine' && v === 7 ? 0 : v);
  }
  return out;
}

/** @returns {{ minute: Set<number>, hour: Set<number>, dom: Set<number>, month: Set<number>, dow: Set<number>, domAny: boolean, dowAny: boolean, source: string }} */
export function parseCron(expr) {
  if (typeof expr !== 'string') throw new CronError('Expression cron : texte attendu');
  if (expr.length > MAX_LEN) throw new CronError(`Expression cron trop longue (${MAX_LEN} caractères au maximum)`);
  if (/[\u0000-\u001f\u007f]/.test(expr)) throw new CronError('Expression cron : caractères de contrôle interdits');
  const source = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = source.split(/\s+/);
  if (parts.length !== 5) throw new CronError(`Expression cron : 5 champs attendus (minute heure jour mois jour-de-semaine), ${parts.length} reçus`);
  const [mi, h, dom, mo, dw] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { minute: mi, hour: h, dom, month: mo, dow: dw, domAny: parts[2] === '*', dowAny: parts[4] === '*', source };
}

// --- Fuseaux horaires --------------------------------------------------------------------------------------------------------

const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const fmtCache = new Map();

function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Valide un fuseau (nom IANA). Le fuseau est TOUJOURS explicite : il n'y a pas de valeur par défaut. */
export function checkTimeZone(tz) {
  if (typeof tz !== 'string' || !TZ_RE.test(tz)) throw new CronError('Fuseau horaire invalide (nom IANA attendu, ex. Europe/Paris ou UTC)');
  try { fmt(tz); } catch { throw new CronError(`Fuseau horaire inconnu : « ${tz} »`); }
  return tz;
}

/** Heure locale d'un instant UTC dans le fuseau. */
export function localParts(ms, tz) {
  const p = {};
  for (const { type, value: v } of fmt(tz).formatToParts(new Date(ms))) if (type !== 'literal') p[type] = Number(v);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, dow: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() };
}

const offsetAt = (ms, tz) => { const l = localParts(ms, tz); return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - Math.floor(ms / 1000) * 1000; };

/**
 * Instant UTC d'une heure locale (la PREMIÈRE s'il y en a deux), ou null si cette heure n'existe pas ce jour-là.
 * Teste les décalages d'avant et d'après toute transition proche (±1 jour).
 */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsets = new Set([offsetAt(guess - 86_400_000, tz), offsetAt(guess + 86_400_000, tz), offsetAt(guess, tz)]);
  const valid = [];
  for (const o of offsets) {
    const utc = guess - o;
    const l = localParts(utc, tz);
    if (l.year === y && l.month === mo && l.day === d && l.hour === h && l.minute === mi) valid.push(utc);
  }
  return valid.length ? Math.min(...valid) : null;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function dayMatches(c, y, m, d, dow) {
  if (!c.month.has(m)) return false;
  const domOk = c.dom.has(d);
  const dowOk = c.dow.has(dow);
  if (!c.domAny && !c.dowAny) return domOk || dowOk; // les deux restreints : l'un OU l'autre (comportement de cron)
  return domOk && dowOk;
}

/**
 * Prochain déclenchement STRICTEMENT après `afterMs`, en millisecondes UTC (ou null s'il n'y en a pas dans les 8 ans).
 * @param {ReturnType<typeof parseCron>} cron
 */
export function nextRun(cron, afterMs, tz) {
  checkTimeZone(tz);
  const start = localParts(afterMs, tz);
  const hours = [...cron.hour].sort((a, b) => a - b);
  const minutes = [...cron.minute].sort((a, b) => a - b);
  let y = start.year; let m = start.month; let d = start.day;
  for (let n = 0; n < MAX_SEARCH_DAYS; n++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dayMatches(cron, y, m, d, dow)) {
      let best = null;
      for (const h of hours) {
        for (const mi of minutes) {
          const utc = zonedToUtc(y, m, d, h, mi, tz);
          if (utc !== null && utc > afterMs && (best === null || utc < best)) best = utc;
        }
      }
      if (best !== null) return best;
    }
    d += 1;
    if (d > daysInMonth(y, m)) { d = 1; m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  return null;
}

/** Fenêtre de maintenance « HH:MM-HH:MM » (peut passer minuit), jours facultatifs, évaluée dans un fuseau. */
export function parseWindow(win) {
  if (win === undefined || win === null) return null;
  if (typeof win !== 'object' || Array.isArray(win)) throw new CronError('Fenêtre : objet { from, to, days? } attendu');
  for (const k of Object.keys(win)) if (!['from', 'to', 'days'].includes(k)) throw new CronError(`Fenêtre : champ inconnu « ${k.slice(0, 20)} »`);
  const t = (s, what) => {
    const m = typeof s === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
    if (!m) throw new CronError(`Fenêtre : ${what} doit être HH:MM`);
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const from = t(win.from, 'from');
  const to = t(win.to, 'to');
  if (from === to) throw new CronError('Fenêtre : début et fin identiques');
  let days = null;
  if (win.days !== undefined) {
    if (!Array.isArray(win.days) || !win.days.length || win.days.length > 7 || !win.days.every((x) => Number.isInteger(x) && x >= 0 && x <= 6)) throw new CronError('Fenêtre : days = liste de jours 0 (dimanche) à 6');
    days = [...new Set(win.days)].sort();
  }
  return { from: win.from, to: win.to, days, fromMin: from, toMin: to };
}

/** L'instant est-il dans la fenêtre ? (une fenêtre qui passe minuit compte pour le jour où elle COMMENCE.) */
export function inWindow(win, ms, tz) {
  if (!win) return true;
  const l = localParts(ms, tz);
  const cur = l.hour * 60 + l.minute;
  const overnight = win.fromMin > win.toMin;
  let inside; let dayOfStart = l.dow;
  if (!overnight) inside = cur >= win.fromMin && cur < win.toMin;
  else if (cur >= win.fromMin) inside = true;
  else if (cur < win.toMin) { inside = true; dayOfStart = (l.dow + 6) % 7; } else inside = false;
  return inside && (!win.days || win.days.includes(dayOfStart));
}
