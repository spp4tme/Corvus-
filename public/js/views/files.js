// Vue Fichiers — livrée à l'étape 2.
import { emptyState } from '../ui/components.js';

export default {
  mount(el) {
    el.appendChild(emptyState({ icon: 'folder', title: 'Fichiers', text: 'Bientôt disponible.' }));
  },
};