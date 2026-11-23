// Claude Code sur un hôte : bouton (fiche hôte + barre du terminal), liste des sessions tmux
// actives (Reprendre / Tuer / Nouvelle session) et messages clairs si tmux ou claude manquent.
// Ce module ne lance rien lui-même : il appelle `launch({ session?, dir? })` fourni par la vue
// appelante (navigation vers le terminal, ou ouverture d'un onglet déjà dans le terminal).
import { get, del, qs } from '../api.js';
import { h, replace } from '../ui/dom.js';
import { button, busy, field, input, openDialog, confirmDialog, toast, toastError, badge, loadingState } from '../ui/components.js';

export const DANGEROUS_FLAG = '--dangerously-skip-permissions';
export const isDangerous = (cmd) => String(cmd || '').split(/\s+/).includes(DANGEROUS_FLAG);

const ago = (ms) => {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'à l\'instant';
  if (s < 5400) return `il y a ${Math.round(s / 60)} min`;
  if (s < 129_600) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86_400)} j`;
};

/** Avertissement affiché dans le formulaire d'hôte et avant le lancement. */
export function dangerNote() {
  return h('div', { class: 'danger-note', role: 'alert' },
    h('strong', null, 'Attention : Claude agira sans demander de confirmation. '),
    `Avec ${DANGEROUS_FLAG}, Claude Code peut lire, modifier et supprimer des fichiers et lancer des commandes sur cette machine sans vous demander. À réserver à une machine ou un dossier jetable.`);
}

/** Bouton « Claude Code » : `getHost()` donne l'hôte visé au moment du tap. */
export function claudeButton(getHost, launch, { iconOnly = false } = {}) {
  const btn = button({
    label: 'Claude Code', icon: 'sparkle', iconOnly,
    onClick: () => {
      const host = getHost();
      if (host) openClaude(host, launch, btn);
      else toast('Ajoutez d\'abord un hôte.', 'warn');
    },
  });
  return btn;
}

function codeLine(text) {
  const copy = button({
    label: 'Copier', icon: 'copy', iconOnly: true, variant: 'ghost',
    onClick: async () => {
      try { await navigator.clipboard.writeText(text); toast('Commande copiée', 'ok', 1500); } catch { toast('Copie refusée : sélectionnez la commande', 'warn'); }
    },
  });
  return h('div', { class: 'row' }, h('code', { class: 'mono grow', style: 'user-select: all; overflow-wrap: anywhere' }, text), copy);
}

function missingDialog(host, kind, st, retry) {
  const isTmux = kind === 'tmux';
  const body = h('div', { class: 'stack' },
    h('p', null, isTmux
      ? `tmux n'est pas installé sur ${host.name}. Claude Code y est lancé dans tmux pour continuer à tourner si vous perdez le réseau ou fermez l'application.`
      : `Claude Code n'est pas installé sur ${host.name} (ou n'est pas dans le PATH de l'utilisateur ${host.username}).`),
    h('p', { class: 'dim' }, 'Installation, à lancer sur cet hôte (par exemple depuis un terminal Corvus) :'),
    isTmux ? codeLine(st.tmuxInstall) : [codeLine(st.install.native), h('p', { class: 'dim' }, 'ou, avec Node.js :'), codeLine(st.install.npm)],
    isTmux ? null : h('p', { class: 'dim' }, 'Puis lancez « claude » une fois pour vous connecter à votre compte.'));
  const d = openDialog({
    title: isTmux ? 'tmux manquant' : 'Claude Code non installé', body,
    actions: [
      button({ label: 'Fermer', variant: 'ghost', onClick: () => d.close() }),
      button({ label: 'Revérifier', icon: 'refresh', variant: 'primary', onClick: () => { d.close(); retry(); } }),
    ],
  });
}

async function beginNew(host, st, launch, dir) {
  if (st.settings.dangerous) {
    const ok = await confirmDialog({
      title: 'Lancer sans confirmation ?',
      message: `La commande de ${host.name} contient ${DANGEROUS_FLAG} : Claude Code pourra modifier des fichiers et lancer des commandes sans rien demander. Continuer ?`,
      confirmLabel: 'Lancer quand même', danger: true,
    });
    if (!ok) return false;
  }
  launch(dir === undefined ? {} : { dir });
  return true;
}

/**
 * Un tap : diagnostic de l'hôte puis, s'il n'y a aucune session, ouverture directe d'un nouvel
 * onglet ; sinon liste des sessions (Reprendre / Tuer / Nouvelle session).
 */
