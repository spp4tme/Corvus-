// Service worker Corvus : coquille de l'app disponible hors ligne.
// L'API, les WebSockets, les téléchargements et le proxy ne sont JAMAIS mis en cache.
const VERSION = 'corvus-v2';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/css/tokens.css', '/css/app.css',
  '/vendor/xterm.css', '/vendor/xterm.js', '/vendor/addon-fit.js',
  '/js/main.js', '/js/api.js', '/js/state.js', '/js/push.js', '/js/terminal-themes.js',
  '/js/ui/dom.js', '/js/ui/icons.js', '/js/ui/components.js', '/js/ui/hostpicker.js', '/js/ui/chart.js',
  '/js/views/login.js', '/js/views/hosts.js', '/js/views/terminal.js', '/js/views/files.js',
  '/js/views/git.js', '/js/views/monitor.js', '/js/views/journal.js', '/js/views/proxy.js',
  '/js/views/settings.js', '/js/views/more.js',
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
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

// Notifications push (commande longue terminée) — voir docs/notifications.md.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let n = { title: 'Corvus', body: 'Une commande est terminée.' };
    try {
      const res = await fetch('/api/push/latest', { credentials: 'same-origin', headers: { 'X-Corvus': '1' } });
      if (res.ok) n = { ...n, ...(await res.json()).notification };
    } catch { /* message générique */ }
    await self.registration.showNotification(n.title, {
      body: n.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      tag: n.sessionId || 'corvus', data: { url: n.sessionId ? '/#/terminal' : '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { await c.focus(); c.navigate?.(target); return; }
    }
    await self.clients.openWindow(target);
  })());
});
