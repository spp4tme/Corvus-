// Démarrage, coquille de l'application et routeur (hash).
import { get, setUnauthorizedHandler, onNetwork, reportNetwork } from './api.js';
import { h, clear } from './ui/dom.js';
import { icon, logo } from './ui/icons.js';
import { state } from './state.js';
import { renderLogin } from './views/login.js';

const ROUTES = {
  hosts: { title: 'Hôtes', icon: 'server', load: () => import('./views/hosts.js') },
  terminal: { title: 'Terminal', icon: 'terminal', load: () => import('./views/terminal.js'), persistent: true, full: true },
  claude: { title: 'Claude', icon: 'sparkle', load: () => import('./views/claude.js') },
  files: { title: 'Fichiers', icon: 'folder', load: () => import('./views/files.js') },
  git: { title: 'Git', icon: 'git', load: () => import('./views/git.js') },
  monitor: { title: 'Supervision', icon: 'activity', load: () => import('./views/monitor.js') },
  journal: { title: 'Journal', icon: 'journal', load: () => import('./views/journal.js'), secondary: true },
  proxy: { title: 'Services web', icon: 'link', load: () => import('./views/proxy.js'), secondary: true },
  settings: { title: 'Réglages', icon: 'settings', load: () => import('./views/settings.js'), secondary: true },
  more: { title: 'Plus', icon: 'more', load: () => import('./views/more.js'), mobileOnly: true },
};
const NAV = ['hosts', 'terminal', 'claude', 'files', 'git', 'monitor', 'journal', 'settings', 'more'];

const root = document.getElementById('root');
let shell = null;

/** Hauteur réelle visible (clavier virtuel inclus) → --app-height. */
function trackViewport() {
  const vv = window.visualViewport;
  const update = () => {
    const height = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
    const keyboardOpen = vv ? window.innerHeight - vv.height > 120 : false;
    shell?.app.classList.toggle('keyboard-open', keyboardOpen);
    if (vv && vv.offsetTop) window.scrollTo(0, 0);
    window.dispatchEvent(new CustomEvent('corvus:viewport'));
  };
  (vv || window).addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  update();
}

function buildShell() {
  const title = h('h1', { class: 'view-title ellipsis' });
  // Signal discret dans l'en-tête : espace disque faible, alertes non acquittées.
  const banner = h('a', { class: 'app-banner', href: '#/settings', hidden: true, role: 'status' });
  // Pastille : liaison avec le serveur Corvus (verte / rouge), mise à jour à chaque requête.
  const dot = h('span', { class: 'conn-dot', role: 'img', 'aria-label': 'Serveur Corvus joignable', title: 'Serveur Corvus joignable' });
  onNetwork((ok) => {
    dot.classList.toggle('offline', !ok);
    const label = ok ? 'Serveur Corvus joignable' : 'Serveur Corvus injoignable — nouvelle tentative automatique';
    dot.setAttribute('aria-label', label);
    dot.title = label;
  });
  const main = h('main', { class: 'app-main', id: 'main' });
  const nav = h('nav', { class: 'app-nav', 'aria-label': 'Navigation principale' });
  const links = {};
  for (const key of NAV) {
    const r = ROUTES[key];
    const cls = ['nav-item', r.mobileOnly && 'nav-more-only', r.secondary && 'nav-wide-only'].filter(Boolean).join(' ');
    links[key] = h('a', { class: cls, href: `#/${key}` }, icon(r.icon), h('span', null, r.title));
    nav.appendChild(links[key]);
  }
  const app = h('div', { class: 'app' },
    h('header', { class: 'app-header' },
      h('a', { class: 'brand', href: '#/hosts', 'aria-label': 'Corvus — accueil' }, logo(), h('span', { class: 'brand-name' }, 'Corvus')),
      h('span', { class: 'faint', 'aria-hidden': 'true' }, '·'),
      title, banner, dot),
    main, nav);
  clear(root).appendChild(app);
  return { app, main, nav, links, title, banner, mounted: {}, current: null, cleanup: null };
}

