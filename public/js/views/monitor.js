// Vue Supervision — livrée à l'étape 4.
import { emptyState } from '../ui/components.js';

export default {
  mount(el) {
    el.appendChild(emptyState({ icon: 'activity', title: 'Supervision', text: 'Bientôt disponible.' }));
  },
};