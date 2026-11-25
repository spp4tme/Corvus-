// Vue Journal : historique local des connexions (terminal, SFTP, git…).
import { get, del } from '../api.js';
import { h, replace, formatDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, busy, segmented, loadingState, emptyState, errorState, toastError, badge } from '../ui/components.js';

const TYPES = [
  { value: '', label: 'Tout' }, { value: 'terminal', label: 'Terminal' }, { value: 'sftp', label: 'Fichiers' },
  { value: 'git', label: 'Git' }, { value: 'docker', label: 'Docker' }, { value: 'auth', label: 'Accès' }, { value: 'alert', label: 'Alertes' },
];
const TYPE_ICON = { terminal: 'terminal', sftp: 'folder', git: 'git', docker: 'docker', auth: 'lock', test: 'plug', monitor: 'activity', proxy: 'link' };

export default {
  mount(el) {
    let type = '';
    const list = h('div');
    const verifyOut = h('div');
    const verifyBtn = button({ label: "Vérifier l'intégrité", icon: 'shield', onClick: () => verify() });
    el.append(
      h('div', { class: 'toolbar' },
        segmented(TYPES, type, (v) => { type = v; load(); }, { label: 'Filtrer par type' }),
        h('span', { class: 'grow' }),
        button({ label: 'Rafraîchir', icon: 'refresh', iconOnly: true, onClick: () => load() }),
        verifyBtn),
      verifyOut,
      list);

    async function load() {
      replace(list, loadingState());
      try {
        const { entries } = await get(`/api/journal?limit=300${type ? `&type=${type}` : ''}`);
        if (!entries.length) return replace(list, emptyState({ icon: 'journal', title: 'Journal vide', text: 'Les connexions apparaîtront ici.' }));
        replace(list, h('ul', { class: 'list' }, entries.map((e) => h('li', { class: 'list-item' },
          h('span', { class: 'host-icon' }, icon(TYPE_ICON[e.type] || 'journal')),
          h('div', { class: 'grow' },
            h('div', { class: 'row' }, h('strong', null, `${e.type} · ${e.event}`), e.ok ? null : badge('échec', 'danger'), e.user ? badge(e.user) : null),
            h('div', { class: 'dim ellipsis' }, e.host || e.detail || ''),
            e.host && e.detail ? h('div', { class: 'faint ellipsis' }, e.detail) : null),
          h('time', { class: 'faint', datetime: e.ts }, formatDate(e.ts))))));
      } catch (err) {
        replace(list, errorState(err, load));
      }
    }

    // Le journal n'est jamais vidé : chaque entrée contient l'empreinte de la précédente.
    async function verify() {
      try {
        const r = await busy(verifyBtn, () => get('/api/journal/verify'));
        replace(verifyOut, h('div', { class: `test-result ${r.ok ? 'ok' : 'ko'}`, role: r.ok ? 'status' : 'alert' },
          r.ok ? `Chaîne intacte : ${r.count} entrée(s) vérifiée(s).` : `Chaîne ROMPUE à l'entrée n° ${r.brokenAt} (${r.reason}) : le journal a été modifié en dehors de Corvus.`,
          h('br'), h('span', { class: 'mono', style: 'overflow-wrap: anywhere' }, `Empreinte de tête : ${r.head?.hash || r.head}`),
          h('br'), h('span', { class: 'dim' }, 'Notez cette empreinte : si elle change sans nouvelle entrée, le journal a été réécrit.')));
      } catch (err) { toastError(err); }
    }
    load();
  },
};
