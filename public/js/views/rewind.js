// Vue Rembobinage : frise des changements d'un hôte (agent requis), curseur de temps, ce qu'un retour
// à l'instant choisi changerait, diff, restauration avec confirmation explicite.
import { get, post } from '../api.js';
import { h, replace, formatDate, formatBytes } from '../ui/dom.js';
import { button, openDialog, confirmDialog, select, input, checkbox, segmented, loadingState, emptyState, errorState, badge, toast, toastError } from '../ui/components.js';
import { state } from '../state.js';

const TYPE_LABEL = {
  'file.baseline': 'état initial', 'file.created': 'créé', 'file.modified': 'modifié', 'file.meta': 'droits', 'file.deleted': 'supprimé',
  'port.open': 'port ouvert', 'port.close': 'port fermé', 'service.changed': 'service', 'service.gone': 'service retiré', 'pkg.change': 'paquet', 'action.done': 'action Corvus',
};
const label = (t) => TYPE_LABEL[t] || t;
const toLocalInput = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };

function describe(e) {
  const b = e.body;
  if (e.type.startsWith('file.')) return b.path;
  if (e.type.startsWith('port.')) return b.item;
  if (e.type.startsWith('service.')) return b.item;
  if (e.type === 'pkg.change') return `${b.action} ${b.name} ${b.from}${b.to ? ` → ${b.to}` : ''}`;
  if (e.type === 'action.done') return `${b.name} ${b.path || ''} ${b.ok ? '✓' : '✗'}`;
  return JSON.stringify(b).slice(0, 120);
}

async function showDiff(hostId, a, b, title) {
  const body = h('div', { class: 'stack' }, loadingState());
  const d = openDialog({ title, wide: true, body, actions: [button({ label: 'Fermer', variant: 'ghost', onClick: () => d.close() })] });
  try {
    const diff = await get(`/api/hosts/${hostId}/rewind/diff?${new URLSearchParams({ ...(a ? { a } : {}), ...(b ? { b } : {}) })}`);
    if (diff.binary) return replace(body, h('p', { class: 'dim' }, 'Contenu binaire : pas de diff.'));
    if (diff.tooBig) return replace(body, h('p', { class: 'dim' }, 'Fichiers trop différents pour un diff lisible.'));
    if (!diff.hunks.length) return replace(body, h('p', { class: 'dim' }, 'Contenu identique.'));
    replace(body,
      h('p', { class: 'dim' }, `+${diff.added} −${diff.removed} lignes`),
      h('pre', { class: 'diff' }, diff.hunks.flatMap((hk, i) => [
        i ? h('div', { class: 'diff-sep' }, '…') : null,
        ...hk.lines.map((l) => h('div', { class: `diff-line diff-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}` }, `${l.t} ${l.s}`)),
      ])));
  } catch (err) { replace(body, errorState(err)); }
}

