// Page Claude Code : choix de l'hôte, sessions tmux actives (Reprendre / Tuer), nouvelle session
// et messages clairs si tmux ou claude manquent. La session s'ouvre dans la vue Terminal
// (`#/terminal?host=…&claude=1`) ; la commande réelle est construite côté serveur.
import { get, del, qs } from '../api.js';
import { h, replace } from '../ui/dom.js';
import { button, busy, field, input, confirmDialog, toast, toastError, loadingState, emptyState, errorState, badge } from '../ui/components.js';
import { hostPicker } from '../ui/hostpicker.js';
import { state } from '../state.js';

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

/** Avertissement affiché dans le formulaire d'hôte et sur la page Claude. */
export function dangerNote() {
  return h('div', { class: 'danger-note', role: 'alert' },
    h('strong', null, 'Attention : Claude agira sans demander de confirmation. '),
    `Avec ${DANGEROUS_FLAG}, Claude Code peut lire, modifier et supprimer des fichiers et lancer des commandes sur cette machine sans vous demander. À réserver à une machine ou un dossier jetable.`);
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

/** Navigue vers la vue Terminal, qui ouvre l'onglet (nouvelle session ou reprise). */
export function launchClaude(host, { session, dir } = {}) {
  state.setActiveHost(host.id);
  const q = new URLSearchParams({ host: host.id, claude: '1', n: String(Date.now()) });
  if (session) q.set('claudeSession', session);
  if (dir !== undefined) q.set('claudeDir', dir);
  location.hash = `#/terminal?${q}`;
}

export default {
  mount(el) {
    let hostId = state.activeHostId;
    let seq = 0;
    let st = null;
    const content = h('div', { class: 'stack' });
    const picker = hostPicker((id) => { hostId = id; load(); });
    const refresh = button({ label: 'Actualiser', icon: 'refresh', onClick: () => load() });
    el.append(h('div', { class: 'toolbar' }, picker, refresh), content);

    const host = () => state.host(hostId);

    async function load(dir) {
      const mine = ++seq;
      if (!host()) {
        replace(content, emptyState({ icon: 'sparkle', title: 'Claude Code', text: 'Choisissez un hôte pour voir ou lancer ses sessions Claude Code.' }));
        return;
      }
      replace(content, loadingState('Recherche des sessions…'));
      try {
        const data = await get(`/api/hosts/${hostId}/claude${dir === undefined ? '' : `?${qs({ dir })}`}`);
        if (mine !== seq) return;
        st = data;
        render();
      } catch (err) {
        if (mine === seq) replace(content, errorState(err, () => load()));
      }
    }

    function missing(kind) {
      const isTmux = kind === 'tmux';
      return h('div', { class: 'card stack', style: 'padding: var(--s-3)' },
        h('strong', null, isTmux ? 'tmux manquant' : 'Claude Code non installé'),
        h('p', null, isTmux
          ? `tmux n'est pas installé sur ${host().name}. Claude Code y est lancé dans tmux pour continuer à tourner si vous perdez le réseau ou fermez l'application.`
          : `Claude Code n'est pas installé sur ${host().name}, ou n'est pas dans le PATH de l'utilisateur ${host().username}.`),
        h('p', { class: 'dim' }, 'Installation, à lancer sur cet hôte (par exemple depuis un terminal Corvus) :'),
        isTmux ? codeLine(st.tmuxInstall) : [codeLine(st.install.native), h('p', { class: 'dim' }, 'ou, avec Node.js :'), codeLine(st.install.npm)],
        isTmux ? null : h('p', { class: 'dim' }, 'Puis lancez « claude » une fois pour vous connecter à votre compte.'),
        button({ label: 'Revérifier', icon: 'refresh', onClick: () => load() }));
    }

    function sessionCard(s) {
      return h('div', { class: 'card stack', style: 'padding: var(--s-3)' },
        h('div', null,
          h('div', { class: 'host-name mono', style: 'overflow-wrap: anywhere' }, s.name),
          h('div', { class: 'host-addr', style: 'overflow-wrap: anywhere' }, `${s.cwd || '~'} · ${ago(s.activityAt)}`),
          h('div', { class: 'row' }, s.attached ? badge(`${s.attached} client${s.attached > 1 ? 's' : ''}`, 'ok') : badge('détachée'))),
        h('div', { class: 'row' },
          button({ label: 'Reprendre', icon: 'play', variant: 'primary', attrs: { style: 'flex: 1 1 auto' }, onClick: () => launchClaude(host(), { session: s.name }) }),
          button({ label: `Tuer ${s.name}`, icon: 'trash', iconOnly: true, variant: 'danger', onClick: () => kill(s) })));
    }

    function render() {
      const ready = st.tmux && st.claude.installed;
      const dirField = field({
        label: 'Dossier de la nouvelle session',
        control: input({ value: st.settings.dir, placeholder: '~ (dossier personnel)' }),
        hint: 'Laissez vide pour le dossier personnel de l\'utilisateur. Dossier par défaut : fiche de l\'hôte.',
      });
      const newBtn = button({ label: 'Nouvelle session', icon: 'plus', variant: 'primary', disabled: !ready, onClick: () => startNew(dirField, newBtn) });
      replace(content,
        h('p', { class: 'dim' },
          st.claude.installed ? `Claude Code ${st.claude.version || ''} · commande : ` : 'Commande : ', h('code', { class: 'mono' }, st.settings.cmd)),
        st.settings.dangerous ? dangerNote() : null,
        !st.tmux ? missing('tmux') : null,
        st.tmux && !st.claude.installed ? missing('claude') : null,
        h('h2', { class: 'section-title' }, 'Sessions actives', badge(String(st.sessions.length))),
        st.sessions.length ? st.sessions.map(sessionCard) : h('p', { class: 'dim' }, 'Aucune session Claude active sur cet hôte.'),
        h('h2', { class: 'section-title' }, 'Nouvelle session'),
        dirField,
        newBtn);
    }

    async function kill(s) {
      const ok = await confirmDialog({
        title: 'Tuer la session ?',
        message: `« ${s.name} » sera arrêtée : le travail en cours de Claude Code sera interrompu et la conversation de cette session fermée.`,
        confirmLabel: 'Tuer', danger: true,
      });
      if (!ok) return;
      try {
        await del(`/api/hosts/${hostId}/claude/sessions/${s.name}`);
        toast('Session arrêtée', 'ok', 1500);
      } catch (err) { toastError(err); }
      await load();
    }

    async function startNew(dirField, btn) {
      const dir = dirField.querySelector('input').value.trim();
      let fresh;
      try { fresh = await busy(btn, () => get(`/api/hosts/${hostId}/claude?${qs({ dir })}`)); } catch (err) { toastError(err); return; }
      st = fresh;
      if (!fresh.tmux || !fresh.claude.installed) { render(); return; }
      if (dir && fresh.dirOk === false) { dirField.setError?.(`Dossier introuvable sur ${host().name}`); return; }
      dirField.setError?.(null);
      if (fresh.settings.dangerous) {
        const ok = await confirmDialog({
          title: 'Lancer sans confirmation ?',
          message: `La commande de ${host().name} contient ${DANGEROUS_FLAG} : Claude Code pourra modifier des fichiers et lancer des commandes sans rien demander. Continuer ?`,
          confirmLabel: 'Lancer quand même', danger: true,
        });
        if (!ok) return;
      }
      launchClaude(host(), { dir });
    }

    const unsub = state.subscribe(() => { if (!host() && hostId) { hostId = null; load(); } });
    load();
    return () => { seq++; picker.destroy(); unsub(); };
  },
};
