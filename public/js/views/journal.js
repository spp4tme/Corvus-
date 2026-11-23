// Vue Journal : historique local des connexions (terminal, SFTP, git…).
import { get, del } from '../api.js';
import { h, replace, formatDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, segmented, loadingState, emptyState, errorState, confirmDialog, toastError, badge } from '../ui/components.js';

const TYPES = [
  { value: '', label: 'Tout' }, { value: 'terminal', label: 'Terminal' }, { value: 'sftp', label: 'Fichiers' },
  { value: 'git', label: 'Git' }, { value: 'docker', label: 'Docker' }, { value: 'auth', label: 'Accès' },
];
const TYPE_ICON = { terminal: 'terminal', sftp: 'folder', git: 'git', docker: 'docker', auth: 'lock', test: 'plug', monitor: 'activity', proxy: 'link' };

export default {
  mount(el) {
    let type = '';
    const list = h('div');
    el.append(
      h('div', { class: 'toolbar' },
        segmented(TYPES, type, (v) => { type = v; load(); }, { label: 'Filtrer par type' }),
        h('span', { class: 'grow' }),
        button({ label: 'Rafraîchir', icon: 'refresh', iconOnly: true, onClick: () => load() }),
        button({ label: 'Vider', icon: 'trash', variant: 'danger', onClick: clearAll })),
      list);

    async function load() {
      replace(list, loadingState());
      try {
        const { entries } = await get(`/api/journal?limit=300${type ? `&type=${type}` : ''}`);
        if (!entries.length) return replace(list, emptyState({ icon: 'journal', title: 'Journal vide', text: 'Les connexions apparaîtront ici.' }));
        replace(list, h('ul', { class: 'list' }, entries.map((e) => h('li', { class: 'list-item' },
          h('span', { class: 'host-icon' }, icon(TYPE_ICON[e.type] || 'journal')),
          h('div', { class: 'grow' },
            h('div', { class: 'row' }, h('strong', null, `${e.type} · ${e.event}`), e.ok ? null : badge('échec', 'danger')),
            h('div', { class: 'dim ellipsis' }, e.host || e.detail || ''),
            e.host && e.detail ? h('div', { class: 'faint ellipsis' }, e.detail) : null),
          h('time', { class: 'faint', datetime: e.ts }, formatDate(e.ts))))));
      } catch (err) {
        replace(list, errorState(err, load));
      }
    }

    async function clearAll() {
      if (!await confirmDialog({ title: 'Vider le journal ?', message: 'Toutes les entrées seront supprimées.', confirmLabel: 'Vider', danger: true })) return;
      try { await del('/api/journal'); load(); } catch (err) { toastError(err); }
    }
    load();
  },
};
