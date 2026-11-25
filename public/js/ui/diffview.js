// Affichage d'un diff par lignes calculé par le serveur ({ hunks, added, removed, binary, tooBig }).
import { h } from './dom.js';

export function renderDiff(diff) {
  if (diff.binary) return h('p', { class: 'dim' }, 'Contenu binaire : pas de diff.');
  if (diff.tooBig) return h('p', { class: 'dim' }, 'Fichiers trop différents pour un diff lisible.');
  if (!diff.hunks?.length) return h('p', { class: 'dim' }, 'Contenu identique.');
  return h('div', null,
    h('p', { class: 'dim' }, `+${diff.added} −${diff.removed} lignes`),
    h('pre', { class: 'diff' }, diff.hunks.flatMap((hk, i) => [
      i ? h('div', { class: 'diff-sep' }, '…') : null,
      ...hk.lines.map((l) => h('div', { class: `diff-line diff-${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}` }, `${l.t} ${l.s}`)),
    ])));
}
