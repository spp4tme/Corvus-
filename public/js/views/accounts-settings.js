// Réglages → Mon compte (mot de passe, jetons d'API) et Utilisateurs (administrateurs :
// comptes, rôles, droits par hôte / groupe, réinitialisations).
import { get, post, patch, put, del } from '../api.js';
import { h, replace, formatDate } from '../ui/dom.js';
import {
  button, busy, field, input, select, openDialog, confirmDialog, promptDialog, toast, toastError,
  loadingState, errorState, badge,
} from '../ui/components.js';
import { state } from '../state.js';

const ROLE_LABEL = { admin: 'Administrateur', operator: 'Opérateur', viewer: 'Lecture seule' };

export function renderMyAccount(slot) {
  const box = h('div', { class: 'card card-pad stack' });
  replace(slot, h('h2', { class: 'section-title' }, 'Mon compte'), box);
  const me = state.me;

  const cur = input({ type: 'password', autocomplete: 'current-password' });
  const next = input({ type: 'password', autocomplete: 'new-password' });
  const fCur = field({ label: 'Mot de passe actuel', control: cur });
  const fNext = field({ label: 'Nouveau mot de passe', control: next, hint: '12 caractères minimum.' });
  const pwBtn = button({ label: 'Changer le mot de passe', icon: 'key' });
  pwBtn.addEventListener('click', async () => {
    fNext.setError(next.value.length < 12 ? '12 caractères minimum' : null);
    if (next.value.length < 12) return;
    try {
      await busy(pwBtn, () => post('/api/me/password', { current: cur.value, next: next.value }));
      cur.value = '';
      next.value = '';
      toast('Mot de passe changé', 'ok');
      if (me?.mustChangePassword) location.reload();
    } catch (err) { fCur.setError(err.message); }
  });

  const tokens = h('div');
  async function loadTokens() {
    try {
      const { tokens: list } = await get('/api/me/tokens');
      replace(tokens, list.length ? h('ul', { class: 'list' }, list.map((t) => h('li', { class: 'list-item' },
        h('span', { class: 'grow' }, h('strong', null, t.name), h('br'), h('span', { class: 'dim' }, `créé le ${formatDate(t.createdAt)} · ${t.lastUsedAt ? `utilisé le ${formatDate(t.lastUsedAt)}` : 'jamais utilisé'}`)),
        button({
          label: `Révoquer ${t.name}`, icon: 'trash', iconOnly: true, variant: 'ghost',
          onClick: async () => {
            if (!await confirmDialog({ title: 'Révoquer ce jeton ?', message: `Les scripts qui utilisent « ${t.name} » ne pourront plus se connecter.`, confirmLabel: 'Révoquer', danger: true })) return;
            try { await del(`/api/me/tokens/${t.id}`); loadTokens(); } catch (err) { toastError(err); }
          },
        })))) : h('p', { class: 'dim' }, 'Aucun jeton d\'API.'));
    } catch (err) { replace(tokens, errorState(err, loadTokens)); }
  }
  const newToken = button({
    label: 'Nouveau jeton d\'API', icon: 'plus',
    onClick: async () => {
      const name = await promptDialog({ title: 'Nouveau jeton d\'API', label: 'Nom (usage)', hint: 'Pour un script ou un client sans navigateur : en-tête « Authorization: Bearer <jeton> ».' });
      if (!name) return;
      try {
        const r = await post('/api/me/tokens', { name });
        openDialog({
          title: 'Jeton créé',
          body: h('div', { class: 'stack' }, h('p', null, 'Copiez-le maintenant : il ne sera plus jamais affiché.'),
            h('code', { class: 'mono', style: 'user-select: all; overflow-wrap: anywhere' }, r.token)),
        });
        loadTokens();
      } catch (err) { toastError(err); }
    },
  });

  replace(box,
    me?.mustChangePassword ? h('div', { class: 'test-result ko', role: 'alert' }, 'Mot de passe provisoire : choisissez le vôtre pour continuer.') : null,
    h('p', null, h('strong', null, me?.username || '?'), ' · ', ROLE_LABEL[me?.role] || me?.role, me?.totpEnabled ? ' · double authentification active' : ''),
    h('div', { class: 'form-grid' }, fCur, fNext), h('div', null, pwBtn),
    h('h3', null, 'Jetons d\'API'), tokens, h('div', null, newToken));
  loadTokens();
}

/** Éditeur des droits d'un compte : une ligne par hôte / groupe / « tous les hôtes ». */
function grantsEditor(user, data) {
  const rows = [];
  const options = [
    { value: '', label: '—' }, { value: 'viewer', label: 'Lecture seule' }, { value: 'operator', label: 'Opérateur' },
  ];
  const current = (scope, target) => user.grants.find((g) => g.scope === scope && (scope === 'all' || g.target.toLowerCase() === String(target).toLowerCase()))?.role || '';
  const line = (scope, target, label) => {
    const sel = select(options, { value: current(scope, target), 'aria-label': `Droit sur ${label}` });
    rows.push({ scope, target, sel });
    return h('div', { class: 'row' }, h('span', { class: 'grow ellipsis' }, label), sel);
  };
  const el = h('div', { class: 'stack' },
    line('all', '', 'Tous les hôtes'),
    data.groups.length ? h('strong', null, 'Groupes') : null,
    data.groups.map((g) => line('group', g, `Groupe « ${g} »`)),
    h('strong', null, 'Hôtes'),
    data.hosts.map((x) => line('host', x.id, `${x.name}${x.group ? ` (${x.group})` : ''}`)));
  el.value = () => rows.filter((r) => r.sel.value).map((r) => ({ scope: r.scope, target: r.target, role: r.sel.value }));
  return el;
}

