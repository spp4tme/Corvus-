// Sélecteur d'hôte partagé par les vues Fichiers, Git, Supervision.
import { h } from './dom.js';
import { state, sortedHosts } from '../state.js';

/**
 * @param {(hostId: string) => void} onChange
 * @returns {HTMLElement & {destroy: Function}}
 */
export function hostPicker(onChange, { label = 'Hôte' } = {}) {
  const sel = h('select', { class: 'select', 'aria-label': label });
  const render = () => {
    const current = state.activeHostId;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    sel.appendChild(h('option', { value: '', disabled: true, selected: !current }, 'Choisir un hôte…'));
    for (const host of sortedHosts()) {
      sel.appendChild(h('option', { value: host.id, selected: host.id === current }, `${host.pinned ? '★ ' : ''}${host.name}`));
    }
  };
  render();
  sel.addEventListener('change', () => {
    state.setActiveHost(sel.value);
    onChange(sel.value);
  });
  const unsub = state.subscribe(render);
  const wrap = h('div', { class: 'host-picker' }, sel);
  wrap.destroy = unsub;
  return wrap;
}
