// Vue Admin (façon Cockpit) : services systemd, journal en direct, pare-feu, utilisateurs,
// mises à jour, règle sudoers limitée. Toute action modifiante demande une confirmation.
import { get, post, qs } from '../api.js';
import { h, replace, prefs, formatDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import {
  button, busy, field, input, select, segmented, confirmDialog, toast, toastError,
  loadingState, emptyState, errorState, badge,
} from '../ui/components.js';
import { hostPicker } from '../ui/hostpicker.js';
import { state } from '../state.js';

const PRIO = ['urgence', 'alerte', 'critique', 'erreur', 'avertissement', 'notice', 'info', 'debug'];

export default {
  mount(el) {
    let hostId = state.activeHostId;
    let tab = prefs.get('adminTab', 'services');
    let timer = null;
    const content = h('div');
    const picker = hostPicker((id) => { hostId = id; render(); });
    const tabs = segmented([
      { value: 'services', label: 'Services' }, { value: 'logs', label: 'Journal' }, { value: 'firewall', label: 'Pare-feu' },
      { value: 'users', label: 'Utilisateurs' }, { value: 'updates', label: 'Mises à jour' }, { value: 'sudo', label: 'Sudo' },
    ], tab, (x) => { tab = x; prefs.set('adminTab', x); render(); }, { label: 'Section' });
    el.append(h('div', { class: 'toolbar' }, picker), h('div', { class: 'toolbar scroll-x' }, tabs), content);
    const api = (p) => `/api/hosts/${hostId}/${p}`;
    const isAdmin = () => state.isAdmin;
    const act = async (btn, message, fn, okMsg, after) => {
      if (!await confirmDialog({ title: 'Confirmer', message, confirmLabel: 'Confirmer', danger: true })) return;
      try { await busy(btn, fn); toast(okMsg, 'ok'); after?.(); } catch (err) { toastError(err); if (err.code === 'SUDO_REQUIRED') { tab = 'sudo'; tabs.set('sudo'); render(); } }
    };

    function render() {
      clearTimeout(timer);
      if (!state.host(hostId)) return replace(content, emptyState({ icon: 'settings', title: 'Choisissez un hôte', text: 'Services, journal, pare-feu, utilisateurs et mises à jour de la machine.' }));
      ({ services, logs, firewall, users, updates, sudo })[tab]?.();
    }

    async function services() {
      replace(content, loadingState('systemctl…'));
      let data;
      try { data = await get(api('admin/services')); } catch (err) { return replace(content, errorState(err, services)); }
      const filter = input({ type: 'search', placeholder: 'Filtrer…', 'aria-label': 'Filtrer les services', class: 'input search' });
      const list = h('ul', { class: 'list' });
      const draw = () => {
        const q = filter.value.trim().toLowerCase();
        replace(list, data.services.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q)).slice(0, 300).map((s) => {
          const running = s.active === 'active';
          const btn = (action, label, ic) => {
            const b = button({ label: `${label} ${s.name}`, icon: ic, iconOnly: true, variant: 'ghost' });
            b.addEventListener('click', () => act(b, `systemctl ${action} ${s.name}`, () => post(api(`admin/services/${encodeURIComponent(s.name)}/${action}`), { confirm: true }), `${s.name} : ${action} OK`, services));
            return b;
          };
          return h('li', { class: 'list-item' },
            h('span', { class: 'grow' },
              h('div', { class: 'row' }, h('strong', { class: 'mono ellipsis' }, s.name),
                badge(s.active === 'failed' ? 'en échec' : running ? s.sub : 'arrêté', s.active === 'failed' ? 'danger' : running ? 'ok' : undefined),
                s.enabled ? badge(s.enabled === 'enabled' ? 'au démarrage' : s.enabled) : null),
              h('div', { class: 'dim ellipsis' }, s.description)),
            button({ label: `Journal de ${s.name}`, icon: 'journal', iconOnly: true, variant: 'ghost', onClick: () => { tab = 'logs'; tabs.set('logs'); logs(s.name); } }),
            isAdmin() ? [running ? btn('restart', 'Redémarrer', 'restart') : btn('start', 'Démarrer', 'play'), running ? btn('stop', 'Arrêter', 'stop') : null] : null);
        }));
      };
      filter.addEventListener('input', draw);
      replace(content, h('div', { class: 'toolbar' }, filter, h('span', { class: 'dim' }, `${data.services.length} services`)), list);
      draw();
    }

    async function logs(unit) {
      const unitIn = input({ value: unit || '', placeholder: 'service (vide = tout)', 'aria-label': 'Service' });
      const prio = select([{ value: '', label: 'Toutes priorités' }, ...PRIO.map((p, i) => ({ value: String(i), label: `≤ ${p}` }))], { value: '', 'aria-label': 'Priorité' });
      const grep = input({ type: 'search', placeholder: 'Filtrer le texte…', 'aria-label': 'Filtrer le texte', class: 'input search' });
      const live = h('input', { type: 'checkbox', checked: true });
      const out = h('div', { class: 'logs-live', role: 'log', 'aria-live': 'off' });
      const hint = h('div');
      let cursor = null;
      let rows = [];
      const draw = () => {
        const q = grep.value.trim().toLowerCase();
        const shown = rows.filter((e) => !q || e.message.toLowerCase().includes(q) || (e.ident || '').toLowerCase().includes(q)).slice(-800);
        replace(out, shown.map((e) => h('div', { class: `log-line prio-${e.priority}` },
          h('span', { class: 'faint' }, new Date(e.ts).toLocaleTimeString('fr-FR')), ' ', h('span', { class: 'dim' }, `${e.ident || e.unit || ''}:`), ' ', e.message)));
        out.scrollTop = out.scrollHeight;
      };
      const poll = async (first) => {
        if (tab !== 'logs') return;
        try {
          const r = await get(`${api('admin/logs')}?${qs({ unit: unitIn.value.trim() || undefined, priority: prio.value || undefined, lines: first ? 300 : 500, cursor: first ? undefined : cursor || undefined })}`);
          if (r.cursor) cursor = r.cursor;
          rows = first ? r.entries : rows.concat(r.entries).slice(-3000);
          replace(hint, r.hint ? h('p', { class: 'dim' }, r.hint) : null);
          draw();
        } catch (err) { replace(out, errorState(err)); return; }
        // « En direct » : nouvelles lignes toutes les 2 s, à partir du dernier curseur.
        if (live.checked && tab === 'logs') timer = setTimeout(() => poll(false), 2000);
      };
      const reload = () => { clearTimeout(timer); cursor = null; poll(true); };
      unitIn.addEventListener('change', reload);
      prio.addEventListener('change', reload);
      grep.addEventListener('input', draw);
      live.addEventListener('change', () => { clearTimeout(timer); if (live.checked) poll(false); });
      replace(content, h('div', { class: 'toolbar' }, unitIn, prio, grep, h('label', { class: 'check' }, live, h('span', null, 'En direct'))), hint, out);
      poll(true);
    }

    async function firewall() {
      replace(content, loadingState('Pare-feu…'));
      let fw;
      try { fw = await get(api('admin/firewall')); } catch (err) { return replace(content, errorState(err, firewall)); }
      const parts = [];
      if (fw.ufw.available) {
        const port = input({ placeholder: '443 ou 8000:8100', 'aria-label': 'Port', inputmode: 'numeric' });
        const proto = select([{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }, { value: 'any', label: 'les deux' }], { 'aria-label': 'Protocole' });
        const from = input({ placeholder: 'source (optionnel) : 100.64.0.0/10', 'aria-label': 'Source' });
        const addBtn = (action, label) => {
          const b = button({ label, variant: action === 'deny' ? 'danger' : 'primary' });
          b.addEventListener('click', () => act(b, `ufw ${action} ${port.value}${proto.value !== 'any' ? `/${proto.value}` : ''}${from.value ? ` depuis ${from.value}` : ''}`,
            () => post(api('admin/firewall/ufw'), { action, port: port.value.trim(), proto: proto.value, from: from.value.trim() || undefined, confirm: true }), 'Règle ajoutée', firewall));
          return b;
        };
        parts.push(h('div', { class: 'card card-pad stack' },
          h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'ufw'), fw.ufw.error ? badge('illisible', 'warn') : badge(fw.ufw.active ? 'actif' : 'inactif', fw.ufw.active ? 'ok' : 'warn')),
          fw.ufw.error ? h('p', { class: 'dim' }, fw.ufw.error) : h('ul', { class: 'list' }, fw.ufw.rules.map((r) => {
            const b = button({ label: `Supprimer la règle ${r.num}`, icon: 'trash', iconOnly: true, variant: 'ghost' });
            b.addEventListener('click', () => act(b, `Supprimer la règle ufw n° ${r.num} : ${r.text}`, () => post(api('admin/firewall/ufw'), { action: 'delete', num: r.num, confirm: true }), 'Règle supprimée', firewall));
            return h('li', { class: 'list-item' }, h('span', { class: 'mono grow' }, `[${r.num}] ${r.text}`), isAdmin() ? b : null);
          })),
          isAdmin() && !fw.ufw.error ? h('div', { class: 'row wrap' }, port, proto, from, addBtn('allow', 'Autoriser'), addBtn('deny', 'Bloquer')) : null));
      }
      if (fw.nft.available) {
        parts.push(h('details', { class: 'card card-pad' }, h('summary', null, 'nftables (lecture seule)'),
          fw.nft.error ? h('p', { class: 'dim' }, fw.nft.error) : h('pre', { class: 'diff' }, fw.nft.ruleset || '(vide)')));
      }
      replace(content, parts.length ? parts : emptyState({ icon: 'shield', title: 'Aucun pare-feu géré', text: 'ni ufw ni nftables trouvés sur cet hôte.' }),
        h('p', { class: 'dim' }, `Garde-fou : Corvus refuse de bloquer le port SSH qu'il utilise (${state.host(hostId)?.port || 22}).`));
    }

    async function users() {
      replace(content, loadingState());
      let data;
      try { data = await get(api('admin/users')); } catch (err) { return replace(content, errorState(err, users)); }
      const showAll = h('input', { type: 'checkbox' });
      const list = h('ul', { class: 'list' });
      const draw = () => replace(list, data.users.filter((u) => showAll.checked || u.human).map((u) => {
        const lockBtn = (lock) => {
          const b = button({ label: lock ? `Verrouiller ${u.name}` : `Déverrouiller ${u.name}`, icon: lock ? 'lock' : 'key', iconOnly: true, variant: 'ghost' });
          b.addEventListener('click', () => act(b, `${lock ? 'Verrouiller' : 'Déverrouiller'} le mot de passe de ${u.name} (usermod ${lock ? '-L' : '-U'})`,
            () => post(api(`admin/users/${encodeURIComponent(u.name)}/${lock ? 'lock' : 'unlock'}`), { confirm: true }), 'Fait', users));
          return b;
        };
        return h('li', { class: 'list-item' },
          h('span', { class: 'grow' }, h('div', { class: 'row' }, h('strong', null, u.name), h('span', { class: 'faint' }, `uid ${u.uid}`), u.admin ? badge('sudo', 'warn') : null, !u.login ? badge('sans connexion') : null),
            h('div', { class: 'dim ellipsis' }, `${u.gecos ? `${u.gecos} · ` : ''}${u.home} · ${u.shell}${u.groups.length ? ` · ${u.groups.join(', ')}` : ''}`)),
          isAdmin() && u.human && u.uid !== 0 ? [lockBtn(true), lockBtn(false)] : null);
      }));
      showAll.addEventListener('change', draw);
      replace(content, h('div', { class: 'toolbar' }, h('label', { class: 'check' }, showAll, h('span', null, 'Comptes système aussi'))), list);
      draw();
    }

    async function updates() {
      replace(content, loadingState('Recherche des mises à jour…'));
      let up;
      try { up = await get(api('admin/updates')); } catch (err) { return replace(content, errorState(err, updates)); }
      if (!up.manager) return replace(content, emptyState({ icon: 'download', title: 'Gestionnaire de paquets non reconnu', text: 'apt, dnf, pacman et apk sont pris en charge.' }));
      const refresh = button({ label: 'Rafraîchir la liste', icon: 'refresh' });
      refresh.addEventListener('click', () => act(refresh, `Mettre à jour la liste des paquets (${up.manager})`, () => post(api('admin/updates/refresh'), { confirm: true }), 'Liste à jour', updates));
      const install = button({ label: 'Installer dans un terminal', icon: 'terminal', variant: 'primary', onClick: () => {
        state.setActiveHost(hostId);
        location.hash = `#/terminal?${new URLSearchParams({ host: hostId, type: up.upgradeCommand, n: String(Date.now()) })}`;
      } });
      const sec = up.updates.filter((u) => u.security).length;
      replace(content,
        h('div', { class: 'row wrap' }, badge(`${up.updates.length} mise(s) à jour`, up.updates.length ? 'warn' : 'ok'), sec ? badge(`${sec} de sécurité`, 'danger') : null,
          up.rebootRequired ? badge('redémarrage requis', 'danger') : null, h('span', { class: 'grow' }), isAdmin() && up.canRefresh ? refresh : null, up.updates.length ? install : null),
        h('p', { class: 'dim' }, `L'installation se fait dans un terminal (« ${up.upgradeCommand} », tapée sans être validée) : vous voyez tout et répondez aux questions.`),
        up.updates.length ? h('ul', { class: 'list' }, up.updates.slice(0, 500).map((u) => h('li', { class: 'list-item' },
          h('span', { class: 'grow mono' }, u.name), h('span', { class: 'dim' }, u.from ? `${u.from} → ${u.version}` : u.version), u.security ? badge('sécurité', 'danger') : null))) : null);
    }

    async function sudo() {
      if (!isAdmin()) return replace(content, h('p', { class: 'dim' }, 'Réservé aux administrateurs.'));
      replace(content, loadingState());
      let r;
      try { r = await get(api('sudoers')); } catch (err) { return replace(content, errorState(err, sudo)); }
      const copy = (text) => async () => { try { await navigator.clipboard.writeText(text); toast('Copié', 'ok', 1500); } catch { toast('Copie refusée : sélectionnez le texte', 'warn'); } };
      replace(content,
        h('p', null, 'Les actions d\'administration passent par ', h('code', null, 'sudo -n'), ' : Corvus ne demande ni ne stocke jamais de mot de passe root. Pour les autoriser, installez sur l\'hôte cette règle ', h('strong', null, 'limitée'), ' (à relire avant !).'),
        r.text ? [h('pre', { class: 'diff' }, r.text), h('div', { class: 'row wrap' }, button({ label: 'Copier la règle', icon: 'copy', onClick: copy(r.text) }), button({ label: 'Copier la commande d\'installation', icon: 'terminal', onClick: copy(r.install) }))] : null,
        h('ul', { class: 'dim' }, r.notes.map((n) => h('li', null, n))));
    }

    render();
    return () => { clearTimeout(timer); tab = null; picker.destroy(); };
  },
};

export { icon, formatDate };