export default {
  mount(el) {
    const eligible = () => state.hosts.filter((x) => x.agent);
    let hostId = eligible().find((x) => x.id === state.activeHostId)?.id || eligible()[0]?.id;
    let at = Date.now() - 3600_000;
    let tab = 'changes';
    const root = h('div', { class: 'stack' });
    el.appendChild(root);
    if (!hostId) {
      replace(root, emptyState({ icon: 'history', title: 'Aucun hôte avec agent', text: 'Le rembobinage a besoin d\'un agent Corvus sur l\'hôte (menu « Agents »).' }));
      return;
    }

    const hostSel = select(eligible().map((x) => ({ value: x.id, label: x.name })), { value: hostId });
    hostSel.addEventListener('change', () => { hostId = hostSel.value; load(); });
    const timeInput = input({ type: 'datetime-local', value: toLocalInput(at), 'aria-label': 'Instant visé' });
    const slider = h('input', { type: 'range', min: '0', max: '1000', value: '1000', class: 'player-seek', 'aria-label': 'Remonter dans le temps' });
    const frise = h('div', { class: 'frise', 'aria-hidden': 'true' });
    const body = h('div', { class: 'stack' });
    const tabs = segmented([{ value: 'changes', label: 'Retour à cet instant' }, { value: 'history', label: 'Historique' }], tab, (v) => { tab = v; renderBody(); }, { label: 'Vue' });
    let t0 = Date.now() - 7 * 86400_000;
    let events = [];

    replace(root,
      h('div', { class: 'row' }, h('h2', { class: 'section-title grow' }, 'Rembobiner'), hostSel),
      h('p', { class: 'dim' }, 'Remontez le curseur : Corvus compare l\'état actuel des fichiers surveillés à celui de l\'instant choisi. Rien n\'est modifié sans confirmation.'),
      frise, slider, h('div', { class: 'row' }, timeInput, button({ label: 'Maintenant − 1 h', variant: 'ghost', onClick: () => setAt(Date.now() - 3600_000) })),
      tabs, body);

    function setAt(ms) { at = Math.max(t0, Math.min(Date.now(), ms)); timeInput.value = toLocalInput(at); slider.value = String(Math.round(((at - t0) / (Date.now() - t0)) * 1000)); renderBody(); }
    slider.addEventListener('input', () => { at = t0 + (Number(slider.value) / 1000) * (Date.now() - t0); timeInput.value = toLocalInput(at); });
    slider.addEventListener('change', () => renderBody());
    timeInput.addEventListener('change', () => { const t = Date.parse(timeInput.value); if (Number.isFinite(t)) setAt(t); });

    function drawFrise() {
      const bins = new Array(48).fill(0);
      const span = Date.now() - t0;
      for (const e of events) if (e.type !== 'file.baseline') bins[Math.min(47, Math.max(0, Math.floor(((e.ts - t0) / span) * 48)))]++;
      const max = Math.max(1, ...bins);
      replace(frise, ...bins.map((n, i) => h('span', { class: 'frise-bar', style: `height:${Math.max(4, Math.round((n / max) * 100))}%`, title: `${n} événement(s)` })));
    }

    async function load() {
      replace(body, loadingState());
      try {
        const r = await get(`/api/hosts/${hostId}/rewind/events?limit=500`);
        events = r.events;
        drawFrise();
        renderBody();
      } catch (err) { replace(body, errorState(err, load)); }
    }

    async function renderBody() {
      if (tab === 'history') return renderHistory();
      replace(body, loadingState());
      try {
        const { changes } = await get(`/api/hosts/${hostId}/rewind/changes?at=${Math.round(at)}`);
        if (!changes.length) { replace(body, emptyState({ icon: 'history', title: 'Aucune différence', text: `Les fichiers surveillés sont identiques à ceux du ${formatDate(at)}.` })); return; }
        const boxes = changes.map((c) => ({ c, cb: checkbox('', { checked: c.restorable, disabled: !c.restorable }) }));
        const restoreBtn = button({ label: 'Restaurer la sélection', icon: 'history', variant: 'danger', onClick: () => restore(boxes) });
        replace(body,
          h('p', null, `${changes.length} différence(s) avec l'état du ${formatDate(at)} :`),
          h('ul', { class: 'list' }, boxes.map(({ c, cb }) => h('li', { class: 'list-item' },
            cb,
            h('div', { class: 'grow' },
              h('div', { class: 'mono' }, c.path),
              h('div', { class: 'dim' }, c.action === 'remove' ? 'sera supprimé (créé depuis)' : `sera remis tel quel (${c.why})`, c.blockedReason ? ` — non restaurable : ${c.blockedReason}` : '')),
            c.action === 'restore' && c.then?.sha && c.now?.sha !== c.then.sha ? button({ label: 'Diff', variant: 'ghost', onClick: () => showDiff(hostId, c.now?.sha, c.then.sha, `${c.path} : maintenant → ${formatDate(at)}`) }) : null))),
          restoreBtn);
      } catch (err) { replace(body, errorState(err, renderBody)); }
    }

    async function restore(boxes) {
      const chosen = boxes.filter((x) => x.cb.input.checked).map((x) => x.c);
      if (!chosen.length) { toast('Rien de coché', 'warn', 2000); return; }
      const ok = await confirmDialog({
        title: `Restaurer ${chosen.length} fichier(s) ?`,
        message: `Les fichiers seront remis à leur état du ${formatDate(at)} (${chosen.filter((c) => c.action === 'remove').length} suppression(s)). L'état actuel est conservé dans l'historique : vous pourrez revenir en arrière.`,
        confirmLabel: 'Restaurer', danger: true,
      });
      if (!ok) return;
      try {
        const { results } = await post(`/api/hosts/${hostId}/rewind/restore`, { at: Math.round(at), paths: chosen.map((c) => c.path), confirm: true });
        const bad = results.filter((r) => !r.ok);
        toast(bad.length ? `${results.length - bad.length} restauré(s), ${bad.length} en échec : ${bad[0].error}` : `${results.length} fichier(s) restauré(s)`, bad.length ? 'warn' : 'ok', 6000);
        setTimeout(load, 2500); // l'agent relève ses propres modifications au balayage suivant
      } catch (err) { toastError(err); }
    }

    function renderHistory() {
      const typeSel = select([{ value: '', label: 'Tout' }, { value: 'file.', label: 'Fichiers' }, { value: 'port.', label: 'Ports' }, { value: 'service.', label: 'Services' }, { value: 'pkg.', label: 'Paquets' }]);
      const q = input({ placeholder: 'Filtrer (chemin, nom…)' });
      const list = h('div', { class: 'stack' });
      const draw = () => {
        const f = events.filter((e) => (!typeSel.value || e.type.startsWith(typeSel.value)) && (!q.value || describe(e).toLowerCase().includes(q.value.toLowerCase())) && e.type !== 'file.baseline');
        replace(list, f.length ? h('ul', { class: 'list' }, f.map((e) => h('li', { class: 'list-item' },
          h('div', { class: 'grow' }, h('div', { class: 'mono' }, describe(e)), h('div', { class: 'dim' }, formatDate(e.ts), ' ', badge(label(e.type)),
            e.body.size != null && e.type.startsWith('file.') ? ` ${formatBytes(e.body.size)}` : '')),
          e.type === 'file.modified' && e.body.sha ? button({ label: 'Diff', variant: 'ghost', onClick: () => showDiff(hostId, e.body.prevSha, e.body.sha, e.body.path) }) : null,
          e.type.startsWith('file.') ? button({ label: 'Aller là', variant: 'ghost', onClick: () => { tab = 'changes'; setAt(e.ts - 1); } }) : null)))
          : emptyState({ icon: 'search', title: 'Aucun événement', text: 'Rien ne correspond (ou l\'agent n\'a encore rien observé).' }));
      };
      typeSel.addEventListener('change', draw); q.addEventListener('input', draw);
      replace(body, h('div', { class: 'row' }, typeSel, q), list);
      draw();
    }

    load();
  },
};
