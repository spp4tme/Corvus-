// Vue Services web : ouvrir un service privé du tailnet via le proxy isolé de Corvus.
import { get, post, del } from '../api.js';
import { h, replace } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, field, input, openDialog, confirmDialog, toast, toastError, loadingState, emptyState, errorState } from '../ui/components.js';

export default {
  mount(el) {
    const list = h('div');
    el.append(
      h('div', { class: 'toolbar' }, h('p', { class: 'dim grow' }, 'Ouvrez une interface web privée (Grafana, Home Assistant, Uptime Kuma…) à travers Corvus.'),
        button({ label: 'Ajouter', icon: 'plus', variant: 'primary', onClick: add })),
      list,
      h('details', { class: 'card card-pad values-table' },
        h('summary', null, 'Comment ça marche, et limites'),
        h('ul', { class: 'stack dim' },
          h('li', null, 'Seules les adresses Tailscale (100.x, *.ts.net) et locales au serveur Corvus sont autorisées.'),
          h('li', null, 'La page s\'ouvre sous /proxy/<jeton>/ dans un bac à sable : elle ne peut pas accéder à Corvus ni à vos terminaux.'),
          h('li', null, 'Conséquence : les applications qui exigent des cookies (connexion) ou des chemins absolus (/static/…) peuvent mal s\'afficher. Configurez leur « base URL » si possible, ou ouvrez-les directement via http://machine:port sur le tailnet.'),
          h('li', null, 'Un lien de proxy expire après 12 h d\'inactivité.'))));

    async function load() {
      replace(list, loadingState());
      try {
        const { enabled, services } = await get('/api/services');
        if (!enabled) return replace(list, emptyState({ icon: 'link', title: 'Proxy désactivé', text: 'CORVUS_WEB_PROXY=0 sur le serveur.' }));
        if (!services.length) return replace(list, emptyState({ icon: 'link', title: 'Aucun service', text: 'Ajoutez l\'URL d\'un service de votre tailnet.' }));
        replace(list, h('ul', { class: 'list' }, services.map((s) => {
          const openBtn = button({ label: 'Ouvrir', icon: 'external', variant: 'primary' });
          // Fenêtre ouverte immédiatement (geste utilisateur), puis redirigée : évite le blocage des popups.
          openBtn.addEventListener('click', async () => {
            const win = window.open('about:blank', '_blank');
            try {
              const r = await busy(openBtn, () => post(`/api/services/${s.id}/open`));
              if (win) { win.opener = null; win.location.href = r.url; } else location.href = r.url;
            } catch (err) { win?.close(); toastError(err); }
          });
          return h('li', null, h('div', { class: 'list-item' },
            h('span', { class: 'host-icon' }, icon('globe')),
            h('div', { class: 'grow' }, h('div', { class: 'host-name ellipsis' }, s.name), h('div', { class: 'host-addr ellipsis' }, s.url)),
            openBtn,
            button({ label: `Supprimer ${s.name}`, icon: 'trash', iconOnly: true, variant: 'ghost', onClick: () => remove(s) })));
        })));
      } catch (err) { replace(list, errorState(err, load)); }
    }

    function add() {
      const name = input({ placeholder: 'ex. Grafana' });
      const url = input({ placeholder: 'http://grafana.tailnet.ts.net:3000', inputmode: 'url' });
      const fName = field({ label: 'Nom', control: name });
      const fUrl = field({ label: 'URL du service', control: url, hint: 'IP Tailscale, nom MagicDNS ou http://127.0.0.1:port (service local au serveur Corvus).' });
      const save = button({ label: 'Ajouter', variant: 'primary', icon: 'save' });
      const d = openDialog({ title: 'Nouveau service web', body: h('div', { class: 'stack' }, fName, fUrl), actions: [button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close() }), save] });
      save.addEventListener('click', async () => {
        fName.setError(name.value.trim() ? null : 'Nom requis');
        fUrl.setError(/^https?:\/\//.test(url.value.trim()) ? null : 'URL http:// ou https:// requise');
        if (!name.value.trim() || !/^https?:\/\//.test(url.value.trim())) return;
        try {
          await busy(save, () => post('/api/services', { name: name.value, url: url.value }));
          d.close();
          toast('Service ajouté', 'ok');
          load();
        } catch (err) { fUrl.setError(err.message); }
      });
      setTimeout(() => name.focus(), 30);
    }

    async function remove(s) {
      if (!await confirmDialog({ title: 'Supprimer le service ?', message: `« ${s.name} » sera retiré de la liste.`, confirmLabel: 'Supprimer', danger: true })) return;
      try { await del(`/api/services/${s.id}`); load(); } catch (err) { toastError(err); }
    }
    load();
  },
};
