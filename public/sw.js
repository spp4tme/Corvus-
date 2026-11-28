// Service worker Corvus : coquille de l'app disponible hors ligne.
// L'API, les WebSockets, les téléchargements et le proxy ne sont JAMAIS mis en cache.
importScripts('/sw-actions.js', '/sw-share.js'); // actions des notifications et « Partager vers Corvus » (logique pure, testée à part)
const VERSION = 'corvus-v32';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/css/tokens.css', '/css/app.css',
  '/vendor/xterm.css', '/vendor/xterm.js', '/vendor/addon-fit.js',
  '/sw-actions.js', '/sw-share.js', '/js/main.js', '/js/api.js', '/js/state.js', '/js/push.js', '/js/terminal-themes.js', '/js/voice.js',
  '/js/ui/dom.js', '/js/ui/icons.js', '/js/ui/components.js', '/js/ui/hostpicker.js', '/js/ui/chart.js',
  '/js/views/login.js', '/js/views/hosts.js', '/js/views/terminal.js', '/js/views/claude.js', '/js/views/files.js',
  '/js/views/git.js', '/js/views/monitor.js', '/js/views/journal.js', '/js/views/proxy.js',
  '/js/views/agents.js', '/js/views/playbooks.js', '/js/views/rewind.js', '/js/views/xray.js', '/js/views/compare.js', '/js/views/copy-dialog.js', '/js/views/share.js', '/js/ui/diffview.js', '/js/ui/agent-support.js', '/js/views/settings.js', '/js/views/more.js', '/js/views/storage-settings.js', '/js/views/accounts-settings.js', '/js/views/recordings.js', '/js/passkey.js', '/js/cmdbar.js', '/js/views/commands.js', '/js/views/admin.js',
  '/icons/logo.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isPrivate(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname.startsWith('/proxy/');
}

// « Partager vers Corvus » : le menu Partager envoie un POST multipart à /share-target. On garde les fichiers dans le
// navigateur (stockage temporaire, propre au compte connecté) puis on ouvre l'écran qui demande l'hôte et le dossier :
// RIEN n'est envoyé au serveur sans ce choix.
async function handleShare(req) {
  const to = (hash) => Response.redirect(new URL(`/#/share${hash}`, self.location.origin).href, 303);
  try {
    if (!self.CorvusShare.sourceAllowed((n) => req.headers.get(n), self.location.origin)) return to('?error=' + encodeURIComponent('origine refusée : seul le menu Partager du système ou Corvus lui-même peut déposer un fichier'));
    const me = await fetch('/api/me', { credentials: 'same-origin', headers: { 'X-Corvus': '1' } });
    if (!me.ok) return to('?login=1');
    const owner = (await me.json())?.user?.id;
    const meta = await self.CorvusShare.create({ caches }).store(await req.formData(), owner);
    return to(`?id=${meta.id}`);
  } catch (err) {
    return to(`?error=${encodeURIComponent(String(err?.message || 'échec').slice(0, 120))}`);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-target') {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin || isPrivate(url)) return;

  // Navigation : réseau d'abord (version à jour), coquille en cache si hors ligne.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }
  // Ressources statiques : cache, puis mise à jour en arrière-plan.
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});

// Notifications push (commande longue, alertes) — voir docs/notifications.md.
// Le push est SANS contenu : le détail et les boutons viennent de /api/push/latest (cookie de session).
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let n = {};
    try {
      const res = await fetch('/api/push/latest', { credentials: 'same-origin', headers: { 'X-Corvus': '1' } });
      if (res.ok) n = (await res.json()).notification || {};
    } catch { /* message générique */ }
    const { title, options } = self.CorvusSW.buildNotification(n);
    await self.registration.showNotification(title, options);
  })());
});

async function openApp(target) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if ('focus' in c) { await c.focus(); if (c.navigate) await c.navigate(target); return; }
  }
  await self.clients.openWindow(target);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const todo = self.CorvusSW.decideClick(event.action, event.notification.data);
  event.waitUntil((async () => {
    if (todo.kind === 'ack') {
      // Acquitter : la session (cookie SameSite=Strict) et les droits du compte décident ; le serveur répond 404 / 403 sinon.
      const { url, init } = self.CorvusSW.ackRequest(todo.alertId);
      let ok = false;
      try { ok = (await fetch(url, init)).ok; } catch { ok = false; }
      await self.registration.showNotification(ok ? 'Alerte acquittée' : 'Acquittement impossible', {
        body: ok ? '' : 'Ouvrez Corvus : la session a peut-être expiré, ou ce compte n\'a pas le droit d\'acquitter cette alerte.',
        icon: '/icons/icon-192.png', tag: `ack-${todo.alertId}`, silent: true,
      });
      return;
    }
    await openApp(todo.url);
  })());
});
