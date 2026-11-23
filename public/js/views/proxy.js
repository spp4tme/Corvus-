// Vue Services web — livrée à l'étape 5.
import { emptyState } from '../ui/components.js';

export default {
  mount(el) {
    el.appendChild(emptyState({ icon: 'link', title: 'Services web', text: 'Bientôt disponible.' }));
  },
};