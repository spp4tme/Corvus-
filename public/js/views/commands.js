// Vue Commandes : snippets, exécution d'une commande sur plusieurs hôtes (résultats côte à côte),
// séquences répétées détectées dans l'historique (→ bouton en un clic), import d'historique.
import { get, post, put, del } from '../api.js';
import { h, replace, formatDate } from '../ui/dom.js';
import {
  button, busy, field, input, textarea, select, segmented, openDialog, confirmDialog, toast, toastError,
  loadingState, emptyState, errorState, badge, checkbox,
} from '../ui/components.js';
import { state, sortedHosts, sshHosts } from '../state.js';
import { renderDiff } from '../ui/diffview.js';
import { prefs } from '../ui/dom.js';

const LEVEL = { safe: ['sans risque', 'ok'], caution: ['prudence', 'warn'], danger: ['dangereuse', 'danger'] };

/** Dialogue de confirmation d'une commande à risque (règles du serveur, aucune IA). */
export function riskDialog(analysis, { title = 'Commande à risque', actions = [], previewHint = 'Prévisualisation dans un bac à sable : nécessite un agent Corvus avec --allow-preview sur cet hôte.' } = {}) {
  const [label, kind] = LEVEL[analysis.level];
  const d = openDialog({
    title,
    body: h('div', { class: 'stack' },
      h('div', null, badge(label, kind)),
      h('ul', null, analysis.reasons.map((r) => h('li', null, r))),
      analysis.notUndoable.length ? h('p', { class: 'dim' }, `Jamais annulable : ${analysis.notUndoable.join(', ')}.`) : null,
      analysis.undoable ? h('p', { class: 'dim' }, `Annulable : ${analysis.files.length} élément(s) seront copiés avant l'exécution.`) : null,
      analysis.preview ? h('p', { class: 'dim' }, previewHint) : null),
    actions: [button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close(null) }), ...actions.map((a) => button({ ...a, onClick: () => d.close(a.value) }))],
  });
  return d.closed;
}

/** Exécute la commande dans le bac à sable de l'agent et montre ce qu'elle changerait (rien n'est modifié). */
export async function previewDialog(hostId, command, { onRun } = {}) {
  const body = h('div', { class: 'stack' }, loadingState('Exécution dans le bac à sable (sans réseau)…'));
  const close = () => d.close();
  const d = openDialog({ title: 'Prévisualisation', wide: true, body, actions: [button({ label: 'Fermer', variant: 'ghost', onClick: close })] });
  try {
    const r = await post(`/api/hosts/${hostId}/preview`, { command });
    const KIND = { created: ['créé', 'ok'], modified: ['modifié', 'warn'], deleted: ['supprimé', 'danger'] };
    const apply = button({ label: 'Appliquer ces changements', icon: 'check', variant: 'danger', onClick: async () => {
      const ok = await confirmDialog({ title: 'Appliquer ?', message: `Les ${r.entries.length} changement(s) montrés seront écrits sur l'hôte, seulement si les fichiers d'origine n'ont pas changé depuis.`, confirmLabel: 'Appliquer', danger: true });
      if (!ok) return;
      try {
        const res = await post(`/api/hosts/${hostId}/preview/${r.id}/apply`, { confirm: true });
        toast(`${res.applied} changement(s) appliqué(s)${res.skipped.length ? ` (${res.skipped.length} ignoré(s))` : ''}`, 'ok', 5000);
        d.close();
      } catch (err) { toastError(err); }
    } });
    replace(body,
      h('div', { class: 'row' }, badge(`code de sortie ${r.exit}`, r.exit === 0 ? 'ok' : 'warn'), r.timedOut ? badge('délai dépassé', 'danger') : null, h('span', { class: 'dim' }, `${r.durationMs} ms · sans réseau · système réel intact`)),
      r.stdout ? h('pre', { class: 'diff' }, r.stdout) : null,
      r.stderr ? h('pre', { class: 'diff' }, r.stderr) : null,
      r.entries.length ? h('h3', null, `${r.entries.length} changement(s)${r.truncated ? ' (liste tronquée)' : ''}`) : h('p', { class: 'dim' }, 'Cette commande ne modifie aucun fichier.'),
      ...r.entries.map((e) => h('details', null,
        h('summary', null, badge(KIND[e.kind][0], KIND[e.kind][1]), ' ', h('span', { class: 'mono' }, e.path), e.type === 'dir' ? ' (dossier)' : ''),
        e.diff ? renderDiff(e.diff) : h('p', { class: 'dim' }, e.type === 'symlink' ? `lien vers ${e.target}` : 'pas d\'aperçu texte'))),
      h('p', { class: 'dim' }, 'Limites : le réseau, les bases de données, les services et les processus lancés ne sont pas simulés.'));
    const actions = d.foot;
    if (r.entries.length && actions) actions.prepend(apply);
    if (onRun) actions?.prepend(button({ label: 'Exécuter dans le terminal', variant: 'primary', onClick: () => { d.close(); onRun(); } }));
  } catch (err) { replace(body, errorState(err)); }
}

