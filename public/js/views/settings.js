// Vue Réglages : préférences de cet appareil (terminal), session, informations de sécurité.
import { get, post } from '../api.js';
import { h, prefs } from '../ui/dom.js';
import { button, field, select, checkbox, toast, toastError } from '../ui/components.js';
import { TERMINAL_THEMES } from '../terminal-themes.js';
import { termSettings } from './terminal.js';
import { state } from '../state.js';

export default {
  mount(el) {
    const size = select([10, 11, 12, 13, 14, 15, 16, 18, 20, 22].map((n) => ({ value: String(n), label: `${n} px` })), { value: String(termSettings.fontSize) });
    size.addEventListener('change', () => { prefs.set('termFontSize', Number(size.value)); termSettings.apply(); });

    const theme = select(Object.entries(TERMINAL_THEMES).map(([value, t]) => ({ value, label: t.label })), { value: termSettings.theme });
    theme.addEventListener('change', () => { prefs.set('termTheme', theme.value); termSettings.apply(); });

    const keybar = select([
      { value: 'auto', label: 'Automatique (écrans tactiles)' }, { value: 'always', label: 'Toujours' }, { value: 'never', label: 'Jamais' },
    ], { value: termSettings.keybar });
    keybar.addEventListener('change', () => { prefs.set('termKeybar', keybar.value); termSettings.apply(); });

    const tmux = checkbox('Activer tmux par défaut pour les nouveaux hôtes', { checked: prefs.get('defaultTmux', false) });
    tmux.input.addEventListener('change', () => prefs.set('defaultTmux', tmux.input.checked));

    const lang = select([{ value: 'fr-FR', label: 'Français' }, { value: 'en-US', label: 'English' }], { value: prefs.get('speechLang', 'fr-FR') });
    lang.addEventListener('change', () => prefs.set('speechLang', lang.value));

    const version = h('span', { class: 'dim' }, '…');
    get('/api/auth/status').then((s) => { version.textContent = `Corvus ${s.version}`; }).catch(() => {});

    const notifSlot = h('div');
    const storageSlot = h('div');
    const accountSlot = h('div');
    const usersSlot = h('div');
    import('./accounts-settings.js').then((m) => { m.renderMyAccount(accountSlot); m.renderUsers(usersSlot); }).catch(() => {});
    if (state.isAdmin) import('./storage-settings.js').then((m) => m.renderStorageSettings(storageSlot)).catch(() => {});
    import('../push.js').then((m) => m.renderPushSettings?.(notifSlot)).catch(() => {});

    el.append(
      accountSlot,
      usersSlot,
      h('h2', { class: 'section-title' }, 'Terminal (cet appareil)'),
      h('div', { class: 'card card-pad form-grid' },
        field({ label: 'Taille de police', control: size }),
        field({ label: 'Thème', control: theme }),
        field({ label: 'Barre de touches', control: keybar }),
        field({ label: 'Langue de la dictée', control: lang }),
        h('div', { class: 'span-2' }, tmux)),
      notifSlot,
      storageSlot,
      h('h2', { class: 'section-title' }, 'Session'),
      h('div', { class: 'card card-pad stack' },
        h('p', { class: 'dim' }, 'Les secrets SSH sont chiffrés sur le serveur (AES-256-GCM) et ne transitent jamais vers ce navigateur. Les empreintes des hôtes sont vérifiées (TOFU).'),
        h('div', { class: 'row' }, version, h('span', { class: 'grow' }),
          button({
            label: 'Se déconnecter', icon: 'logout', variant: 'danger',
            onClick: async () => {
              try { await post('/api/auth/logout'); toast('Déconnecté', 'ok'); location.reload(); } catch (err) { toastError(err); }
            },
          }))));
  },
};