export function renderUsers(slot) {
  if (!state.isAdmin) { replace(slot); return; }
  const box = h('div', { class: 'card card-pad stack' }, loadingState());
  replace(slot, h('h2', { class: 'section-title' }, 'Utilisateurs'), box);

  async function load() {
    let data;
    try { data = await get('/api/users'); } catch (err) { return replace(box, errorState(err, load)); }
    const addBtn = button({ label: 'Ajouter un compte', icon: 'plus', variant: 'primary', onClick: () => edit(null, data) });
    replace(box,
      h('p', { class: 'dim' }, 'Administrateur : tout. Opérateur : utilise les hôtes accordés. Lecture seule : consulte les hôtes accordés. La double authentification est obligatoire pour tous.'),
      h('ul', { class: 'list' }, data.users.map((u) => h('li', { class: 'list-item' },
        h('span', { class: 'grow' },
          h('div', { class: 'row' }, h('strong', null, u.username), badge(ROLE_LABEL[u.role], u.role === 'admin' ? 'accent' : undefined),
            u.disabled ? badge('désactivé', 'danger') : null, !u.totpEnabled ? badge('TOTP à enrôler', 'warn') : null),
          h('div', { class: 'dim' }, u.role === 'admin' ? 'Tous les hôtes' : (u.grants.map((g) => (g.scope === 'all' ? 'tous' : g.scope === 'group' ? `groupe ${g.target}` : (data.hosts.find((x) => x.id === g.target)?.name || g.target))).join(', ') || 'Aucun hôte accordé'),
            u.lastLoginAt ? ` · dernière connexion ${formatDate(u.lastLoginAt)}` : '')),
        button({ label: `Modifier ${u.username}`, icon: 'edit', iconOnly: true, variant: 'ghost', onClick: () => edit(u, data) })))),
      h('div', null, addBtn));
  }

  function edit(u, data) {
    const isNew = !u;
    const name = input({ value: u?.username || '', disabled: !isNew, autocapitalize: 'none' });
    const pw = input({ type: 'password', autocomplete: 'new-password' });
    const role = select(Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })), { value: u?.role || 'operator' });
    const grants = grantsEditor(u || { grants: [] }, data);
    const grantsWrap = h('div', { hidden: role.value === 'admin' }, h('h3', null, 'Hôtes accordés'), grants);
    role.addEventListener('change', () => { grantsWrap.hidden = role.value === 'admin'; });
    const fName = field({ label: 'Identifiant', control: name });
    const fPw = field({ label: isNew ? 'Mot de passe provisoire' : 'Nouveau mot de passe provisoire (optionnel)', control: pw, hint: 'À changer à la première connexion. 12 caractères minimum.' });
    const fRole = field({ label: 'Rôle', control: role });
    const save = button({ label: isNew ? 'Créer' : 'Enregistrer', variant: 'primary', icon: 'save' });
    const extra = isNew ? [] : [
      button({ label: u.disabled ? 'Réactiver' : 'Désactiver', variant: 'ghost', onClick: () => act(() => patch(`/api/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Compte réactivé' : 'Compte désactivé') }),
      button({ label: 'Réinitialiser le TOTP', variant: 'ghost', onClick: async () => {
        if (await confirmDialog({ title: 'Réinitialiser la double authentification ?', message: `${u.username} devra enrôler une nouvelle application à sa prochaine connexion.`, confirmLabel: 'Réinitialiser', danger: true })) act(() => post(`/api/users/${u.id}/reset-totp`), 'TOTP réinitialisé');
      } }),
      button({ label: 'Supprimer', variant: 'danger', icon: 'trash', onClick: async () => {
        if (await confirmDialog({ title: 'Supprimer le compte ?', message: `« ${u.username} » ne pourra plus se connecter. Son historique reste dans le journal.`, confirmLabel: 'Supprimer', danger: true })) act(() => del(`/api/users/${u.id}`), 'Compte supprimé');
      } }),
    ];
    const d = openDialog({
      title: isNew ? 'Nouveau compte' : `Compte ${u.username}`, wide: true,
      body: h('div', { class: 'stack' }, h('div', { class: 'form-grid' }, fName, fRole, fPw), grantsWrap),
      actions: [...extra, h('span', { class: 'grow' }), save],
    });
    async function act(fn, msg) {
      try { await fn(); toast(msg, 'ok'); d.close(); load(); } catch (err) { toastError(err); }
    }
    save.addEventListener('click', async () => {
      try {
        await busy(save, async () => {
          if (isNew) {
            await post('/api/users', { username: name.value.trim(), password: pw.value, role: role.value, grants: grants.value() });
          } else {
            const body = { role: role.value };
            if (pw.value) body.password = pw.value;
            await patch(`/api/users/${u.id}`, body);
            await put(`/api/users/${u.id}/grants`, { grants: role.value === 'admin' ? [] : grants.value() });
          }
        });
        toast(isNew ? 'Compte créé : communiquez le mot de passe provisoire.' : 'Compte enregistré', 'ok', 5000);
        d.close();
        load();
      } catch (err) { toastError(err); }
    });
  }
  load();
}
