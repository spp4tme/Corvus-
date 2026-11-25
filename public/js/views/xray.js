// Vue Radiographie : arbre des processus (qui a lancé quoi, via quelle session SSH), connexions réseau,
// gel / dégel / arrêt d'un processus. Agent requis ; lecture seule tant qu'on ne confirme pas une action.
import { get, post } from '../api.js';
import { h, replace } from '../ui/dom.js';
import { button, confirmDialog, select, input, segmented, loadingState, emptyState, errorState, badge, toast, toastError } from '../ui/components.js';
import { state } from '../state.js';

function tree(processes) {
  const byParent = new Map();
  const known = new Set(processes.map((p) => p.pid));
  for (const p of processes) {
    const parent = known.has(p.ppid) && p.ppid !== p.pid ? p.ppid : 0;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(p);
  }
  return byParent;
}

export default {
  mount(el) {
    const eligible = () => state.hosts.filter((x) => x.agent);
    let hostId = eligible().find((x) => x.id === state.activeHostId)?.id || eligible()[0]?.id;
    let tab = 'procs';
    let data = null;
    const root = h('div', { class: 'stack' });
    el.appendChild(root);
    if (!hostId) { replace(root, emptyState({ icon: 'activity', title: 'Aucun hôte avec agent', text: 'La radiographie a besoin d\'un agent Corvus sur l\'hôte (menu « Agents »).' })); return; }

    const hostSel = select(eligible().map((x) => ({ value: x.id, label: x.name })), { value: hostId });
    hostSel.addEventListener('change', () => { hostId = hostSel.value; load(); });
    const q = input({ placeholder: 'Filtrer (programme, commande, utilisateur SSH)…' });
    q.addEventListener('input', draw);
    const tabs = segmented([{ value: 'procs', label: 'Processus' }, { value: 'conns', label: 'Connexions' }], tab, (v) => { tab = v; draw(); }, { label: 'Vue' });
    const body = h('div', { class: 'stack' });
    replace(root, h('div', { class: 'row' }, h('h2', { class: 'section-title grow' }, 'Radiographie'), hostSel, button({ label: 'Actualiser', icon: 'refresh', variant: 'ghost', onClick: load })),
      h('p', { class: 'dim' }, 'Instantané en direct (lu dans /proc par l\'agent). Un processus qui naît et meurt en moins de 2 s n\'apparaît pas dans l\'historique.'), tabs, q, body);

    async function act(p, action) {
      const verb = { freeze: 'Geler', thaw: 'Dégeler', kill: 'Tuer' }[action];
      const ok = await confirmDialog({ title: `${verb} ce processus ?`, message: `${p.exe} (pid ${p.pid})${p.cmd ? `\n${p.cmd}` : ''}`, confirmLabel: verb, danger: action !== 'thaw' });
      if (!ok) return;
      try { await post(`/api/hosts/${hostId}/xray/proc`, { pid: p.pid, start: p.start, action, confirm: true }); toast(`${verb} : fait`, 'ok', 2500); load(); } catch (err) { toastError(err); }
    }

    function draw() {
      if (!data) return;
      const f = q.value.toLowerCase();
      const match = (p) => !f || `${p.exe} ${p.cmd} ${p.ssh || ''} ${p.comm}`.toLowerCase().includes(f);
      if (tab === 'conns') {
        const list = data.connections.filter((c) => !f || `${c.exe || ''} ${c.remote}`.toLowerCase().includes(f));
        replace(body, list.length ? h('ul', { class: 'list' }, list.map((c) => h('li', { class: 'list-item' },
          h('div', { class: 'grow' }, h('div', { class: 'mono' }, `${c.local} → ${c.remote}`), h('div', { class: 'dim' }, c.exe || 'processus inconnu', c.pid ? ` (pid ${c.pid})` : ''))))) : emptyState({ icon: 'link', title: 'Aucune connexion sortante', text: 'Les connexions locales (127.0.0.1) sont ignorées.' }));
        return;
      }
      const byParent = tree(data.processes);
      const rows = [];
      const walk = (parent, depth) => {
        for (const p of byParent.get(parent) || []) {
          if (depth < 12) rows.push({ p, depth });
          walk(p.pid, depth + 1);
        }
      };
      walk(0, 0);
      const shown = f ? rows.filter((r) => match(r.p)) : rows;
      replace(body, h('ul', { class: 'list' }, shown.map(({ p, depth }) => h('li', { class: 'list-item', style: f ? '' : `padding-left:${8 + depth * 14}px` },
        h('div', { class: 'grow' },
          h('div', { class: 'mono' }, p.exe, ' ', h('span', { class: 'dim' }, `pid ${p.pid}`), ' ', p.ssh ? badge(`via SSH · ${p.ssh}`, 'accent') : null, p.uid === 0 ? badge('root', 'warn') : null),
          p.cmd && p.cmd !== p.exe ? h('div', { class: 'dim ellipsis' }, p.cmd) : null),
        state.canOperate(hostId) ? h('div', { class: 'row' },
          button({ label: 'Geler', variant: 'ghost', onClick: () => act(p, 'freeze') }),
          button({ label: 'Dégeler', variant: 'ghost', onClick: () => act(p, 'thaw') }),
          button({ label: 'Tuer', variant: 'ghost', onClick: () => act(p, 'kill') })) : null))));
    }

    async function load() {
      replace(body, loadingState());
      try { data = await get(`/api/hosts/${hostId}/xray/live`); draw(); } catch (err) { replace(body, errorState(err, load)); }
    }
    load();
  },
};
