// Écran de connexion : saisie du token d'accès.
import { post } from '../api.js';
import { h, clear } from '../ui/dom.js';
import { logo } from '../ui/icons.js';
import { button, field, input, busy } from '../ui/components.js';

export function renderLogin(root, onSuccess, { offline = false } = {}) {
  const tokenInput = input({ type: 'password', name: 'token', autocomplete: 'current-password', placeholder: 'cv_…', required: true });
  const tokenField = field({
    label: 'Token d\'accès',
    control: tokenInput,
    hint: 'Affiché au premier lancement du serveur, ou via « npm run token ».',
  });
  const submit = button({ label: 'Se connecter', variant: 'primary', type: 'submit', block: true, icon: 'lock' });
  const form = h('form', { class: 'card login-card', novalidate: true },
    h('div', { class: 'login-logo' }, logo(), h('div', null,
      h('div', { class: 'brand-name' }, 'Corvus'),
      h('div', { class: 'dim' }, 'Passerelle SSH de votre tailnet'))),
    offline ? h('div', { class: 'test-result ko', role: 'alert' }, 'Serveur injoignable. Vérifiez que Corvus tourne et que Tailscale est connecté.') : null,
    tokenField,
    submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) { tokenField.setError('Collez votre token.'); tokenInput.focus(); return; }
    tokenField.setError(null);
    try {
      await busy(submit, () => post('/api/auth/login', { token }));
      onSuccess();
    } catch (err) {
      tokenField.setError(err.message);
      tokenInput.select();
    }
  });

  clear(root).appendChild(h('div', { class: 'login' }, form));
  tokenInput.focus();
}
