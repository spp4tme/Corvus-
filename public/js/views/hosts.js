// Vue Hôtes : liste (épinglés, groupes), recherche, CRUD, test de connexion, import Tailscale.
import { get, post, patch, del } from '../api.js';
import { h, clear, replace, prefs } from '../ui/dom.js';
import { icon, HOST_ICONS } from '../ui/icons.js';
import {
  button, busy, field, input, textarea, select, checkbox, openDialog, confirmDialog,
  toast, toastError, loadingState, emptyState, errorState, badge, segmented,
} from '../ui/components.js';
import { state, sortedHosts } from '../state.js';
import { claudeButton, dangerNote, isDangerous } from './claude.js';

export default {
  mount(el) {
    let query = '';
    const list = h('div');
    const search = input({ type: 'search', placeholder: 'Rechercher un hôte…', 'aria-label': 'Rechercher un hôte', class: 'input search' });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });

    el.append(
      h('div', { class: 'toolbar' },
        search,
        button({ label: 'Ajouter', icon: 'plus', variant: 'primary', onClick: () => editHost() }),
        button({ label: 'Importer Tailscale', icon: 'download', onClick: importTailscale })),
      list);

    function render() {
      if (!state.loaded) return replace(list, loadingState('Chargement des hôtes…'));
      const hosts = sortedHosts().filter((x) => !query ||
        [x.name, x.hostname, x.username, x.group].some((s) => s?.toLowerCase().includes(query)));
      if (!state.hosts.length) {
        return replace(list, emptyState({
          icon: 'server', title: 'Aucun hôte',
          text: 'Ajoutez une machine de votre tailnet (IP 100.x ou nom MagicDNS).',
          action: button({ label: 'Ajouter un hôte', icon: 'plus', variant: 'primary', onClick: () => editHost() }),
        }));
      }
      if (!hosts.length) return replace(list, emptyState({ title: 'Aucun résultat', text: `Rien ne correspond à « ${query} ».` }));

      const groups = new Map();
      const pinned = hosts.filter((x) => x.pinned);
      if (pinned.length) groups.set('Épinglés', pinned);
      for (const x of hosts.filter((y) => !y.pinned)) {
        const g = x.group || 'Sans groupe';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(x);
      }
      clear(list);
      for (const [name, items] of groups) {
        list.appendChild(h('h2', { class: 'section-title' }, name, badge(String(items.length))));
        list.appendChild(h('div', { class: 'host-grid' }, items.map(hostCard)));
      }
    }

    function hostCard(host) {
      const result = h('div', { hidden: true });
      const status = host.connection?.connected ? badge('connecté', 'ok') : null;
      const missing = !host.hasPassword && !host.hasKey && host.authType !== 'agent' ? badge('secret manquant', 'warn') : null;
      const testBtn = button({ label: 'Tester', icon: 'plug', onClick: () => testHost(host, testBtn, result) });
      return h('article', { class: 'card host-card' },
        h('div', { class: 'host-head' },
          h('div', { class: 'host-icon' }, icon(host.icon)),
          h('div', { class: 'grow' },
            h('div', { class: 'row' }, h('h3', { class: 'host-name ellipsis' }, host.name), host.pinned ? icon('pin', { size: 14, label: 'épinglé' }) : null),
            h('div', { class: 'host-addr ellipsis' }, `${host.username}@${host.hostname}${host.port !== 22 ? `:${host.port}` : ''}`)),
          button({ label: host.pinned ? 'Désépingler' : 'Épingler', icon: 'pin', iconOnly: true, variant: 'ghost', pressed: host.pinned, onClick: () => togglePin(host) }),
          button({ label: 'Modifier', icon: 'edit', iconOnly: true, variant: 'ghost', onClick: () => editHost(host) })),
        (status || missing || host.tmux) ? h('div', { class: 'row' }, status, missing, host.tmux ? badge(`tmux · ${host.tmuxSession}`, 'accent') : null) : null,
        result,
        h('div', { class: 'host-actions' },
          button({ label: 'Terminal', icon: 'terminal', variant: 'primary', onClick: () => openTerminal(host) }),
          claudeButton(() => host, (opts) => openClaudeTerminal(host, opts)),
          button({ label: 'Fichiers', icon: 'folder', onClick: () => { state.setActiveHost(host.id); location.hash = '#/files'; } }),
          testBtn));
    }

    async function togglePin(host) {
      try {
        await patch(`/api/hosts/${host.id}`, { pinned: !host.pinned });
        await state.refreshHosts();
      } catch (err) { toastError(err); }
    }

    const unsub = state.subscribe(render);
    render();
    state.refreshHosts().catch((err) => replace(list, errorState(err, () => state.refreshHosts().catch(toastError))));
    return () => unsub();
  },
};

