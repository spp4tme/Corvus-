// Écrans d'accès : premier administrateur (token d'amorçage), connexion (identifiant + mot de
// passe + code TOTP), enrôlement TOTP (obligatoire à la première connexion).
import { post } from '../api.js';
import { h, clear } from '../ui/dom.js';
import { logo } from '../ui/icons.js';
import { button, field, input, busy, toast } from '../ui/components.js';
import { passkeysSupported, loginWithPasskey } from '../passkey.js';

function card(...children) {
  return h('form', { class: 'card login-card', novalidate: true },
    h('div', { class: 'login-logo' }, logo(), h('div', null,
      h('div', { class: 'brand-name' }, 'Corvus'),
      h('div', { class: 'dim' }, 'Passerelle SSH de votre tailnet'))),
    ...children);
}

function show(root, form, focus) {
  clear(root).appendChild(h('div', { class: 'login' }, form));
  focus?.focus();
}

export function renderLogin(root, onSuccess, { offline = false, setupRequired = false, passkeys = false } = {}) {
  if (setupRequired) return renderSetup(root, onSuccess);
  const user = input({ name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true });
  const pass = input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: '6', placeholder: '123456' });
  const fUser = field({ label: 'Identifiant', control: user });
  const fPass = field({ label: 'Mot de passe', control: pass });
  const fCode = field({ label: 'Code à 6 chiffres', control: code, hint: 'Affiché par votre application d\'authentification (Aegis, Google Authenticator, 1Password…).' });
  const submit = button({ label: 'Se connecter', variant: 'primary', type: 'submit', block: true, icon: 'lock' });
  // Passkey : connexion sans mot de passe (empreinte, visage ou code de l'appareil).
  const pk = passkeys && passkeysSupported()
    ? button({
      label: 'Se connecter avec une passkey', icon: 'key', block: true,
      onClick: async () => {
        try { await busy(pk, loginWithPasskey); onSuccess(); } catch (err) {
          if (err.name !== 'NotAllowedError') fPass.setError(err.message);
        }
      },
    })
    : null;
  const form = card(
    offline ? h('div', { class: 'test-result ko', role: 'alert' }, 'Serveur injoignable. Vérifiez que Corvus tourne et que Tailscale est connecté.') : null,
    fUser, fPass, fCode, submit, pk);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const f of [fUser, fPass, fCode]) f.setError(null);
    if (!user.value.trim()) { fUser.setError('Indiquez votre identifiant.'); user.focus(); return; }
    if (!pass.value) { fPass.setError('Indiquez votre mot de passe.'); pass.focus(); return; }
    try {
      const r = await busy(submit, () => post('/api/auth/login', { username: user.value.trim(), password: pass.value, code: code.value.trim() }));
      if (r?.enroll) return renderEnroll(root, onSuccess, r.enroll, user.value.trim());
      onSuccess();
    } catch (err) {
      if (err.code === 'BAD_CODE') { fCode.setError(err.message); code.select(); } else { fPass.setError(err.message); pass.select(); }
    }
  });
  show(root, form, user);
}

function renderSetup(root, onSuccess) {
  const token = input({ type: 'password', name: 'bootstrap', autocomplete: 'off', placeholder: 'cv_…' });
  const user = input({ name: 'username', autocomplete: 'username', autocapitalize: 'none', value: 'admin' });
  const pass = input({ type: 'password', autocomplete: 'new-password' });
  const pass2 = input({ type: 'password', autocomplete: 'new-password' });
  const fToken = field({ label: 'Token d\'amorçage', control: token, hint: 'Affiché au premier lancement du serveur, ou via « npm run token » (sudo corvus token).' });
  const fUser = field({ label: 'Identifiant administrateur', control: user });
  const fPass = field({ label: 'Mot de passe', control: pass, hint: '12 caractères minimum.' });
  const fPass2 = field({ label: 'Confirmer le mot de passe', control: pass2 });
  const submit = button({ label: 'Créer le compte administrateur', variant: 'primary', type: 'submit', block: true, icon: 'shield' });
  const form = card(
    h('p', null, h('strong', null, 'Première connexion. '), 'Créez le compte administrateur. Le token d\'amorçage ne servira plus ensuite.'),
    fToken, fUser, fPass, fPass2, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const f of [fToken, fUser, fPass, fPass2]) f.setError(null);
    if (!token.value.trim()) return fToken.setError('Collez le token d\'amorçage.');
    if (pass.value.length < 12) return fPass.setError('12 caractères minimum.');
    if (pass.value !== pass2.value) return fPass2.setError('Les deux mots de passe diffèrent.');
    try {
      const r = await busy(submit, () => post('/api/auth/setup', { bootstrapToken: token.value.trim(), username: user.value.trim(), password: pass.value }));
      renderEnroll(root, onSuccess, r.enroll, user.value.trim());
    } catch (err) {
      (err.code === 'BAD_TOKEN' || err.code === 'RATE_LIMITED' ? fToken : fUser).setError(err.message);
    }
  });
  show(root, form, token);
}

/** Enrôlement TOTP : secret à saisir dans l'application, puis un code pour vérifier. */
function renderEnroll(root, onSuccess, enroll, username) {
  const grouped = enroll.secret.match(/.{1,4}/g).join(' ');
  const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456' });
  const fCode = field({ label: 'Code affiché par l\'application', control: code });
  const submit = button({ label: 'Activer et se connecter', variant: 'primary', type: 'submit', block: true, icon: 'check' });
  const copy = button({
    label: 'Copier le secret', icon: 'copy', variant: 'ghost',
    onClick: async () => {
      try { await navigator.clipboard.writeText(enroll.secret); toast('Secret copié', 'ok', 1500); } catch { toast('Copie refusée : sélectionnez le texte', 'warn'); }
    },
  });
  const form = card(
    h('p', null, h('strong', null, 'Double authentification obligatoire. '),
      `Ajoutez le compte « ${username} » dans votre application d'authentification :`),
    h('ol', { class: 'stack' },
      h('li', null, 'Sur ce téléphone : ', h('a', { href: enroll.uri }, 'ouvrir dans l\'application d\'authentification'), '.'),
      h('li', null, 'Sinon, saisie manuelle de la clé (type « basé sur le temps », 6 chiffres, 30 s) :',
        h('div', { class: 'row wrap' }, h('code', { class: 'mono', style: 'user-select: all; font-size: var(--fs-md); overflow-wrap: anywhere' }, grouped), copy))),
    fCode, submit,
    h('p', { class: 'dim' }, 'Conservez ce secret en lieu sûr (ou l\'application sauvegardée) : sans lui, un administrateur devra réinitialiser votre double authentification.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    fCode.setError(null);
    if (!/^\d{6}$/.test(code.value.trim())) return fCode.setError('6 chiffres.');
    try {
      await busy(submit, () => post('/api/auth/totp/enroll', { enrollToken: enroll.enrollToken, code: code.value.trim() }));
      onSuccess();
    } catch (err) {
      fCode.setError(err.message);
      if (err.code === 'ENROLL_EXPIRED') setTimeout(() => renderLogin(root, onSuccess), 2500);
    }
  });
  show(root, form, code);
}
