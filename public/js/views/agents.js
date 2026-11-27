// Vue Agents : état des agents enrôlés, installation en une commande (jeton à usage unique), révocation.
import { get, post, del } from '../api.js';
import { h, replace, formatDate } from '../ui/dom.js';
import { button, openDialog, confirmDialog, select, loadingState, emptyState, errorState, badge, toast, toastError } from '../ui/components.js';
import { state } from '../state.js';

const when = (ts) => (ts ? formatDate(ts) : 'jamais');

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Commande copiée', 'ok', 1500); } catch { toast('Copie refusée : sélectionnez le texte', 'warn'); }
}

/** Crée un jeton et affiche la commande à coller sur l'hôte (le jeton n'est montré qu'une fois). */
async function installDialog(hosts, onDone) {
  const sel = select(hosts.map((x) => ({ value: x.id, label: `${x.name} (${x.hostname})` })), { value: hosts[0]?.id });
  const full = h('input', { type: 'checkbox', id: 'ag-full' });
  const out = h('div', { class: 'stack' });
  const make = button({
    label: 'Créer le jeton', variant: 'primary',
    onClick: async () => {
      try {
        const t = await post('/api/agents/enrollments', { hostId: sel.value });
        const server = location.origin;
        const cmd = `curl -fsSL ${server}/api/agent/install.sh | sudo sh -s -- --server ${server} --token ${t.token}${full.checked ? ' --full' : ''}`;
        replace(out,
          h('p', { class: 'dim' }, `Valable 15 minutes, à usage unique. Collez cette commande sur l'hôte « ${t.host.name} » (Linux, x86_64 ou aarch64) : elle télécharge l'agent, vérifie son empreinte SHA-256, installe le service et enrôle :`),
          h('pre', { class: 'code' }, cmd),
          h('p', { class: 'dim' }, `Le script est lisible avant exécution : ${server}/api/agent/install.sh`),
          button({ label: 'Copier la commande', icon: 'copy', onClick: () => copy(cmd) }));
        onDone();
      } catch (err) { toastError(err); }
    },
  });
  const d = openDialog({
    title: 'Installer un agent',
    body: h('div', { class: 'stack' }, h('label', null, 'Hôte', sel),
      h('label', { class: 'row', for: 'ag-full' }, full, h('span', null, 'Droits complets (prévisualisation, restauration, gel de processus, isolement réseau)')),
      h('p', { class: 'dim' }, 'Sans cette case, l\'agent n\'a aucun privilège : métriques, surveillance de fichiers, radiographie des processus de root.'),
      out),
    actions: [button({ label: 'Fermer', variant: 'ghost', onClick: () => d.close() }), make],
  });
}

export default {
  mount(el) {
    const box = h('div', { class: 'stack' });
    el.appendChild(h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('h2', { class: 'section-title grow' }, 'Agents'),
        button({ label: 'Installer un agent', icon: 'plus', variant: 'primary', onClick: () => installDialog(state.hosts, load) })),
      h('p', { class: 'dim' }, 'Un agent est un petit programme facultatif qui se connecte à Corvus (aucun port ouvert sur l\'hôte). Sans agent, Corvus travaille par SSH comme avant.'),
      box));

    async function load() {
      replace(box, loadingState());
      try {
        const { agents, serverPublicKey } = await get('/api/agents');
        if (!agents.length) { replace(box, emptyState({ icon: 'server', title: 'Aucun agent', text: 'Enrôlez un premier agent avec « Installer un agent ».' })); return; }
        replace(box, h('ul', { class: 'list' }, agents.map((a) => {
          const host = state.host(a.hostId);
          return h('li', { class: 'list-item' },
            h('div', { class: 'grow' },
              h('div', { class: 'host-name' }, host?.name || 'hôte supprimé', ' ', badge(a.online ? 'en ligne' : 'hors ligne', a.online ? 'ok' : 'warn'), ' ', badge(`v${a.version || '?'}`), ' ',
                badge(a.platformLabel), ' ', a.experimental ? badge('expérimental', 'warn') : null),
              h('div', { class: 'dim' }, `Enrôlé le ${when(a.enrolledAt)} · vu le ${when(a.lastSeenAt)}`),
              h('div', { class: 'dim mono' }, Object.entries(a.capabilities || {}).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join('  ')),
              a.experimental ? h('div', { class: 'dim' }, 'Agent expérimental : aucune machine réelle ne l\'a encore validé.') : null,
              // Pourquoi une fonction manque : l'explication du serveur, jamais un simple « ✗ ».
              ...Object.values(a.support || {}).filter((s) => !s.ok && s.reason).map((s) => h('div', { class: 'dim' }, s.reason))),
            button({
              label: 'Révoquer', variant: 'danger', onClick: async () => {
                if (!(await confirmDialog({ title: 'Révoquer cet agent ?', message: 'Il sera déconnecté et ne pourra plus se reconnecter. Il faudra le réenrôler.', confirmLabel: 'Révoquer', danger: true }))) return;
                try { await del(`/api/agents/${a.id}`); toast('Agent révoqué', 'ok'); load(); } catch (err) { toastError(err); }
              },
            }));
        })), h('p', { class: 'dim mono' }, `Clé publique de ce Corvus : ${serverPublicKey}`));
      } catch (err) { replace(box, errorState(err, load)); }
    }
    load();
  },
};
