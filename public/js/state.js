// État partagé de l'application : liste des hôtes + hôte actif (mémorisé localement).
import { get } from './api.js';
import { prefs } from './ui/dom.js';

const listeners = new Set();

export const state = {
  hosts: [],
  loaded: false,
  activeHostId: prefs.get('activeHost', null),
  me: null,

  setMe(user) {
    this.me = user;
    document.documentElement.dataset.role = user?.role || '';
    emit();
  },

  get isAdmin() {
    return this.me?.role === 'admin';
  },

  /** Rôle sur un hôte (fourni par le serveur avec la liste des hôtes). */
  canOperate(hostId) {
    const r = this.host(hostId)?.role;
    return r === 'admin' || r === 'operator';
  },

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

/** Hôtes joignables en SSH : exclut les hôtes « agent seul » (authType « none »), qui n'ont ni terminal, ni fichiers, ni Git. */
export function sshHosts(hosts = state.hosts) {
  return hosts.filter((x) => x.authType !== 'none');
}

/** Tri : épinglés d'abord, puis alphabétique. */
export function sortedHosts(hosts = state.hosts) {
  return [...hosts].sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name, 'fr'));
}
