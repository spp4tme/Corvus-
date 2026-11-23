// Vue « Plus » (mobile) : accès aux sections secondaires.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

const ITEMS = [
  { href: '#/journal', icon: 'journal', title: 'Journal', text: 'Historique des connexions' },
  { href: '#/proxy', icon: 'link', title: 'Services web', text: 'Ouvrir un service privé du tailnet' },
  { href: '#/settings', icon: 'settings', title: 'Réglages', text: 'Terminal, notifications, session' },
];

export default {
  mount(el) {
    el.appendChild(h('nav', { 'aria-label': 'Sections secondaires' }, h('ul', { class: 'list' }, ITEMS.map((it) => h('li', null,
      h('a', { class: 'list-item clickable list-button', href: it.href },
        h('span', { class: 'host-icon' }, icon(it.icon)),
        h('span', { class: 'grow' }, h('div', { class: 'host-name' }, it.title), h('div', { class: 'dim' }, it.text)),
        icon('chevronRight', { size: 20 })))))));
  },
};