export async function openClaude(host, launch, btn) {
  let st;
  try {
    const load = () => get(`/api/hosts/${host.id}/claude`);
    st = await (btn ? busy(btn, load) : load());
  } catch (err) { toastError(err); return; }
  const retry = () => openClaude(host, launch, btn);
  if (!st.tmux) return missingDialog(host, 'tmux', st, retry);
  if (!st.sessions.length) {
    if (!st.claude.installed) return missingDialog(host, 'claude', st, retry);
    if (st.settings.dir && st.dirOk === false) {
      toast(`Le dossier de projet « ${st.settings.dir} » n'existe pas sur ${host.name}. Corrigez-le dans la fiche de l'hôte.`, 'error', 7000);
      return;
    }
    await beginNew(host, st, launch);
    return;
  }
  sessionsDialog(host, st, launch);
}

function sessionsDialog(host, st, launch) {
  const list = h('div', { class: 'list' });
  const dirField = field({
    label: 'Dossier de la nouvelle session',
    control: input({ value: st.settings.dir, placeholder: '~ (dossier personnel)' }),
    hint: 'Laissez vide pour le dossier personnel de l\'utilisateur.',
  });
  const newBtn = button({ label: 'Nouvelle session', icon: 'plus', variant: 'primary', onClick: () => startNew() });
  const info = h('div', { class: 'stack' });

  const d = openDialog({
    title: `Claude Code — ${host.name}`,
    body: h('div', { class: 'stack' }, info, list, dirField),
    actions: [button({ label: 'Fermer', variant: 'ghost', onClick: () => d.close() }), newBtn],
  });

  function renderInfo() {
    replace(info,
      h('p', { class: 'dim' }, st.claude.installed
        ? `Claude Code ${st.claude.version || ''} · commande : `
        : 'Claude Code n\'est pas installé sur cet hôte · commande : ', h('code', { class: 'mono' }, st.settings.cmd)),
      st.settings.dangerous ? dangerNote() : null);
  }

  function renderList() {
    replace(list, st.sessions.length ? st.sessions.map((s) => h('div', { class: 'card stack', style: 'padding: var(--s-3)' },
      h('div', null,
        h('div', { class: 'host-name mono', style: 'overflow-wrap: anywhere' }, s.name),
        h('div', { class: 'host-addr', style: 'overflow-wrap: anywhere' }, `${s.cwd || '~'} · ${ago(s.activityAt)}`),
        h('div', { class: 'row' }, s.attached ? badge(`${s.attached} client${s.attached > 1 ? 's' : ''}`, 'ok') : badge('détachée'))),
      h('div', { class: 'row' },
        button({ label: 'Reprendre', icon: 'play', variant: 'primary', attrs: { style: 'flex: 1 1 auto' }, onClick: () => { d.close(); launch({ session: s.name }); } }),
        button({ label: `Tuer ${s.name}`, icon: 'trash', iconOnly: true, variant: 'danger', onClick: () => kill(s) }))))
      : h('p', { class: 'dim' }, 'Aucune session Claude active sur cet hôte.'));
  }

  async function kill(s) {
    const ok = await confirmDialog({
      title: 'Tuer la session ?',
      message: `« ${s.name} » sera arrêtée : le travail en cours de Claude Code sera interrompu et la conversation de cette session fermée.`,
      confirmLabel: 'Tuer', danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/hosts/${host.id}/claude/sessions/${s.name}`);
      await refresh();
      toast('Session arrêtée', 'ok', 1500);
    } catch (err) { toastError(err); await refresh().catch(() => {}); }
  }

  async function refresh() {
    replace(list, loadingState('Actualisation…'));
    const dir = dirField.querySelector('input').value.trim();
    st = await get(`/api/hosts/${host.id}/claude?${qs({ dir })}`);
    renderInfo();
    renderList();
  }

  async function startNew() {
    const dir = dirField.querySelector('input').value.trim();
    try { st = await busy(newBtn, () => get(`/api/hosts/${host.id}/claude?${qs({ dir })}`)); } catch (err) { toastError(err); return; }
    if (!st.claude.installed) { d.close(); return missingDialog(host, 'claude', st, () => openClaude(host, launch)); }
    if (dir && st.dirOk === false) { dirField.setError?.(`Dossier introuvable sur ${host.name}`); return; }
    dirField.setError?.(null);
    if (await beginNew(host, st, launch, dir)) d.close();
  }

  renderInfo();
  renderList();
}