export function openTerminal(host) {
  state.setActiveHost(host.id);
  location.hash = `#/terminal?host=${host.id}&n=${Date.now()}`;
}

/** Ouvre un onglet Claude Code : la vue Terminal lit ces paramètres (session à reprendre, dossier). */
export function openClaudeTerminal(host, { session, dir } = {}) {
  state.setActiveHost(host.id);
  const q = new URLSearchParams({ host: host.id, claude: '1', n: String(Date.now()) });
  if (session) q.set('claudeSession', session);
  if (dir !== undefined) q.set('claudeDir', dir);
  location.hash = `#/terminal?${q}`;
}

/** Affiche le résultat d'un test (et gère le cas critique d'une host key modifiée). */
async function testHost(host, btn, out) {
  out.hidden = false;
  try {
    const r = await busy(btn, () => post(`/api/hosts/${host.id}/test`));
    replace(out, h('div', { class: 'test-result ok' },
      `Connexion OK en ${r.latencyMs} ms${r.uname ? ` — ${r.uname}` : ''}${r.tmux ? ' — tmux disponible' : ''}`,
      h('br'), h('span', { class: 'mono' }, `${r.hostKey.type} ${r.hostKey.fingerprint}`),
      r.hostKey.firstSeen ? ' (nouvelle empreinte mémorisée)' : ''));
    state.refreshHosts().catch(() => {});
  } catch (err) {
    replace(out, testError(err, host, () => testHost(host, btn, out)));
  }
}

function testError(err, host, retry) {
  if (err.code === 'HOSTKEY_MISMATCH') {
    return h('div', { class: 'test-result ko', role: 'alert' },
      h('strong', null, 'ALERTE : l\'empreinte de la clé d\'hôte a changé.'), h('br'),
      'Attendue : ', h('span', { class: 'mono' }, err.details?.expected || '?'), h('br'),
      'Reçue : ', h('span', { class: 'mono' }, err.details?.received || '?'), h('br'),
      'Ne continuez que si vous savez que la machine a été réinstallée ou sa clé régénérée.', h('br'),
      button({
        label: 'Faire confiance à la nouvelle empreinte', variant: 'danger', icon: 'key',
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Remplacer l\'empreinte ?',
            message: `L'ancienne empreinte de ${host.hostname} sera oubliée et la nouvelle acceptée à la prochaine connexion. Vérifiez-la hors-bande (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub sur la machine).`,
            confirmLabel: 'Remplacer', danger: true,
          });
          if (!ok) return;
          try { await del(`/api/hosts/${host.id}/hostkey`); retry?.(); } catch (e) { toastError(e); }
        },
      }));
  }
  return h('div', { class: 'test-result ko', role: 'alert' }, err.message);
}

