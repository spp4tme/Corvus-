// Notifications push (Web Push + VAPID) : abonnement de cet appareil, test.
import { get, post, del } from './api.js';
import { h, replace } from './ui/dom.js';
import { button, busy, toast, toastError } from './ui/components.js';

function keyToBytes(b64url) {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function renderPushSettings(slot) {
  const box = h('div', { class: 'card card-pad stack' });
  replace(slot, h('h2', { class: 'section-title' }, 'Notifications'), box);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported || !window.isSecureContext) {
    replace(box, h('p', { class: 'dim' }, window.isSecureContext
      ? 'Ce navigateur ne gère pas les notifications push. Sur iPhone/iPad : installez d\'abord Corvus sur l\'écran d\'accueil (iOS 16.4+).'
      : 'Les notifications exigent HTTPS : accédez à Corvus via https://<machine>.<tailnet>.ts.net (tailscale serve).'));
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const render = async () => {
    const sub = await reg.pushManager.getSubscription();
    const status = h('p', { class: 'dim' }, sub
      ? 'Cet appareil reçoit les notifications (commande longue terminée, voir docs/notifications.md).'
      : Notification.permission === 'denied' ? 'Notifications bloquées dans les réglages du navigateur.' : 'Recevez une notification quand une commande longue se termine.');
    const actions = h('div', { class: 'row wrap' });
    if (sub) {
      const test = button({ label: 'Envoyer un test', icon: 'bell' });
      test.addEventListener('click', () => busy(test, () => post('/api/push/test')).then((r) => toast(r.sent ? 'Test envoyé' : 'Aucun appareil joignable', r.sent ? 'ok' : 'warn')).catch(toastError));
      const off = button({ label: 'Désactiver', variant: 'ghost' });
      off.addEventListener('click', async () => {
        try { await del('/api/push/subscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); render(); } catch (err) { toastError(err); }
      });
      actions.append(test, off);
    } else if (Notification.permission !== 'denied') {
      const on = button({ label: 'Activer sur cet appareil', icon: 'bell', variant: 'primary' });
      on.addEventListener('click', () => busy(on, async () => {
        if (await Notification.requestPermission() !== 'granted') { toast('Permission refusée', 'warn'); return; }
        const { publicKey } = await get('/api/push/key');
        const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
        await post('/api/push/subscribe', { endpoint: s.endpoint, label: navigator.userAgent.slice(0, 80) });
        toast('Notifications activées', 'ok');
        render();
      }).catch(toastError));
      actions.append(on);
    }
    replace(box, status, actions);
  };
  render();
}
