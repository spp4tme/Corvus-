// Contrôle vocal : écoute continue (Web Speech API) + interprétation des phrases en actions de terminal.
// parseUtterance() est pure (aucun accès DOM) pour pouvoir être testée sous Node.

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.,;:!?'’"«»]/g, ' ').replace(/\s+/g, ' ').trim();

const key = (v) => [{ kind: 'key', v }];
const arrow = (v) => [{ kind: 'arrow', v }];
const scroll = (v) => [{ kind: 'scroll', v }];
const digit = (n) => [{ kind: 'text', v: String(n) }];

// Commandes qui doivent constituer toute la phrase (évite d'exécuter « annule » au milieu d'un texte).
const COMMANDS = new Map();
const add = (words, actions) => { for (const w of words) COMMANDS.set(w, actions); };
add(['entree', 'envoie', 'envoyer', 'valide', 'valider', 'enter', 'send', 'submit', 'confirm'], key('\r'));
add(['annule', 'annuler', 'interromps', 'interrompre', 'controle c', 'control c', 'cancel', 'interrupt'], key('\x03'));
add(['fin de saisie', 'controle d', 'control d'], key('\x04'));
add(['efface', 'efface tout', 'vide la ligne', 'clear line', 'clear input'], key('\x15'));
add(['efface l ecran', 'nettoie l ecran', 'clear screen'], key('\x0c'));
add(['retour arriere', 'supprime', 'backspace', 'delete'], key('\x7f'));
add(['echap', 'echappe', 'escape'], key('\x1b'));
add(['tab', 'tabulation', 'complete', 'autocompletion'], key('\t'));
add(['shift tab', 'maj tab', 'mode suivant'], key('\x1b[Z'));
add(['haut', 'fleche haut', 'up'], arrow('A'));
add(['bas', 'fleche bas', 'down'], arrow('B'));
add(['droite', 'fleche droite', 'right'], arrow('C'));
add(['gauche', 'fleche gauche', 'left'], arrow('D'));
add(['monte', 'remonte', 'page haut', 'scroll up'], scroll(-1));
add(['descends', 'redescends', 'page bas', 'scroll down'], scroll(1));
add(['arrete l ecoute', 'arrete d ecouter', 'stop ecoute', 'termine', 'stop listening'], [{ kind: 'stop' }]);
['un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'].forEach((w, i) => add([w, String(i + 1)], digit(i + 1)));
['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].forEach((w, i) => add([w], digit(i + 1)));

// Mots remplacés par un symbole dans un texte dicté. glueBefore : collé au mot précédent ;
// glueAfter : collé au mot suivant ; « path » : collé au précédent seulement dans un chemin (a/b, ~/x, ../x).
const SYMBOLS = new Map([
  ['slash', { s: '/', before: 'path', after: true }], ['barre oblique', { s: '/', before: 'path', after: true }],
  ['double tiret', { s: '--', before: false, after: true }], ['tiret', { s: '-', before: false, after: true }],
  ['tilde', { s: '~', before: false, after: true, path: true }], ['point point', { s: '..', before: false, after: false, path: true }],
  ['pipe', { s: '|', before: false, after: false }], ['barre verticale', { s: '|', before: false, after: false }],
  ['antislash', { s: '\\', before: true, after: true }], ['arobase', { s: '@', before: true, after: true }],
  ['underscore', { s: '_', before: true, after: true }], ['tiret bas', { s: '_', before: true, after: true }],
  ['etoile', { s: '*', before: true, after: true }], ['dollar', { s: '$', before: false, after: true }],
  ['point', { s: '.', before: true, after: true }],
  ['dieze', { s: '#', before: false, after: false }],
]);
const SUFFIX = new Set(['entree', 'envoie', 'envoyer', 'valide', 'valider', 'enter']);

function joinWords(words) {
  let out = '';
  let glueNext = false;
  let inPath = false;
  let prevWasSymbol = false;
  for (let i = 0; i < words.length; ) {
    // Plus long symbole possible (jusqu'à 2 mots) à cette position.
    let sym = null;
    let len = 1;
    for (const n of [2, 1]) {
      const cand = SYMBOLS.get(strip(words.slice(i, i + n).join(' ')));
      if (cand) { sym = cand; len = n; break; }
    }
    if (sym) {
      const glue = out === '' ? false : sym.before === 'path' ? inPath : sym.before;
      out += (out === '' || glue || glueNext ? '' : ' ') + sym.s;
      glueNext = sym.after;
      inPath = sym.s === '/' || sym.path === true;
      prevWasSymbol = true;
    } else {
      out += (out === '' || glueNext ? '' : ' ') + words[i];
      glueNext = false;
      if (!prevWasSymbol) inPath = false;
      prevWasSymbol = false;
    }
    i += len;
  }
  return out;
}

/**
 * « liste les fichiers » → [texte]; « liste les fichiers entrée » → [texte, Entrée]; « annule » → [Ctrl-C].
 * Le texte n'est jamais exécuté sans le mot « entrée » (ou équivalent) : un mot mal compris ne lance rien.
 */
export function parseUtterance(raw, { shell = true } = {}) {
  const norm = strip(raw || '');
  if (!norm) return [];
  if (COMMANDS.has(norm)) return COMMANDS.get(norm);

  const words = String(raw).trim().split(/\s+/);
  const submit = words.length > 1 && SUFFIX.has(strip(words[words.length - 1]));
  if (submit) words.pop();
  let text = joinWords(words);
  if (shell) {
    text = text.replace(/[.!?]+$/, '');
    if (/^\p{Lu}\p{Ll}/u.test(text)) text = text[0].toLowerCase() + text.slice(1);
  }
  const out = [];
  if (text) out.push({ kind: 'text', v: text });
  if (submit && text) out.push({ kind: 'key', v: '\r' });
  return out;
}

export const voiceSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

/** Écoute continue qui se relance toute seule (les navigateurs coupent après un silence). */
export function createVoice({ lang, onText, onInterim, onState, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let wanted = false;
  let restarts = 0;
  let lastStart = 0;

  function start() {
    rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      restarts = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) onText(r[0].transcript);
        else interim += r[0].transcript;
      }
      onInterim?.(interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wanted = false; onError?.('Micro refusé : autorisez-le dans le navigateur (HTTPS requis).'); }
      else if (e.error === 'network') onError?.('Reconnaissance vocale indisponible (réseau).');
      else onError?.(`Dictée indisponible : ${e.error}`);
    };
    rec.onend = () => {
      onInterim?.('');
      if (!wanted) { onState?.(false); return; }
      // Boucle de redémarrage trop rapide (erreur persistante) : on abandonne.
      if (Date.now() - lastStart < 1000 && ++restarts > 5) { wanted = false; onState?.(false); onError?.('Écoute interrompue.'); return; }
      try { setTimeout(() => wanted && start(), 150); } catch { wanted = false; onState?.(false); }
    };
    lastStart = Date.now();
    try { rec.start(); } catch { /* déjà démarrée */ }
  }

  return {
    get active() { return wanted; },
    start() { if (wanted) return; wanted = true; restarts = 0; onState?.(true); start(); },
    stop() { wanted = false; try { rec?.stop(); } catch { /* rien */ } onState?.(false); },
  };
}