/** Dialogue d'ajout / modification d'hôte. */
export function editHost(host) {
  const isNew = !host;
  const v = host || { port: 22, authType: 'password', icon: 'server', tmux: prefs.get('defaultTmux', false), tmuxSession: 'corvus', group: '' };
  const kept = 'Laisser vide pour conserver la valeur enregistrée';

  const fName = field({ label: 'Alias', control: input({ value: v.name || '', placeholder: 'ex. Raspberry du salon' }) });
  const fHost = field({ label: 'Hôte', control: input({ value: v.hostname || '', placeholder: '100.x.y.z ou machine.tailnet.ts.net', inputmode: 'url', required: true }), hint: 'IP Tailscale ou nom MagicDNS' });
  const fPort = field({ label: 'Port', control: input({ value: String(v.port ?? 22), inputmode: 'numeric' }) });
  const fUser = field({ label: 'Utilisateur', control: input({ value: v.username || '', placeholder: 'pi', required: true }) });
  const fGroup = field({ label: 'Groupe', control: input({ value: v.group || '', placeholder: 'ex. Maison, Labo', list: 'corvus-groups' }) });
  const groupsList = h('datalist', { id: 'corvus-groups' }, [...new Set(state.hosts.map((x) => x.group).filter(Boolean))].map((g) => h('option', { value: g })));

  let authType = v.authType;
  const fPass = field({ label: 'Mot de passe', control: input({ type: 'password', autocomplete: 'new-password', placeholder: v.hasPassword ? '•••••• (enregistré)' : '' }), hint: v.hasPassword ? kept : undefined });
  const fKey = field({ label: 'Clé privée (OpenSSH / PEM)', control: textarea({ rows: 5, placeholder: v.hasKey ? '(clé enregistrée — coller pour remplacer)' : '-----BEGIN OPENSSH PRIVATE KEY-----' }), span2: true });
  const fPhrase = field({ label: 'Passphrase de la clé', control: input({ type: 'password', autocomplete: 'new-password', placeholder: v.hasPassphrase ? '•••••• (enregistrée)' : 'si la clé est chiffrée' }) });
  const agentNote = h('p', { class: 'dim span-2' }, 'Utilise l\'agent SSH du serveur Corvus (variable SSH_AUTH_SOCK).');
  const authFields = h('div', { class: 'form-grid span-2' });
  const renderAuth = () => {
    replace(authFields,
      authType === 'password' ? fPass : null,
      authType === 'key' ? [fKey, fPhrase] : null,
      authType === 'agent' ? agentNote : null);
  };
  const authSeg = segmented([
    { value: 'password', label: 'Mot de passe' }, { value: 'key', label: 'Clé privée' }, { value: 'agent', label: 'Agent SSH' },
  ], authType, (x) => { authType = x; renderAuth(); }, { label: 'Méthode d\'authentification' });
  renderAuth();

  let iconName = v.icon;
  const iconPick = h('div', { class: 'icon-pick', role: 'group', 'aria-label': 'Icône' });
  const renderIcons = () => replace(iconPick, HOST_ICONS.map((n) => h('button', {
    type: 'button', 'aria-label': n, 'aria-pressed': String(n === iconName), title: n,
    onclick: () => { iconName = n; renderIcons(); },
  }, icon(n))));
  renderIcons();

  const pin = checkbox('Épingler en haut de la liste', { checked: !!v.pinned });
  const tmux = checkbox('Ouvrir les terminaux dans tmux (reprise après coupure)', { checked: !!v.tmux });
  const fTmux = field({ label: 'Nom de session tmux', control: input({ value: v.tmuxSession || 'corvus' }) });
  const fClaudeDir = field({
    label: 'Claude Code : dossier de projet par défaut',
    control: input({ value: v.claudeDir || '', placeholder: '~/projets/mon-appli (vide = dossier personnel)' }),
    hint: 'Dossier de travail des nouvelles sessions Claude Code sur cet hôte.',
  });
  const fClaudeCmd = field({
    label: 'Claude Code : commande',
    control: input({ value: v.claudeCmd || 'claude', placeholder: 'claude' }),
    hint: 'Par défaut « claude ». Exemples : claude --continue, claude --model opus. Seuls des mots simples sont acceptés.',
  });
  const claudeWarn = h('div', { class: 'span-2', hidden: true }, dangerNote());
  const syncClaudeWarn = () => { claudeWarn.hidden = !isDangerous(fClaudeCmd.querySelector('input').value); };
  fClaudeCmd.querySelector('input').addEventListener('input', syncClaudeWarn);
  syncClaudeWarn();
  const result = h('div', { hidden: true, class: 'span-2' });

  const form = h('form', { class: 'form-grid', novalidate: true },
    fName, fHost, fUser, fPort,
    h('div', { class: 'field span-2' }, h('span', { class: 'field-label' }, 'Authentification'), authSeg),
    authFields,
    h('div', { class: 'field span-2' }, h('span', { class: 'field-label' }, 'Icône'), iconPick),
    fGroup, groupsList, fTmux,
    h('div', { class: 'span-2' }, pin, tmux),
    fClaudeDir, fClaudeCmd, claudeWarn,
    result);

  const collect = () => {
    const val = (f) => f.querySelector('input,textarea').value;
    const body = {
      name: val(fName).trim(), hostname: val(fHost).trim(), port: val(fPort).trim() || 22, username: val(fUser).trim(),
      authType, icon: iconName, group: val(fGroup).trim(), pinned: pin.input.checked, tmux: tmux.input.checked,
      tmuxSession: val(fTmux).trim() || 'corvus',
      claudeDir: val(fClaudeDir).trim(), claudeCmd: val(fClaudeCmd).trim() || 'claude',
    };
    if (authType === 'password' && val(fPass)) body.password = val(fPass);
    if (authType === 'key') {
      if (val(fKey).trim()) body.privateKey = val(fKey);
      if (val(fPhrase)) body.passphrase = val(fPhrase);
    }
    return body;
  };
  const check = () => {
    let ok = true;
    for (const [f, msg] of [[fHost, 'Hôte requis'], [fUser, 'Utilisateur requis']]) {
      const empty = !f.querySelector('input').value.trim();
      f.setError(empty ? msg : null);
      if (empty) ok = false;
    }
    const port = Number(fPort.querySelector('input').value || 22);
    fPort.setError(Number.isInteger(port) && port > 0 && port < 65536 ? null : 'Port entre 1 et 65535');
    return ok && !fPort.dataset.invalid;
  };

  const testBtn = button({
    label: 'Tester', icon: 'plug',
    onClick: async () => {
      if (!check()) return;
      result.hidden = false;
      try {
        const body = collect();
        const r = await busy(testBtn, () => (isNew || hasNewSecret(body) ? post('/api/hosts/test', body) : post(`/api/hosts/${host.id}/test`)));
        replace(result, h('div', { class: 'test-result ok' }, `Connexion OK en ${r.latencyMs} ms${r.uname ? ` — ${r.uname}` : ''}`, h('br'),
          h('span', { class: 'mono' }, `${r.hostKey.type} ${r.hostKey.fingerprint}`)));
      } catch (err) {
        replace(result, testError(err, host || { hostname: collect().hostname }, null));
      }
    },
  });
  const saveBtn = button({ label: isNew ? 'Ajouter' : 'Enregistrer', icon: 'save', variant: 'primary', onClick: () => save() });
  const actions = [
    !isNew ? button({ label: 'Supprimer', icon: 'trash', variant: 'danger', onClick: () => remove() }) : null,
    h('span', { class: 'grow' }),
    testBtn, saveBtn,
  ].filter(Boolean);

  const d = openDialog({ title: isNew ? 'Nouvel hôte' : `Modifier ${host.name}`, body: form, actions, wide: true });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  // Focus initial, sauf si l'utilisateur a déjà choisi un champ (sinon la saisie en cours lui serait volée).
  setTimeout(() => { if (!form.contains(document.activeElement)) (isNew ? fHost : fName).querySelector('input').focus(); }, 30);

  async function save() {
    if (!check()) return;
    try {
      const body = collect();
      await busy(saveBtn, () => (isNew ? post('/api/hosts', body) : patch(`/api/hosts/${host.id}`, body)));
      await state.refreshHosts();
      toast(isNew ? 'Hôte ajouté' : 'Hôte enregistré', 'ok');
      d.close(true);
    } catch (err) {
      result.hidden = false;
      replace(result, h('div', { class: 'test-result ko', role: 'alert' }, err.message));
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: 'Supprimer l\'hôte ?', message: `« ${host.name} » et ses secrets chiffrés seront supprimés. Les terminaux ouverts seront fermés.`, confirmLabel: 'Supprimer', danger: true });
    if (!ok) return;
    try {
      await del(`/api/hosts/${host.id}`);
      await state.refreshHosts();
      toast('Hôte supprimé', 'ok');
      d.close(true);
    } catch (err) { toastError(err); }
  }
}

