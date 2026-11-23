// Vue Terminal : onglets multiples (xterm.js), reconnexion WebSocket automatique avec reprise
// à l'octet près, barre de touches mobile, OSC52, thèmes, taille de police.
import { get, del } from '../api.js';
import { h, clear, replace, prefs } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, openDialog, emptyState, toast, badge } from '../ui/components.js';
import { state, sortedHosts } from '../state.js';
import { terminalTheme } from '../terminal-themes.js';

const tabs = [];
let active = null;
let ui = null;
const mods = { ctrl: false, alt: false };

export const termSettings = {
  get fontSize() { return prefs.get('termFontSize', window.matchMedia('(max-width: 599px)').matches ? 13 : 14); },
  get theme() { return prefs.get('termTheme', 'corvus'); },
  get keybar() { return prefs.get('termKeybar', 'auto'); },
  apply() {
    for (const t of tabs) {
      t.term.options.fontSize = this.fontSize;
      t.term.options.theme = terminalTheme(this.theme);
      t.fitSoon();
    }
    ui?.keybar.classList.toggle('auto-hide', this.keybar === 'auto');
    if (ui) ui.keybar.hidden = this.keybar === 'never';
  },
};

class Tab {
  constructor({ hostId, sessionId = null, title }) {
    this.hostId = hostId;
    this.sessionId = sessionId;
    this.title = title;
    this.received = undefined; // offset absolu reçu ; undefined → rejeu complet
    this.exited = false;
    this.attempts = 0;
    this.status = 'connexion';

    this.pane = h('div', { class: 'term-pane', role: 'tabpanel', hidden: true });
    this.statusEl = h('div', { class: 'term-status' });
    this.pane.appendChild(this.statusEl);
    this.term = new window.Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: termSettings.fontSize,
      theme: terminalTheme(termSettings.theme),
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    const host = h('div', { class: 'term-host' });
    this.pane.appendChild(host);
    ui.stage.appendChild(this.pane);
    this.term.open(host);

    // OSC 52 : le programme distant demande une copie vers le presse-papiers (tmux, vim, etc.).
    this.term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(';') + 1);
      if (!b64 || b64 === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        navigator.clipboard?.writeText(text).then(
          () => toast('Copié dans le presse-papiers (OSC 52)', 'ok', 1500),
          () => toast('Copie refusée par le navigateur (HTTPS requis)', 'warn'),
        );
      } catch { /* données invalides */ }
      return true;
    });
    this.term.onData((d) => this.sendInput(applyModifiers(d)));
    this.term.onBinary((d) => this.sendBinary(d));
    this.term.onTitleChange((t) => { if (t) { this.remoteTitle = t.slice(0, 60); renderTabs(); } });

    this.tabEl = null;
    this.connect();
  }

  get label() {
    return this.remoteTitle ? `${this.title} — ${this.remoteTitle}` : this.title;
  }

  setStatus(status, text) {
    this.status = status;
    const kinds = { connexion: 'accent', reconnexion: 'warn', terminé: undefined, erreur: 'danger' };
    replace(this.statusEl, status === 'ok' ? null : badge(text || status, kinds[status]));
    renderTabs();
  }

  connect() {
    clearTimeout(this.retryTimer);
    if (this.exited) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    if (this.sessionId) {
      q.set('session', this.sessionId);
      if (this.received !== undefined) q.set('since', String(this.received));
    } else {
      const dims = this.fit.proposeDimensions() || { cols: 80, rows: 24 };
      q.set('host', this.hostId);
      q.set('cols', String(Math.max(10, dims.cols || 80)));
      q.set('rows', String(Math.max(4, dims.rows || 24)));
    }
    this.setStatus(this.attempts ? 'reconnexion' : 'connexion', this.attempts ? 'Reconnexion…' : 'Connexion…');
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?${q}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        const bytes = new Uint8Array(ev.data);
        this.term.write(bytes);
        this.received = (this.received ?? 0) + bytes.length;
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'ready') {
        this.sessionId = msg.session.id;
        if (msg.reset) this.term.reset();
        this.received = msg.offset;
        this.attempts = 0;
        this.setStatus('ok');
        this.fitSoon(true);
      } else if (msg.t === 'exit') {
        this.markExited('Session terminée');
      } else if (msg.t === 'error') {
        this.term.write(`\r\n\x1b[31m[corvus] ${msg.message}\x1b[0m\r\n`);
        if (msg.code === 'HOSTKEY_MISMATCH') this.term.write('\x1b[33m[corvus] Vérifiez l\'empreinte depuis la vue Hôtes (bouton Tester).\x1b[0m\r\n');
        this.markExited('Erreur', 'erreur');
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      if (this.exited || ev.code === 4000 || ev.code === 4001) return;
      this.scheduleRetry();
    };
  }

  scheduleRetry() {
    this.attempts++;
    const delay = Math.min(500 * 2 ** (this.attempts - 1), 8000);
    this.setStatus('reconnexion', `Reconnexion dans ${Math.round(delay / 1000) || 1} s…`);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Reconnexion immédiate (retour en ligne, réveil de l'onglet). */
  nudge() {
    if (this.exited) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.attempts = Math.max(1, this.attempts);
      this.connect();
    }
  }

  markExited(text, status = 'terminé') {
    this.exited = true;
    clearTimeout(this.retryTimer);
    this.setStatus(status, text);
    this.term.options.cursorBlink = false;
  }

  sendInput(d) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'i', d }));
  }

  sendBinary(d) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff));
  }

  fitSoon(force = false) {
    cancelAnimationFrame(this.fitRaf);
    this.fitRaf = requestAnimationFrame(() => {
      if (this.pane.hidden) return;
      try { this.fit.fit(); } catch { return; }
      const { cols, rows } = this.term;
      if (force || cols !== this.lastCols || rows !== this.lastRows) {
        this.lastCols = cols;
        this.lastRows = rows;
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'r', c: cols, r: rows }));
      }
    });
  }

  dispose(closeRemote = true) {
    clearTimeout(this.retryTimer);
    this.exited = true;
    if (closeRemote && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'close' }));
    else if (closeRemote && this.sessionId) del(`/api/terminals/${this.sessionId}`).catch(() => {});
    this.ws?.close();
    this.term.dispose();
    this.pane.remove();
  }
}

