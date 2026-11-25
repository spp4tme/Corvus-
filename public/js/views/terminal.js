// Vue Terminal : onglets multiples (xterm.js), reconnexion WebSocket automatique avec reprise
// à l'octet près, barre de touches mobile, OSC52, thèmes, taille de police.
import { get, del } from '../api.js';
import { h, clear, replace, prefs } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, openDialog, emptyState, toast, badge } from '../ui/components.js';
import { state, sortedHosts } from '../state.js';
import { terminalTheme } from '../terminal-themes.js';
import { parseUtterance, createVoice, voiceSupported } from '../voice.js';

const tabs = [];
let active = null;
let ui = null;
const mods = { ctrl: false, alt: false };
let globalsBound = false;

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
  constructor({ hostId, sessionId = null, title, claude = null, isClaude = false }) {
    this.hostId = hostId;
    this.claude = claude; // { session?, dir? } : premier lancement d'une session Claude Code
    this.isClaude = isClaude || !!claude;
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
    this.bindTouchScroll(host);

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
      if (this.claude) {
        q.set('claude', '1');
        if (this.claude.session) q.set('claudeSession', this.claude.session);
        if (this.claude.dir !== undefined) q.set('claudeDir', this.claude.dir);
      }
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
        this.tmux = !!msg.session.tmux;
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
    // Un refus d'authentification (session expirée) ressemble à une coupure réseau côté WebSocket :
    // une requête API de temps en temps fait apparaître l'écran de connexion si besoin.
    if (this.attempts % 4 === 0) get('/api/terminals').catch(() => {});
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

  /** Glisser un doigt = molette : défile l'historique (tmux en mode souris, scrollback xterm, ou copy-mode tmux). */
  bindTouchScroll(host) {
    let y0 = null;
    let acc = 0;
    host.addEventListener('touchstart', (e) => {
      y0 = e.touches.length === 1 ? e.touches[0].clientY : null;
      acc = 0;
    }, { passive: true });
    host.addEventListener('touchmove', (e) => {
      if (y0 === null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      acc += y - y0;
      y0 = y;
      const step = Math.max(12, host.clientHeight / this.term.rows) * 0.6;
      const n = Math.trunc(acc / step);
      if (!n) return;
      acc -= n * step;
      e.preventDefault();
      this.touchScroll(n > 0 ? -1 : 1, Math.min(Math.abs(n), 20));
    }, { passive: false });
    host.addEventListener('touchend', () => { y0 = null; }, { passive: true });
  }

  touchScroll(dir, n) {
    const t = this.term;
    if (t.modes?.mouseTrackingMode && t.modes.mouseTrackingMode !== 'none') {
      // Molette SGR (64 = haut, 65 = bas) : tmux (mouse on) entre/sort seul du mode copie.
      const seq = `\x1b[<${dir < 0 ? 64 : 65};${Math.ceil(t.cols / 2)};${Math.ceil(t.rows / 2)}M`;
      this.sendInput(seq.repeat(n));
    } else if (t.buffer.active.type === 'normal') {
      t.scrollLines(dir * n * 5);
    } else if (this.tmux) {
      scrollHistory(dir);
    }
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

function openTab(hostId, sessionId, focus = true, { title, claude, isClaude } = {}) {
  const host = state.host(hostId);
  const tab = new Tab({ hostId, sessionId, title: title || `${host?.name || 'Terminal'}${claude ? ' · Claude' : ''}`, claude, isClaude });
  tabs.push(tab);
  activate(tab, focus);
  return tab;
}

function activate(tab, focus = true) {
  active = tab;
  for (const t of tabs) t.pane.hidden = t !== tab;
  renderTabs();
  renderEmpty();
  updateClaudeKeys();
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
  { label: '⇧Tab', send: '\x1b[Z', title: 'Shift+Tab (changer de mode dans Claude Code)', claudeOnly: true },
  { label: 'Entrée', send: '\r', title: 'Entrée', claudeOnly: true },
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
  { label: 'Contrôle vocal (écoute continue)', icon: 'mic', action: 'dictate', optional: true },
  { label: 'Masquer le clavier', icon: 'keyboard', action: 'blur' },
];
const modButtons = {};
const claudeKeys = [];

// ⇧Tab et Entrée ne s'affichent que dans un onglet Claude Code (le terminal ordinaire reste inchangé).
function updateClaudeKeys() {
  for (const b of claudeKeys) b.style.display = active?.isClaude ? '' : 'none';
}

function renderMods() {
  for (const [k, b] of Object.entries(modButtons)) b.setAttribute('aria-pressed', String(mods[k]));
}

function buildKeybar() {
  const bar = h('div', { class: 'keybar', role: 'toolbar', 'aria-label': 'Touches spéciales' });
  for (const k of KEYS) {
    if (k.optional && !voiceSupported()) continue;
    const b = h('button', {
      type: 'button', class: 'key', title: k.title || k.label, 'aria-label': k.icon || k.title ? k.title || k.label : undefined,
      'aria-pressed': k.mod ? 'false' : undefined,
    }, k.icon ? icon(k.icon) : k.label);
    // Ne pas voler le focus au terminal : le clavier virtuel reste ouvert.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => pressKey(k));
    if (k.mod) modButtons[k.mod] = b;
    if (k.action === 'dictate') { voiceMic = b; b.setAttribute('aria-pressed', 'false'); }
    if (k.claudeOnly) { claudeKeys.push(b); b.style.display = 'none'; }
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

/** Défilement de l'historique sans souris : copy-mode de tmux (Ctrl-b [) + PageUp/PageDown, sinon scrollback xterm. */
function scrollHistory(dir) {
  const tab = active;
  if (tab.tmux) {
    if (dir < 0) tab.sendInput('\x02[');
    tab.sendInput(dir < 0 ? '\x1b[5~' : '\x1b[6~');
  } else {
    tab.term.scrollPages(dir);
  }
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

// --- Contrôle vocal ---------------------------------------------------------------------------
// Écoute continue : le texte dicté est saisi SANS être exécuté ; « entrée » (ou « envoie ») valide,
// « annule » = Ctrl-C, « monte/descends » fait défiler, « arrête l'écoute » coupe le micro.
let voice = null;
let voiceTab = null;
let voiceMic = null;
let voicePill = null;

function setPill(text, listening = true) {
  if (!voicePill) return;
  voicePill.hidden = !listening;
  voicePill.querySelector('.voice-text').textContent = text || 'Je vous écoute… (« entrée », « annule », « arrête l’écoute »)';
}

function runVoiceAction(a) {
  const tab = voiceTab && tabs.includes(voiceTab) ? voiceTab : active;
  if (!tab) return;
  if (a.kind === 'stop') { voice.stop(); return; }
  if (a.kind === 'text') tab.sendInput(a.v);
  else if (a.kind === 'key') tab.sendInput(a.v);
  else if (a.kind === 'arrow') {
    const appMode = tab.term.modes?.applicationCursorKeysMode;
    tab.sendInput(`${appMode ? '\x1bO' : '\x1b['}${a.v}`);
  } else if (a.kind === 'scroll') { const prev = active; active = tab; scrollHistory(a.v); active = prev; }
  navigator.vibrate?.(8);
}

function dictate() {
  if (!active) return;
  if (voice?.active) { voice.stop(); return; }
  voiceTab = active;
  voice = createVoice({
    lang: prefs.get('speechLang', 'fr-FR'),
    onText: (t) => {
      const tab = voiceTab && tabs.includes(voiceTab) ? voiceTab : active;
      const actions = parseUtterance(t, { shell: !tab?.isClaude });
      if (actions.length) setPill(`« ${t.trim()} »`);
      actions.forEach(runVoiceAction);
    },
    onInterim: (t) => { if (voice?.active) setPill(t ? `${t}…` : ''); },
    onState: (on) => {
      voiceMic?.setAttribute('aria-pressed', String(on));
      voiceMic?.classList.toggle('listening', on);
      setPill('', on);
    },
    onError: (m) => toast(m, 'warn', 4000),
  });
  voice.start();
}

export default {
  mount(el, { params }) {
    if (!window.Terminal || !window.FitAddon) {
      el.appendChild(emptyState({ icon: 'warning', title: 'xterm.js non chargé', text: 'Rechargez la page.' }));
      return;
    }
    // Remontage après une reconnexion (session expirée) : l'ancien DOM a disparu. Les sessions
    // serveur restent vivantes et sont rattachées ci-dessous.
    voice?.stop();
    for (const t of tabs.splice(0)) t.dispose(false);
    active = null;
    for (const k of Object.keys(modButtons)) delete modButtons[k];
    claudeKeys.length = 0;
    const tabsEl = h('div', { class: 'term-tabs', role: 'tablist', 'aria-label': 'Terminaux ouverts' });
    const stage = h('div', { class: 'term-stage' });
    const empty = emptyState({
      icon: 'terminal', title: 'Aucun terminal ouvert',
      text: 'Ouvrez un shell sur un hôte de votre tailnet.',
      action: button({ label: 'Nouveau terminal', icon: 'plus', variant: 'primary', onClick: pickHost }),
    });
    stage.appendChild(empty);
    const keybar = buildKeybar();
    voicePill = h('button', { type: 'button', class: 'voice-pill', hidden: true, 'aria-live': 'polite', title: 'Toucher pour arrêter l’écoute' },
      icon('mic'), h('span', { class: 'voice-text' }));
    voicePill.addEventListener('click', () => voice?.stop());
    stage.appendChild(voicePill);
    ui = { tabs: tabsEl, stage, keybar, empty };
    el.append(h('div', { class: 'term-view' }, tabsEl, stage, keybar));
    termSettings.apply();
    renderTabs();
    renderEmpty();

    new ResizeObserver(() => active?.fitSoon()).observe(stage);
    if (!globalsBound) {
      globalsBound = true;
      window.addEventListener('corvus:viewport', () => active?.fitSoon());
      window.addEventListener('online', () => tabs.forEach((t) => t.nudge()));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') tabs.forEach((t) => t.nudge());
      });
    }

    // Restaurer les sessions encore vivantes côté serveur (rechargement de page).
    get('/api/terminals').then(({ terminals }) => {
      for (const s of terminals) if (!s.exited && !tabs.some((t) => t.sessionId === s.id)) openTab(s.hostId, s.id, false, { title: s.claude ? s.title : undefined, isClaude: !!s.claude });
      if (!active && tabs.length) activate(tabs[0], false);
      this.show({ params });
    }).catch(() => this.show({ params }));
  },

  show({ params }) {
    const hostId = params?.get('host');
    if (hostId && state.host(hostId)) {
      history.replaceState(null, '', '#/terminal');
      if (params.get('claude') === '1') {
        const claude = {};
        if (params.get('claudeSession')) claude.session = params.get('claudeSession');
        if (params.has('claudeDir')) claude.dir = params.get('claudeDir');
        openTab(hostId, null, true, { claude });
      } else openTab(hostId);
    } else {
      active?.fitSoon(true);
      if (active && !matchMedia('(pointer: coarse)').matches) active.term.focus();
    }
  },
};