async function route() {
  if (!shell) return;
  const [, key = 'hosts', ...rest] = (location.hash || '#/hosts').split('?')[0].split('/');
  const r = ROUTES[key] || ROUTES.hosts;
  const name = ROUTES[key] ? key : 'hosts';
  const params = new URLSearchParams(location.hash.split('?')[1] || '');

  for (const [k, a] of Object.entries(shell.links)) {
    if (k === name || (name !== 'more' && ROUTES[name].secondary && k === 'more')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  shell.title.textContent = r.title;
  document.title = `${r.title} — Corvus`;

  // Démonter la vue précédente (les vues persistantes sont seulement masquées).
  if (shell.cleanup) { try { shell.cleanup(); } catch (e) { console.error(e); } shell.cleanup = null; }
  for (const [k, el] of Object.entries(shell.mounted)) el.hidden = k !== name;
  for (const el of [...shell.main.children]) if (!el.dataset.persistent) el.remove();
  shell.main.classList.toggle('no-scroll', !!r.full);
  shell.current = name;

  const mod = await r.load();
  if (shell.current !== name) return;
  if (r.persistent) {
    if (!shell.mounted[name]) {
      const el = h('section', { class: 'view-full', dataset: { persistent: '1' } });
      shell.main.appendChild(el);
      shell.mounted[name] = el;
      mod.default.mount(el, { params, rest });
    } else {
      shell.mounted[name].hidden = false;
      mod.default.show?.({ params, rest });
    }
  } else {
    const el = h('section', { class: r.full ? 'view-full' : 'view' });
    shell.main.appendChild(el);
    shell.cleanup = mod.default.mount(el, { params, rest }) || null;
  }
}

let viewportTracked = false;
let loginShown = false;

let systemTimer = null;
async function checkSystem() {
  if (!shell) return;
  try {
    const st = await get('/api/system/status');
    const parts = [];
    if (st.storage.low) parts.push('Espace disque faible');
    if (st.alerts.open) parts.push(`${st.alerts.open} alerte${st.alerts.open > 1 ? 's' : ''}`);
    shell.banner.textContent = parts.length ? `⚠ ${parts.join(' · ')}` : '';
    shell.banner.hidden = !parts.length;
    shell.banner.href = st.storage.low ? '#/settings' : '#/journal';
  } catch { /* hors ligne : on réessaiera */ }
}

async function startApp() {
  loginShown = false;
  shell = buildShell();
  if (!viewportTracked) { trackViewport(); viewportTracked = true; }
  try { await state.refreshHosts(); } catch { /* la vue affichera l'erreur */ }
  window.removeEventListener('hashchange', route);
  window.addEventListener('hashchange', route);
  await route();
  checkSystem();
  clearInterval(systemTimer);
  systemTimer = setInterval(checkSystem, 5 * 60_000);
}

function showLogin(opts) {
  loginShown = true;
  renderLogin(root, boot, opts);
}

async function boot() {
  setUnauthorizedHandler(() => {
    // Plusieurs requêtes peuvent échouer en même temps (ou une vue continuer à interroger l'API) :
    // l'écran de connexion n'est affiché qu'une fois, sinon la saisie en cours serait effacée.
    if (loginShown) return;
    if (shell?.cleanup) { try { shell.cleanup(); } catch (e) { console.error(e); } }
    shell = null;
    window.removeEventListener('hashchange', route);
    showLogin();
  });
  let status;
  try {
    status = await get('/api/auth/status');
  } catch {
    status = { authenticated: false, offline: true };
  }
  if (!status.authenticated) {
    showLogin({ offline: status.offline, setupRequired: status.setupRequired });
    return;
  }
  state.setMe(status.user);
  await startApp();
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Perte de réseau : pastille rouge tout de suite, puis petite requête toutes les 10 s jusqu'au retour.
window.addEventListener('offline', () => reportNetwork(false));
window.addEventListener('online', () => get('/api/health').catch(() => {}));
onNetwork((ok) => {
  clearInterval(window.corvusPing);
  if (!ok) window.corvusPing = setInterval(() => get('/api/health').catch(() => {}), 10_000);
});

boot();
