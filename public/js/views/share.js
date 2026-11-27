// Écran « Partager vers Corvus » : les fichiers reçus du menu Partager (gardés TEMPORAIREMENT dans ce navigateur)
// ne partent qu'après le choix explicite de l'hôte et du dossier. Chaque dépôt appartient au compte connecté.
import { upload, qs } from '../api.js';
import { h, replace, formatBytes, prefs } from '../ui/dom.js';
import { button, select, input, field, loadingState, emptyState, badge, toast, toastError } from '../ui/components.js';
import { state } from '../state.js';

function loadStore() {
  if (window.CorvusShare) return Promise.resolve(window.CorvusShare);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/sw-share.js';
    s.onload = () => resolve(window.CorvusShare);
    s.onerror = () => reject(new Error('Chargement impossible'));
    document.head.appendChild(s);
  });
}

export default {
  mount(el, { params } = {}) {
    const root = h('div', { class: 'stack' });
    el.appendChild(root);
    const info = (title, text) => replace(root, h('h2', { class: 'section-title' }, 'Partager vers Corvus'), emptyState({ icon: 'upload', title, text }), howto());
    const howto = () => h('details', null, h('summary', null, 'Comment partager un fichier ?'),
      h('p', { class: 'dim' }, 'Android et ordinateur (application installée) : menu « Partager » d\'une photo ou d\'un fichier → Corvus. iPhone : Safari ne permet pas cela aux applications web ; utilisez un Raccourci Apple qui appelle l\'API avec un jeton personnel (voir le wiki, page « Raccourci iPhone »).'));

    if (params?.get('login')) return info('Connexion requise', 'Connectez-vous à Corvus, puis partagez de nouveau le fichier : rien n\'a été gardé.');
    if (params?.get('unavailable')) return info('Mise à jour nécessaire', 'Fermez puis rouvrez l\'application Corvus pour installer la dernière version, puis partagez de nouveau.');
    if (params?.get('error')) return info('Partage impossible', params.get('error'));

    replace(root, loadingState());
    (async () => {
      const lib = await loadStore();
      const store = lib.create({ caches });
      const owner = state.me?.id;
      const items = owner ? await store.list(owner) : [];
      if (!items.length) return info('Rien à envoyer', 'Aucun fichier en attente pour ce compte (les partages expirent au bout de 30 minutes).');
      replace(root, h('h2', { class: 'section-title' }, 'Partager vers Corvus'), ...items.map((it) => card(store, owner, it)));
    })().catch((err) => replace(root, h('p', { class: 'danger-text' }, err.message)));

    function card(store, owner, it) {
      const hosts = state.hosts.filter((x) => state.canOperate(x.id));
      const out = h('div', { class: 'stack' });
      if (!hosts.length) return h('section', { class: 'stack' }, h('p', null, 'Aucun hôte sur lequel vous pouvez écrire.'));
      const hostSel = select(hosts.map((x) => ({ value: x.id, label: x.name })), { value: hosts.find((x) => x.id === state.activeHostId)?.id || hosts[0].id });
      const dir = input({ value: prefs.get('shareDir', '~'), 'aria-label': 'Dossier de destination' });
      const send = button({ label: `Envoyer ${it.files.length > 1 ? `les ${it.files.length} fichiers` : 'le fichier'}`, variant: 'primary', icon: 'upload', onClick: go });
      const drop = button({ label: 'Annuler et oublier', variant: 'ghost', onClick: async () => { await store.remove(it.id, owner); replace(root, emptyState({ icon: 'upload', title: 'Partage annulé', text: 'Les fichiers gardés dans ce navigateur ont été supprimés.' })); } });
      async function go() {
        send.disabled = true;
        prefs.set('shareDir', dir.value.trim() || '~');
        try {
          for (let i = 0; i < it.files.length; i++) {
            const f = await store.blob(it.id, i, owner);
            if (!f) throw new Error('Fichier expiré : partagez-le de nouveau');
            const bar = h('progress', { max: '100', value: '0', 'aria-label': `Envoi de ${f.name}` });
            out.appendChild(h('div', null, h('span', null, f.name), ' ', bar));
            await upload(`/api/hosts/${hostSel.value}/fs/upload?${qs({ dir: dir.value.trim() || '~', name: f.name })}`, f.blob, (p) => { bar.value = Math.round(p * 100); });
          }
          await store.remove(it.id, owner);
          toast('Envoyé', 'ok', 2500);
          replace(out, badge('Envoyé : les fichiers ont été retirés de ce navigateur', 'ok'));
          send.hidden = true; drop.hidden = true;
        } catch (err) { send.disabled = false; toastError(err); }
      }
      return h('section', { class: 'stack' },
        h('ul', { class: 'list' }, it.files.map((f) => h('li', { class: 'list-item' }, h('span', { class: 'grow' }, f.name), h('span', { class: 'dim' }, formatBytes(f.size))))),
        field({ label: 'Hôte de destination', control: hostSel }),
        field({ label: 'Dossier de destination', control: dir, hint: 'Doit exister. Un fichier du même nom n\'est jamais écrasé.' }),
        h('div', { class: 'row' }, send, drop), out);
    }
  },
};