/** Applique les modificateurs Ctrl/Alt de la barre de touches (à usage unique). */
function applyModifiers(d) {
  if (!mods.ctrl && !mods.alt) return d;
  let out = d;
  if (mods.ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
    else if (d === ' ') out = '\x00';
    else if (d === '?') out = '\x7f';
  }
  if (mods.alt) out = `\x1b${out}`;
  mods.ctrl = false;
  mods.alt = false;
  renderMods();
  return out;
}

function openTab(hostId, sessionId, focus = true) {
  const host = state.host(hostId);
  const tab = new Tab({ hostId, sessionId, title: host?.name || 'Terminal' });
  tabs.push(tab);
  activate(tab, focus);
  return tab;
}

function activate(tab, focus = true) {
  active = tab;
  for (const t of tabs) t.pane.hidden = t !== tab;
  renderTabs();
  renderEmpty();
  if (tab) {
    tab.fitSoon(true);
    if (focus) setTimeout(() => tab.term.focus(), 0);
  }
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  tab.dispose(true);
  activate(tabs[Math.min(i, tabs.length - 1)] || null, false);
}

function renderTabs() {
  if (!ui) return;
  clear(ui.tabs);
  for (const t of tabs) {
    const dotKind = t.status === 'ok' ? 'dot dot-ok' : 'dot';
    const el = h('div', {
      class: 'term-tab', role: 'tab', tabindex: '0', 'aria-selected': String(t === active), title: t.label,
      onclick: () => activate(t),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(t); } },
    }, h('span', { class: dotKind, 'aria-hidden': 'true' }), h('span', { class: 'ellipsis' }, t.label),
    button({ label: `Fermer ${t.title}`, icon: 'close', iconOnly: true, variant: 'ghost', onClick: (e) => { e.stopPropagation(); closeTab(t); } }));
    t.tabEl = el;
    ui.tabs.appendChild(el);
  }
  ui.tabs.appendChild(button({ label: 'Nouveau terminal', icon: 'plus', iconOnly: true, variant: 'ghost', onClick: pickHost }));
}

