// Barre de commande sous le terminal : suggestions sans IA (historique fréquence × récence,
// chemins par SFTP, commande suivante par n-grammes), analyse des commandes risquées avant envoi,
// mode « annulable » (sauvegarde des fichiers touchés) et bouton « Annuler la dernière commande ».
import { get, post } from './api.js';
import { h, replace, debounce } from './ui/dom.js';
import { button, toast, toastError, confirmDialog } from './ui/components.js';
import { riskDialog, snippetDialog, previewDialog } from './views/commands.js';
import { state } from './state.js';

const isRelative = (p) => !p.startsWith('/') && !p.startsWith('~');

/** @param {{ active: () => any }} opts  `active()` renvoie l'onglet de terminal courant */
export function createCommandBar({ active }) {
  const inp = h('input', {
    class: 'input mono cmdbar-input', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    placeholder: 'Commande (analysée avant envoi)…', 'aria-label': 'Barre de commande', enterkeyhint: 'send',
  });
  const chips = h('div', { class: 'cmdbar-chips', role: 'listbox', 'aria-label': 'Suggestions' });
  const undoSlot = h('div', { class: 'cmdbar-undo' });
  let suggestions = [];
  const recent = new Map(); // onglet → dernières commandes (contexte des n-grammes)

  const tabCtx = () => {
    const t = active();
    if (!t) return null;
    if (!recent.has(t)) recent.set(t, []);
    return t;
  };

  const showChips = (items) => {
    suggestions = items;
    replace(chips, items.slice(0, 8).map((s, i) => h('button', {
      type: 'button', class: 'chip mono', role: 'option', title: s.title || s.text,
      onpointerdown: (e) => e.preventDefault(),
      onclick: () => { inp.value = s.text; inp.focus(); refresh(); },
    }, i === 0 ? h('span', { class: 'faint' }, 'Tab ') : null, s.label || s.text)));
  };

  const refresh = debounce(async () => {
    const t = tabCtx();
    if (!t?.hostId) return showChips([]);
    const prev = recent.get(t);
    try {
      const r = await get(`/api/hosts/${t.hostId}/complete?${new URLSearchParams({ prefix: inp.value, prev1: prev.at(-1) || '', prev2: prev.at(-2) || '', ...(t.cwd ? { cwd: t.cwd } : {}) })}`);
      const head = inp.value.includes(' ') ? inp.value.slice(0, inp.value.lastIndexOf(' ') + 1) : '';
      showChips([
        ...r.paths.map((p) => ({ text: head + p, label: p })),
        ...r.history.map((x) => ({ text: x.command })),
        ...r.next.map((x) => ({ text: x.command, label: `${x.command}`, title: `suivie ${Math.round(x.probability * 100)} % du temps` })),
      ]);
    } catch { showChips([]); }
  }, 150);

  const send = (t, cmd) => {
    t.sendInput(`${cmd}\r`);
    recent.get(t).push(cmd);
    if (recent.get(t).length > 5) recent.get(t).shift();
    post(`/api/hosts/${t.hostId}/history`, { command: cmd, cwd: t.cwd || undefined, source: 'bar' }).catch(() => {});
    inp.value = '';
    refresh();
  };

  const showUndo = (t, op) => {
    replace(undoSlot, button({
      label: `Annuler : ${op.command.slice(0, 40)}`, icon: 'history', variant: 'ghost',
      onClick: async () => {
        const ok = await confirmDialog({ title: 'Annuler la dernière commande ?', message: `Les ${op.files} élément(s) sauvegardés avant « ${op.command} » vont être remis en place, et les fichiers qu'elle a créés retirés. Les effets hors fichiers (réseau, services…) ne sont pas annulés.`, confirmLabel: 'Restaurer', danger: true });
        if (!ok) return;
        try {
          const r = await post(`/api/hosts/${t.hostId}/undo/${op.id}`, { confirm: true });
          toast(r.errors.length ? `Restauré partiellement : ${r.errors[0]}` : `Restauré (${r.restored} élément(s))`, r.errors.length ? 'warn' : 'ok', 6000);
          replace(undoSlot);
        } catch (err) { toastError(err); }
      },
    }));
  };

  async function submit() {
    const t = tabCtx();
    const cmd = inp.value.trim();
    if (!t || !cmd) return;
    if (t.guest === 'view') return toast('Spectateur : vous ne pouvez pas taper dans ce terminal', 'warn');
    let analysis;
    try { ({ analysis } = await post('/api/commands/analyze', { command: cmd })); } catch (err) { return toastError(err); }
    if (analysis.level === 'safe') return send(t, cmd);
    // Chemins relatifs sans dossier courant connu : l'annulation viserait peut-être d'autres fichiers.
    const cwdUnknown = !t.cwd && analysis.files.some(isRelative);
    const canUndo = analysis.undoable && !cwdUnknown;
    const agent = state.host(t.hostId)?.agent;
    const canPreview = !!(analysis.preview && agent?.online && agent.capabilities?.preview);
    const choice = await riskDialog(cwdUnknown && analysis.undoable
      ? { ...analysis, undoable: false, notUndoable: [...analysis.notUndoable, 'dossier courant inconnu (chemins relatifs) : voir « OSC 7 » dans le wiki (page Barre de commande)'] }
      : analysis, {
      previewHint: canPreview ? 'Vous pouvez d\'abord prévisualiser la commande dans un bac à sable (rien n\'est modifié).' : undefined,
      actions: [
        ...(canPreview ? [{ label: 'Prévisualiser', icon: 'search', value: 'preview' }] : []),
        ...(canUndo ? [{ label: 'Exécuter avec annulation', variant: 'primary', value: 'undo' }] : []),
        { label: canUndo ? 'Exécuter sans filet' : 'Exécuter quand même', variant: 'danger', value: 'run' },
      ],
    });
    if (!choice) return;
    if (choice === 'preview') { previewDialog(t.hostId, cmd, { onRun: () => send(t, cmd) }); return; }
    if (choice === 'undo') {
      try {
        const r = await post(`/api/hosts/${t.hostId}/undo/prepare`, { command: cmd, cwd: t.cwd || undefined });
        if (!r.op) return toast('Annulation impossible pour cette commande : rien n\'a été envoyé', 'warn', 6000);
        showUndo(t, r.op);
      } catch (err) {
        toastError(err);
        return;
      }
    }
    send(t, cmd);
  }

  inp.addEventListener('input', refresh);
  inp.addEventListener('focus', refresh);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Tab' && suggestions.length) { e.preventDefault(); inp.value = suggestions[0].text; refresh(); }
    if (e.key === 'Escape') { inp.blur(); active()?.term.focus(); }
  });
  const snippets = button({
    label: 'Snippets', icon: 'terminal', iconOnly: true, variant: 'ghost',
    onClick: async () => {
      const t = tabCtx();
      try {
        const { snippets: list } = await get(`/api/snippets${t?.hostId ? `?hostId=${t.hostId}` : ''}`);
        showChips(list.map((s) => ({ text: s.command, label: `★ ${s.name}`, title: s.command })));
        if (!list.length) snippetDialog(null, () => toast('Snippet enregistré', 'ok'));
      } catch (err) { toastError(err); }
    },
  });
  const el = h('div', { class: 'cmdbar' }, h('div', { class: 'cmdbar-row' }, inp, snippets, button({ label: 'Envoyer', icon: 'play', iconOnly: true, variant: 'primary', onClick: submit })), chips, undoSlot);
  return { el, focus: () => inp.focus() };
}