function hasNewSecret(body) {
  return !!(body.password || body.privateKey || body.passphrase);
}

const OS_ICON = { linux: 'server', windows: 'desktop', macOS: 'laptop', iOS: 'phone', android: 'phone' };

async function importTailscale() {
  const body = h('div', { class: 'stack' }, loadingState('Lecture de tailscale status…'));
  const user = input({ value: prefs.get('importUser', ''), placeholder: 'ex. pi' });
  const fUser = field({ label: 'Utilisateur SSH pour les hôtes importés', control: user });
  const importBtn = button({ label: 'Importer', variant: 'primary', icon: 'download', disabled: true });
  const d = openDialog({ title: 'Importer depuis Tailscale', body, actions: [button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close() }), importBtn], wide: true });
  let data;
  try {
    data = await get('/api/tailscale/peers');
  } catch (err) {
    replace(body, errorState(err.code === 'TAILSCALE_MISSING'
      ? new Error('Le CLI tailscale n\'est pas installé sur la machine qui héberge Corvus. Ajoutez les hôtes à la main (IP 100.x ou nom MagicDNS).')
      : err));
    return;
  }
  const known = new Set(state.hosts.map((x) => x.hostname));
  const rows = data.peers.filter((p) => !p.self).map((p) => {
    const addr = p.dnsName || p.ips[0];
    const cb = h('input', { type: 'checkbox', checked: p.online && !known.has(addr), disabled: known.has(addr) });
    return { p, addr, cb, el: h('label', { class: 'list-item clickable' }, cb,
      h('div', { class: 'grow' }, h('div', { class: 'host-name ellipsis' }, p.hostName), h('div', { class: 'host-addr ellipsis' }, addr)),
      badge(p.os || '?'), p.online ? badge('en ligne', 'ok') : badge('hors ligne'), known.has(addr) ? badge('déjà ajouté', 'accent') : null) };
  });
  replace(body,
    h('p', { class: 'dim' }, `Tailnet : ${data.tailnet || 'inconnu'}${data.magicDNS ? ' — MagicDNS actif' : ''}`),
    fUser,
    rows.length ? h('div', { class: 'list' }, rows.map((r) => r.el)) : emptyState({ title: 'Aucune autre machine sur le tailnet' }));
  importBtn.disabled = !rows.length;
  importBtn.addEventListener('click', async () => {
    const username = user.value.trim();
    if (!username) { fUser.setError('Indiquez l\'utilisateur SSH'); return; }
    prefs.set('importUser', username);
    const chosen = rows.filter((r) => r.cb.checked && !r.cb.disabled);
    try {
      await busy(importBtn, async () => {
        for (const r of chosen) {
          await post('/api/hosts', {
            name: r.p.hostName, hostname: r.addr, username, authType: 'password', icon: OS_ICON[r.p.os] || 'server',
            group: 'Tailscale', tailscale: { dnsName: r.p.dnsName, os: r.p.os },
          });
        }
      });
      await state.refreshHosts();
      toast(`${chosen.length} hôte(s) importé(s) — ajoutez leurs secrets avant de vous connecter.`, 'ok', 6000);
      d.close();
    } catch (err) { toastError(err); }
  });
}
