// Vue « Comparer » : un fichier de configuration lu sur 2 à 5 hôtes (SFTP), différences côte à côte.
// Les valeurs sensibles sont masquées par le serveur ; « Révéler » les demande explicitement (journalisé).
import { post } from '../api.js';
import { h, replace } from '../ui/dom.js';
import { button, busy, input, checkbox, loadingState, emptyState, errorState, badge, toastError, confirmDialog } from '../ui/components.js';
import { state, sshHosts } from '../state.js';

const KIND_LABEL = { '~': 'modifiée', '-': 'absente à droite', '+': 'absente à gauche' };

export default {
  mount(el) {
    const hosts = sshHosts();
    const chosen = new Set(state.activeHostId ? [state.activeHostId] : []);
    const out = h('div', { class: 'stack' });
    const pathInput = input({ value: '/etc/ssh/sshd_config', 'aria-label': 'Fichier à comparer', placeholder: '/etc/ssh/sshd_config' });
    const counter = h('span', { class: 'dim' });
    const list = h('div', { class: 'cmp-hosts', role: 'group', 'aria-label': 'Hôtes à comparer' });
    let revealed = false;

    if (hosts.length < 2) {
      el.appendChild(emptyState({ icon: 'server', title: 'Il faut au moins deux hôtes', text: 'Ajoutez un second hôte pour comparer leurs fichiers de configuration.' }));
      return;
    }

    for (const host of hosts) {
      const box = checkbox(host.name, { checked: chosen.has(host.id) });
      box.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) { if (chosen.size >= 5) { e.target.checked = false; return; } chosen.add(host.id); } else chosen.delete(host.id);
        counter.textContent = `${chosen.size} hôte(s) choisi(s) — de 2 à 5`;
      });
      list.appendChild(box);
    }
    counter.textContent = `${chosen.size} hôte(s) choisi(s) — de 2 à 5`;

    const run = button({ label: 'Comparer', icon: 'search', onClick: () => compare(false) });
    el.append(h('div', { class: 'stack' },
      h('h2', { class: 'section-title' }, 'Comparer une configuration'),
      h('p', { class: 'dim' }, 'Le fichier est lu sur chaque hôte choisi, puis comparé au premier. Les mots de passe, jetons et clés sont masqués.'),
      pathInput, list, counter, h('div', { class: 'row' }, run), out));

    async function compare(reveal) {
      if (chosen.size < 2) { toastError(new Error('Choisissez au moins deux hôtes')); return; }
      replace(out, loadingState('Lecture des hôtes…'));
      try {
        const hostIds = [...chosen];
        const r = await post('/api/compare', { path: pathInput.value.trim(), hostIds, reveal });
        revealed = reveal;
        replace(out, ...render(r));
      } catch (err) { replace(out, errorState(err, () => compare(reveal))); }
    }

    function render(r) {
      const byId = new Map(r.hosts.map((x) => [x.hostId, x]));
      const head = r.hosts.map((x) => h('li', null,
        h('strong', null, x.name), ' ',
        x.ok ? badge(`${x.lines} lignes${x.crlf ? ' · CRLF' : ''}`, 'ok') : badge(x.error?.message || 'illisible', 'danger')));
      const blocks = r.diffs.map((d) => {
        const target = byId.get(d.hostId);
        const ref = byId.get(r.reference);
        const title = h('h3', { class: 'section-title' }, `${ref.name} ↔ ${target.name}`);
        if (d.skipped) return h('section', { class: 'stack' }, title, h('p', { class: 'dim' }, d.error?.message || 'Comparaison impossible (lecture en échec).'));
        if (d.identical) return h('section', { class: 'stack' }, title, h('p', { class: 'dim' }, '✓ Fichiers identiques.'));
        return h('section', { class: 'stack' }, title, h('p', { class: 'dim' }, `${d.changed} ligne(s) différente(s)${d.truncated ? ' (affichage tronqué)' : ''}`), table(d.rows, ref.name, target.name));
      });
      const reveal = revealed ? h('p', { class: 'dim' }, 'Valeurs sensibles affichées (action journalisée).')
        : button({ label: 'Révéler les valeurs masquées', variant: 'ghost', icon: 'eye', onClick: async () => {
          if (await confirmDialog({ title: 'Révéler les valeurs masquées ?', message: 'Mots de passe, jetons et clés apparaîtront à l\'écran. L\'action est écrite dans le journal.', confirmLabel: 'Révéler', danger: true })) compare(true);
        } });
      return [h('ul', { class: 'list cmp-summary' }, head), ...blocks, reveal];
    }

    function table(rows, left, right) {
      return h('div', { class: 'cmp-scroll' }, h('table', { class: 'cmp-table' },
        h('thead', null, h('tr', null, h('th', null, left), h('th', null, right))),
        h('tbody', null, rows.map((row) => {
          if (row.k === '…') return h('tr', { class: 'cmp-fold' }, h('td', { colspan: '2' }, `… ${row.n} ligne(s) identique(s) repliée(s)`));
          const cls = row.k === '=' ? '' : row.k === '~' ? 'cmp-chg' : row.k === '-' ? 'cmp-del' : 'cmp-add';
          return h('tr', { class: cls, title: KIND_LABEL[row.k] || '' }, h('td', null, row.a ?? ''), h('td', null, row.b ?? ''));
        }))));
    }
  },
};
