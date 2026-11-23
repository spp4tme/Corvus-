// Vue Git — livrée à l'étape 3.
import { emptyState } from '../ui/components.js';

export default {
  mount(el) {
    el.appendChild(emptyState({ icon: 'git', title: 'Git', text: 'Bientôt disponible.' }));
  },
};