export function snippetDialog(snippet, onSaved) {
  const name = input({ value: snippet?.name || '' });
  const cmd = textarea({ rows: 4, value: snippet?.command || '', class: 'textarea mono' });
  const desc = input({ value: snippet?.description || '' });
  const hostSel = select([{ value: '', label: 'Tous les hôtes' }, ...sortedHosts(sshHosts()).map((x) => ({ value: x.id, label: x.name }))], { value: snippet?.hostId || '' });
  const save = button({ label: 'Enregistrer', icon: 'save', variant: 'primary' });
  const d = openDialog({
    title: snippet?.id ? `Snippet « ${snippet.name} »` : 'Nouveau snippet', wide: true,
    body: h('div', { class: 'form-grid' }, field({ label: 'Nom', control: name }), field({ label: 'Hôte', control: hostSel }),
      field({ label: 'Commande', control: cmd, span2: true }), field({ label: 'Description', control: desc, span2: true })),
    actions: [button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close() }), save],
  });
  save.addEventListener('click', async () => {
    const body = { name: name.value.trim(), command: cmd.value, description: desc.value, hostId: hostSel.value || null };
    try {
      await busy(save, () => (snippet?.id ? put(`/api/snippets/${snippet.id}`, body) : post('/api/snippets', body)));
      d.close();
      toast('Snippet enregistré', 'ok', 1500);
      onSaved?.();
    } catch (err) { toastError(err); }
  });
}