function renderEmpty() {
  ui.empty.hidden = tabs.length > 0;
  ui.keybar.hidden = tabs.length === 0 || termSettings.keybar === 'never';
}

function pickHost() {
  const hosts = sortedHosts();
  const d = openDialog({
    title: 'Ouvrir un terminal',
    body: hosts.length
      ? h('div', { class: 'list' }, hosts.map((x) => h('button', {
        type: 'button', class: 'list-item clickable list-button',
        onclick: () => { d.close(); openTab(x.id); },
      }, h('span', { class: 'host-icon' }, icon(x.icon)), h('span', { class: 'grow' }, h('div', { class: 'host-name ellipsis' }, x.name),
        h('div', { class: 'host-addr ellipsis' }, `${x.username}@${x.hostname}`)), x.tmux ? badge('tmux', 'accent') : null)))
      : emptyState({ icon: 'server', title: 'Aucun hôte', text: 'Ajoutez d\'abord un hôte.' }),
  });
}

// ---------- Barre de touches mobile ----------
const KEYS = [
  { label: 'Esc', send: '\x1b' },
  { label: 'Tab', send: '\t' },
  { label: 'Ctrl', mod: 'ctrl' },
  { label: 'Alt', mod: 'alt' },
  { label: 'Flèche haut', icon: 'arrowUp', arrow: 'A' },
  { label: 'Flèche bas', icon: 'arrowDown', arrow: 'B' },
  { label: 'Flèche gauche', icon: 'arrowLeft', arrow: 'D' },
  { label: 'Flèche droite', icon: 'arrowRight', arrow: 'C' },
  { label: '|', send: '|' },
  { label: '~', send: '~' },
  { label: '/', send: '/' },
  { label: '-', send: '-' },
  { label: '^C', send: '\x03', title: 'Ctrl+C (interrompre)' },
  { label: '^D', send: '\x04', title: 'Ctrl+D (fin de saisie)' },
  { label: 'Coller', icon: 'clipboard', action: 'paste' },
  { label: 'Copier la sélection', icon: 'copy', action: 'copy' },
  { label: 'Dictée vocale', icon: 'mic', action: 'dictate', optional: true },
  { label: 'Masquer le clavier', icon: 'keyboard', action: 'blur' },
];
const modButtons = {};

function renderMods() {
  for (const [k, b] of Object.entries(modButtons)) b.setAttribute('aria-pressed', String(mods[k]));
}

function buildKeybar() {
  const bar = h('div', { class: 'keybar', role: 'toolbar', 'aria-label': 'Touches spéciales' });
  for (const k of KEYS) {
    if (k.optional && !(window.SpeechRecognition || window.webkitSpeechRecognition)) continue;
    const b = h('button', {
      type: 'button', class: 'key', title: k.title || k.label, 'aria-label': k.icon || k.title ? k.title || k.label : undefined,
      'aria-pressed': k.mod ? 'false' : undefined,
    }, k.icon ? icon(k.icon) : k.label);
    // Ne pas voler le focus au terminal : le clavier virtuel reste ouvert.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => pressKey(k));
    if (k.mod) modButtons[k.mod] = b;
    bar.appendChild(b);
  }
  return bar;
}

