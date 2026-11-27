// Logique des actions de notification, SANS effet de bord : le service worker (sw.js) l'importe, et les tests la
// chargent dans une machine virtuelle Node. Rien ici ne touche au réseau ni au DOM.
//
// Principes :
//   - le push ne contient AUCUNE donnée ; le détail (et la liste des boutons, calculée par le serveur selon les
//     droits du compte) vient de /api/push/latest, avec le cookie de session ;
//   - « Isoler… » n'isole jamais : il OUVRE l'écran de confirmation de l'application (lien profond) ;
//   - seules les actions connues sont affichées, seules des adresses internes (« /… ») sont ouvertes.
(function (root) {
  const ALLOWED = ['open', 'ack', 'isolate'];
  const MAX_ACTIONS = 3;

  /** Adresse interne uniquement : « /… » (pas « // », pas de schéma, pas de contrôle) ; sinon la page d'accueil. */
  function safeUrl(url) {
    if (typeof url !== 'string' || url.length > 300) return '/';
    if (!url.startsWith('/') || url.startsWith('//') || /[\u0000-\u001f\\]/.test(url)) return '/';
    return url;
  }

  /** Titre + options de showNotification à partir du détail renvoyé par le serveur. */
  function buildNotification(n) {
    const base = { title: 'Corvus', body: 'Une commande est terminée.' };
    const d = { ...base, ...(n || {}) };
    const actions = (Array.isArray(d.actions) ? d.actions : [])
      .filter((a) => a && ALLOWED.includes(a.action))
      .slice(0, MAX_ACTIONS)
      .map((a) => ({ action: a.action, title: String(a.title || a.action).slice(0, 30), url: a.action === 'ack' ? undefined : safeUrl(a.url), alertId: Number.isInteger(a.alertId) ? a.alertId : undefined }));
    const open = actions.find((a) => a.action === 'open');
    return {
      title: String(d.title).slice(0, 120),
      options: {
        body: String(d.body).slice(0, 400),
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: d.sessionId || (d.alertId ? `alerte-${d.alertId}` : 'corvus'),
        // Android affiche les boutons ; certains systèmes (iOS) les ignorent : le corps de la notification ouvre aussi l'application.
        actions: actions.map((a) => ({ action: a.action, title: a.title })),
        data: { url: open ? open.url : safeUrl(d.sessionId ? '/#/terminal' : '/'), actions },
      },
    };
  }

  /** Que faire d'un clic ? { kind: 'ack', alertId } | { kind: 'open', url } */
  function decideClick(action, data) {
    const list = (data && Array.isArray(data.actions)) ? data.actions : [];
    const wanted = list.find((a) => a.action === action);
    if (action === 'ack' && wanted && Number.isInteger(wanted.alertId)) return { kind: 'ack', alertId: wanted.alertId };
    if (action === 'isolate' && wanted) return { kind: 'open', url: safeUrl(wanted.url) };   // jamais d'isolement direct
    return { kind: 'open', url: safeUrl(data && data.url) };
  }

  /** Requête d'acquittement : cookie de session + en-tête anti-CSRF. */
  function ackRequest(alertId) {
    return { url: `/api/alerts/${Number(alertId)}/ack`, init: { method: 'POST', credentials: 'same-origin', headers: { 'X-Corvus': '1', 'content-type': 'application/json' }, body: '{}' } };
  }

  root.CorvusSW = { safeUrl, buildNotification, decideClick, ackRequest, ALLOWED, MAX_ACTIONS };
}(typeof self !== 'undefined' ? self : globalThis));