export default {
  mount(el) {
    let tab = prefs.get('cmdTab', 'snippets');
    const content = h('div');
    const tabs = segmented([{ value: 'snippets', label: 'Snippets' }, { value: 'multi', label: 'Multi-hôtes' }, { value: 'routines', label: 'Routines' }],
      tab, (x) => { tab = x; prefs.set('cmdTab', x); render(); }, { label: 'Section' });
    el.append(h('div', { class: 'toolbar' }, tabs), content);
    const render = () => (tab === 'multi' ? renderMulti() : tab === 'routines' ? renderRoutines() : renderSnippets());

    async function renderSnippets() {
      replace(content, loadingState());
      try {
        const { snippets } = await get('/api/snippets');
        const add = button({ label: 'Nouveau snippet', icon: 'plus', variant: 'primary', onClick: () => snippetDialog(null, renderSnippets) });
        replace(content, h('div', { class: 'toolbar' }, add),
          snippets.length ? h('ul', { class: 'list' }, snippets.map((s) => h('li', { class: 'list-item' },
            h('span', { class: 'grow' }, h('strong', null, s.name), s.hostId ? badge(state.host(s.hostId)?.name || 'hôte') : badge('tous'),
              h('div', { class: 'mono dim ellipsis' }, s.command)),
            button({ label: `Modifier ${s.name}`, icon: 'edit', iconOnly: true, variant: 'ghost', onClick: () => snippetDialog(s, renderSnippets) }),
            button({ label: `Supprimer ${s.name}`, icon: 'trash', iconOnly: true, variant: 'ghost', onClick: async () => {
              if (!await confirmDialog({ title: 'Supprimer le snippet ?', message: s.name, confirmLabel: 'Supprimer', danger: true })) return;
              try { await del(`/api/snippets/${s.id}`); renderSnippets(); } catch (err) { toastError(err); }
            } }))))
            : emptyState({ icon: 'terminal', title: 'Aucun snippet', text: 'Enregistrez vos commandes fréquentes : elles s\'insèrent dans le terminal en un geste.' }));
      } catch (err) { replace(content, errorState(err, renderSnippets)); }
    }

    function renderMulti() {
      const hosts = sortedHosts(sshHosts()).filter((x) => x.role !== 'viewer');
      const picks = hosts.map((x) => ({ host: x, box: checkbox(x.name, { checked: false }) }));
      const cmd = textarea({ rows: 3, class: 'textarea mono', placeholder: 'uptime && df -h /', 'aria-label': 'Commande' });
      const timeout = input({ value: '60', inputmode: 'numeric', 'aria-label': 'Délai en secondes' });
      const run = button({ label: 'Exécuter', icon: 'play', variant: 'primary' });
      const results = h('div', { class: 'exec-grid' });
      const go = async (confirm = false) => {
        const hostIds = picks.filter((p) => p.box.input.checked).map((p) => p.host.id);
        if (!hostIds.length) return toast('Cochez au moins un hôte', 'warn');
        if (!cmd.value.trim()) return toast('Commande vide', 'warn');
        try {
          const r = await busy(run, () => post('/api/exec', { hostIds, command: cmd.value, timeoutSec: Number(timeout.value) || 60, confirm }));
          replace(results, r.results.map((x) => h('div', { class: 'card card-pad stack' },
            h('div', { class: 'row' }, h('strong', { class: 'grow ellipsis' }, x.host), badge(x.ok ? `code ${x.code}` : x.error ? 'erreur' : `code ${x.code}`, x.ok ? 'ok' : 'danger'), h('span', { class: 'dim' }, `${(x.durationMs / 1000).toFixed(1)} s`)),
            h('pre', { class: 'diff exec-out' }, x.error || `${x.stdout}${x.stderr ? `\n${x.stderr}` : ''}` || '(aucune sortie)'))));
        } catch (err) {
          if (err.code === 'CONFIRM_REQUIRED') {
            const ok = await riskDialog(err.details.analysis, { title: 'Exécuter sur plusieurs hôtes ?', actions: [{ label: 'Exécuter quand même', variant: 'danger', value: true }] });
            if (ok) go(true);
          } else toastError(err);
        }
      };
      run.addEventListener('click', () => go(false));
      const snipBtn = button({ label: 'Insérer un snippet', icon: 'terminal', onClick: async () => {
        const { snippets } = await get('/api/snippets');
        const d = openDialog({ title: 'Snippets', body: snippets.length ? h('div', { class: 'list' }, snippets.map((s) => h('button', { type: 'button', class: 'list-item clickable list-button', onclick: () => { cmd.value = s.command; d.close(); } },
          h('span', { class: 'grow' }, h('strong', null, s.name), h('div', { class: 'mono dim ellipsis' }, s.command))))) : emptyState({ title: 'Aucun snippet' }) });
      } });
      replace(content,
        hosts.length ? h('div', { class: 'card card-pad stack' },
          h('div', { class: 'row wrap' }, picks.map((p) => p.box), button({ label: 'Tout cocher', variant: 'ghost', onClick: () => picks.forEach((p) => { p.box.input.checked = true; }) })),
          field({ label: 'Commande', control: cmd }),
          h('div', { class: 'row wrap' }, field({ label: 'Délai (s)', control: timeout }), h('span', { class: 'grow' }), snipBtn, run))
          : emptyState({ icon: 'server', title: 'Aucun hôte utilisable', text: 'Il faut le rôle opérateur sur au moins un hôte.' }),
        results);
    }

    async function renderRoutines() {
      const hostId = state.activeHostId;
      if (!state.host(hostId)) return replace(content, emptyState({ icon: 'server', title: 'Choisissez un hôte', text: 'Depuis la vue Hôtes ou un autre onglet.' }));
      replace(content, loadingState());
      try {
        const { sequences } = await get(`/api/hosts/${hostId}/sequences`);
        const importBtn = button({ label: 'Importer l\'historique du shell', icon: 'download', onClick: async () => {
          try { const r = await busy(importBtn, () => post(`/api/hosts/${hostId}/history/import`)); toast(`${r.imported} commande(s) importée(s)`, 'ok'); renderRoutines(); } catch (err) { toastError(err); }
        } });
        replace(content,
          h('p', { class: 'dim' }, `Suites de commandes que vous répétez sur ${state.host(hostId).name} (au moins 3 fois). Historique : barre de commande Corvus, exécutions multi-hôtes et import de ~/.bash_history / ~/.zsh_history.`),
          h('div', { class: 'toolbar' }, importBtn),
          sequences.length ? h('ul', { class: 'list' }, sequences.map((sq) => h('li', { class: 'list-item' },
            h('span', { class: 'grow' }, badge(`${sq.count} fois`, 'accent'), h('pre', { class: 'mono dim', style: 'margin: 4px 0 0; white-space: pre-wrap' }, sq.commands.join('\n'))),
            button({ label: 'En faire un bouton', icon: 'plus', onClick: () => snippetDialog({ name: sq.commands[0].slice(0, 40), command: sq.commands.join(' && '), hostId, description: 'Routine détectée automatiquement' }, () => toast('Ajouté aux snippets', 'ok')) }))))
            : emptyState({ icon: 'history', title: 'Aucune routine détectée pour l\'instant', text: 'Elles apparaissent quand une même suite de commandes revient souvent.' }));
      } catch (err) { replace(content, errorState(err, renderRoutines)); }
    }
    render();
  },
};

export { formatDate };