async function pressKey(k) {
  if (!active) return;
  if (k.mod) {
    mods[k.mod] = !mods[k.mod];
    renderMods();
    return;
  }
  if (k.arrow) {
    const appMode = active.term.modes?.applicationCursorKeysMode;
    active.sendInput(applyModifiers(`${appMode ? '\x1bO' : '\x1b['}${k.arrow}`));
    return;
  }
  if (k.send) { active.sendInput(applyModifiers(k.send)); return; }
  if (k.action === 'blur') { active.term.blur(); document.activeElement?.blur?.(); return; }
  if (k.action === 'copy') {
    const sel = active.term.getSelection();
    if (!sel) { toast('Aucune sélection', 'warn', 1500); return; }
    try { await navigator.clipboard.writeText(sel); toast('Sélection copiée', 'ok', 1500); } catch { toast('Copie refusée (HTTPS requis)', 'warn'); }
    return;
  }
  if (k.action === 'paste') { paste(); return; }
  if (k.action === 'dictate') { dictate(); }
}

async function paste() {
  const tab = active;
  try {
    const text = await navigator.clipboard.readText();
    if (text) tab.term.paste(text);
    return;
  } catch { /* API indisponible (HTTP, permission) → saisie manuelle */ }
  const area = h('textarea', { class: 'textarea', rows: 6, 'aria-label': 'Texte à coller' });
  const d = openDialog({
    title: 'Coller dans le terminal',
    body: h('div', { class: 'stack' }, h('p', { class: 'dim' }, 'Le navigateur bloque la lecture du presse-papiers : collez ici (appui long → Coller).'), area),
    actions: [button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close() }),
      button({ label: 'Envoyer', variant: 'primary', onClick: () => { tab.term.paste(area.value); d.close(); } })],
  });
  setTimeout(() => area.focus(), 30);
}

function dictate() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !active) return;
  const tab = active;
  const rec = new SR();
  rec.lang = prefs.get('speechLang', 'fr-FR');
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  toast('Parlez… (la commande sera saisie sans être exécutée)', 'info', 3000);
  rec.onresult = (e) => {
    const text = e.results[0]?.[0]?.transcript;
    if (text) tab.sendInput(text);
  };
  rec.onerror = (e) => toast(`Dictée indisponible : ${e.error}`, 'warn');
  rec.start();
}

export default {
  mount(el, { params }) {
    if (!window.Terminal || !window.FitAddon) {
      el.appendChild(emptyState({ icon: 'warning', title: 'xterm.js non chargé', text: 'Rechargez la page.' }));
      return;
    }
    const tabsEl = h('div', { class: 'term-tabs', role: 'tablist', 'aria-label': 'Terminaux ouverts' });
    const stage = h('div', { class: 'term-stage' });
    const empty = emptyState({
      icon: 'terminal', title: 'Aucun terminal ouvert',
      text: 'Ouvrez un shell sur un hôte de votre tailnet.',
      action: button({ label: 'Nouveau terminal', icon: 'plus', variant: 'primary', onClick: pickHost }),
    });
    stage.appendChild(empty);
    const keybar = buildKeybar();
    ui = { tabs: tabsEl, stage, keybar, empty };
    el.append(h('div', { class: 'term-view' }, tabsEl, stage, keybar));
    termSettings.apply();
    renderTabs();
    renderEmpty();

    new ResizeObserver(() => active?.fitSoon()).observe(stage);
    window.addEventListener('corvus:viewport', () => active?.fitSoon());
    window.addEventListener('online', () => tabs.forEach((t) => t.nudge()));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tabs.forEach((t) => t.nudge());
    });

    // Restaurer les sessions encore vivantes côté serveur (rechargement de page).
    get('/api/terminals').then(({ terminals }) => {
      for (const s of terminals) if (!s.exited && !tabs.some((t) => t.sessionId === s.id)) openTab(s.hostId, s.id, false);
      if (!active && tabs.length) activate(tabs[0], false);
      this.show({ params });
    }).catch(() => this.show({ params }));
  },

  show({ params }) {
    const hostId = params?.get('host');
    if (hostId && state.host(hostId)) {
      history.replaceState(null, '', '#/terminal');
      openTab(hostId);
    } else {
      active?.fitSoon(true);
      if (active && !matchMedia('(pointer: coarse)').matches) active.term.focus();
    }
  },
};
