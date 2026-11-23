// État partagé de l'application : liste des hôtes + hôte actif (mémorisé localement).
import { get } from './api.js';
import { prefs } from './ui/dom.js';

const listeners = new Set();

export const state = {
  hosts: [],
  loaded: false,
  activeHostId: prefs.get('activeHost', null),

  async refreshHosts() {
    const { hosts } = await get('/api/hosts');
    this.hosts = hosts;
    this.loaded = true;
    if (this.activeHostId && !hosts.some((h) => h.id === this.activeHostId)) this.activeHostId = null;
    emit();
    return hosts;
  },

  host(id) {
    return this.hosts.find((h) => h.id === id) || null;
  },

  setActiveHost(id) {
    this.activeHostId = id;
    prefs.set('activeHost', id);
    emit();
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error(err); }
  }
}

/** Tri : épinglés d'abord, puis alphabétique. */
export function sortedHosts(hosts = state.hosts) {
  return [...hosts].sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name, 'fr'));
}
