// Vue Radiographie : arbre des processus (qui a lancé quoi, via quelle session SSH), connexions réseau,
// gel / dégel / arrêt d'un processus. Agent requis ; lecture seule tant qu'on ne confirme pas une action.
import { get, post, put } from '../api.js';
import { h, replace, formatDate } from '../ui/dom.js';
import { button, confirmDialog, select, input, segmented, checkbox, loadingState, emptyState, errorState, badge, toast, toastError } from '../ui/components.js';
import { state } from '../state.js';

function tree(processes) {
  const byParent = new Map();
  const known = new Set(processes.map((p) => p.pid));
  for (const p of processes) {
    const parent = known.has(p.ppid) && p.ppid !== p.pid ? p.ppid : 0;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(p);
  }
  return byParent;
}

export default {
  mount(el, { params } = {}) {
    const eligible = () => state.hosts.filter((x) => x.agent);
    // Lien profond des notifications : #/xray?host=<id>&isolate=1 → onglet « Normal » ; la CONFIRMATION reste demandée.
    const wanted = params?.get('host');
    let hostId = eligible().find((x) => x.id === wanted)?.id || eligible().find((x) => x.id === state.activeHostId)?.id || eligible()[0]?.id;
    let pendingIsolate = params?.get('isolate') === '1' && eligible().some((x) => x.id === wanted);
    let tab = pendingIsolate ? 'normal' : 'procs';
    let data = null;
    const root = h('div', { class: 'stack' });
    el.appendChild(root);
    if (!hostId) { replace(root, emptyState({ icon: 'activity', title: 'Aucun hôte avec agent', text: 'La radiographie a besoin d\'un agent Corvus sur l\'hôte (menu « Agents »).' })); return; }

    const hostSel = select(eligible().map((x) => ({ value: x.id, label: x.name })), { value: hostId });
    hostSel.addEventListener('change', () => { hostId = hostSel.value; load(); });
    const q = input({ placeholder: 'Filtrer (programme, commande, utilisateur SSH)…' });
    q.addEventListener('input', draw);
    const tabs = segmented([{ value: 'procs', label: 'Processus' }, { value: 'conns', label: 'Connexions' }, { value: 'normal', label: 'Normal et anomalies' }], tab, (v) => { tab = v; draw(); }, { label: 'Vue' });
    const body = h('div', { class: 'stack' });
    replace(root, h('div', { class: 'row' }, h('h2', { class: 'section-title grow' }, 'Radiographie'), hostSel, button({ label: 'Actualiser', icon: 'refresh', variant: 'ghost', onClick: load })),
      h('p', { class: 'dim' }, 'Instantané en direct, lu par l\'agent sur l\'hôte. Un processus qui naît et meurt en moins de 2 s n\'apparaît pas dans l\'historique.'), tabs, q, body);

    async function act(p, action) {
      const verb = { freeze: 'Geler', thaw: 'Dégeler', kill: 'Tuer' }[action];
      const ok = await confirmDialog({ title: `${verb} ce processus ?`, message: `${p.exe} (pid ${p.pid})${p.cmd ? `\n${p.cmd}` : ''}`, confirmLabel: verb, danger: action !== 'thaw' });
      if (!ok) return;
      try { await post(`/api/hosts/${hostId}/xray/proc`, { pid: p.pid, start: p.start, action, confirm: true }); toast(`${verb} : fait`, 'ok', 2500); load(); } catch (err) { toastError(err); }
    }

    // Fonctions que l'agent de CET hôte annonce (le serveur les calcule avec une explication) ; absent = disponible.
    const feat = (f) => state.host(hostId)?.agent?.support?.[f] || { ok: true, reason: null };
    const KIND = { proc: 'programme', conn: 'destination', listen: 'port en écoute' };
    async function drawNormal() {
      replace(body, loadingState());
      try {
        const o = await get(`/api/hosts/${hostId}/behavior`);
        const admin = state.host(hostId)?.role === 'admin';
        const max = Math.max(1, ...o.hours);
        const canFreeze = feat('procActions').ok;
        const canIsolate = feat('isolation').ok;
        // Une fonction que l'agent n'a pas est grisée ET expliquée : jamais proposée pour échouer ensuite.
        const unavailable = !admin ? [] : [!canFreeze && feat('procActions').reason, !canIsolate && feat('isolation').reason, !feat('ransom').ok && feat('ransom').reason]
          .filter(Boolean).map((text) => h('p', { class: 'dim' }, text));
        const freeze = checkbox('Geler automatiquement un programme jamais vu lancé pendant une heure calme (SIGSTOP, à vous de décider ensuite)', { checked: o.autoFreeze && canFreeze, disabled: !admin || !canFreeze });
        freeze.input.addEventListener('change', async () => { try { await put(`/api/hosts/${hostId}/behavior/settings`, { autoFreeze: freeze.input.checked }); toast('Réglage enregistré', 'ok', 1500); } catch (err) { toastError(err); freeze.input.checked = !freeze.input.checked; } });
        const isolate = checkbox(`Isoler l'hôte du réseau ${Math.round(o.isolateTtl / 60)} min en cas de ransomware probable (Tailscale et Corvus restent joignables ; levée automatique)`, { checked: o.autoIsolate && canIsolate, disabled: !admin || !canIsolate });
        isolate.input.addEventListener('change', async () => { try { await put(`/api/hosts/${hostId}/behavior/settings`, { autoIsolate: isolate.input.checked }); toast('Réglage enregistré', 'ok', 1500); } catch (err) { toastError(err); isolate.input.checked = !isolate.input.checked; } });
        const askIsolate = async () => {
          if (!(await confirmDialog({ title: 'Isoler cet hôte du réseau ?', message: `Presque tout le trafic sera coupé pendant ${Math.round(o.isolateTtl / 60)} min (connexions établies comprises). Resteront joignables : Tailscale et le serveur Corvus. L'isolement se lève tout seul.`, confirmLabel: 'Isoler', danger: true }))) return;
          try { await post(`/api/hosts/${hostId}/isolation`, { action: 'isolate', ttlSec: o.isolateTtl, confirm: true }); toast('Hôte isolé', 'warn', 4000); } catch (err) { toastError(err); }
        };
        const manual = admin ? h('div', { class: 'row' },
          button({ label: 'Isoler maintenant', variant: 'danger', onClick: askIsolate, disabled: !canIsolate, title: canIsolate ? undefined : feat('isolation').reason }),
          button({ label: 'Lever l\'isolement', variant: 'ghost', disabled: !canIsolate, title: canIsolate ? undefined : feat('isolation').reason, onClick: async () => {
            try { await post(`/api/hosts/${hostId}/isolation`, { action: 'release', confirm: true }); toast('Isolement levé', 'ok', 3000); } catch (err) { toastError(err); }
          } })) : null;
        replace(body,
          h('p', null, o.learning ? badge('apprentissage en cours', 'warn') : badge('surveillance active', 'ok'), ' ',
            o.startedAt ? `depuis le ${formatDate(o.startedAt)} · ${o.learnDays} jours d'apprentissage${o.learning ? ` (fin le ${formatDate(o.endsAt)})` : ''}` : 'pas encore d\'événement reçu'),
          h('p', { class: 'dim' }, `Appris : ${o.counts.proc || 0} programmes, ${o.counts.conn || 0} destinations, ${o.counts.listen || 0} ports. Règles et statistiques simples, aucune IA : une anomalie est un élément jamais vu après l'apprentissage.`),
          h('div', { class: 'frise', 'aria-label': 'Activité apprise par heure' }, o.hours.map((n, i) => h('span', { class: 'frise-bar', style: `height:${Math.max(4, Math.round((n / max) * 100))}%`, title: `${i} h : ${n} démarrage(s)` }))),
          h('h3', null, 'Défense'),
          h('p', { class: 'dim' }, 'Fichiers pièges, détection de rafales de fichiers chiffrés (entropie), écrivain principal du disque. Aucune réaction n\'est automatique tant que vous ne l\'activez pas.'),
          ...unavailable, freeze, isolate, manual,
          h('h3', null, `À examiner (${o.anomalies.length})`),
          o.anomalies.length ? h('ul', { class: 'list' }, o.anomalies.map((a) => h('li', { class: 'list-item' },
            h('div', { class: 'grow' }, h('div', { class: 'mono' }, a.item.replaceAll('|', ' · ')), h('div', { class: 'dim' }, badge(KIND[a.kind] || a.kind), ` vu ${a.count}× · ${formatDate(a.firstSeen)}`)),
            state.canOperate(hostId) ? button({ label: 'Autoriser', variant: 'ghost', onClick: async () => { try { await post(`/api/hosts/${hostId}/behavior/allow`, { kind: a.kind, item: a.item }); drawNormal(); } catch (err) { toastError(err); } } }) : null)))
            : emptyState({ icon: 'activity', title: 'Rien à examiner', text: o.learning ? 'Pendant l\'apprentissage, tout est considéré comme normal.' : 'Aucune nouveauté depuis la fin de l\'apprentissage.' }),
          admin ? button({ label: 'Recommencer l\'apprentissage', variant: 'ghost', onClick: async () => {
            if (!(await confirmDialog({ title: 'Recommencer l\'apprentissage ?', message: 'Tout ce qui a été appris sera oublié et les anomalies en attente effacées.', confirmLabel: 'Recommencer', danger: true }))) return;
            try { await post(`/api/hosts/${hostId}/behavior/restart`, { confirm: true }); drawNormal(); } catch (err) { toastError(err); }
          } }) : null);
        // Arrivée par la notification « Isoler… » : on ouvre la confirmation, on n'isole rien d'office.
        if (pendingIsolate) { pendingIsolate = false; if (admin && !canIsolate) toast(feat('isolation').reason, 'warn', 6000); else if (admin) askIsolate(); else toast('Isoler un hôte est réservé aux administrateurs de cet hôte', 'warn', 5000); }
      } catch (err) { replace(body, errorState(err, drawNormal)); }
    }

    function draw() {
      if (tab === 'normal') return drawNormal();
      if (!feat('xray').ok) { replace(body, emptyState({ icon: 'activity', title: 'Non disponible sur cet hôte', text: feat('xray').reason })); return; }
      if (!data) return;
      const f = q.value.toLowerCase();
      const match = (p) => !f || `${p.exe} ${p.cmd} ${p.ssh || ''} ${p.comm}`.toLowerCase().includes(f);
      if (tab === 'conns') {
        const list = data.connections.filter((c) => !f || `${c.exe || ''} ${c.remote}`.toLowerCase().includes(f));
        replace(body, list.length ? h('ul', { class: 'list' }, list.map((c) => h('li', { class: 'list-item' },
          h('div', { class: 'grow' }, h('div', { class: 'mono' }, `${c.local} → ${c.remote}`), h('div', { class: 'dim' }, c.exe || 'processus inconnu', c.pid ? ` (pid ${c.pid})` : ''))))) : emptyState({ icon: 'link', title: 'Aucune connexion sortante', text: 'Les connexions locales (127.0.0.1) sont ignorées.' }));
        return;
      }
      const byParent = tree(data.processes);
      const rows = [];
      const walk = (parent, depth) => {
        for (const p of byParent.get(parent) || []) {
          if (depth < 12) rows.push({ p, depth });
          walk(p.pid, depth + 1);
        }
      };
      walk(0, 0);
      const shown = f ? rows.filter((r) => match(r.p)) : rows;
      const canAct = feat('procActions').ok;
      const isAdmin = state.host(hostId)?.role === 'admin';
      replace(body, isAdmin && !canAct ? h('p', { class: 'dim' }, feat('procActions').reason) : null, h('ul', { class: 'list' }, shown.map(({ p, depth }) => h('li', { class: 'list-item', style: f ? '' : `padding-left:${8 + depth * 14}px` },
        h('div', { class: 'grow' },
          h('div', { class: 'mono' }, p.exe, ' ', h('span', { class: 'dim' }, `pid ${p.pid}`), ' ', p.ssh ? badge(`via SSH · ${p.ssh}`, 'accent') : null, p.uid === 0 ? badge('root', 'warn') : null),
          p.cmd && p.cmd !== p.exe ? h('div', { class: 'dim ellipsis' }, p.cmd) : null),
        isAdmin && canAct ? h('div', { class: 'row' },
          button({ label: 'Geler', variant: 'ghost', onClick: () => act(p, 'freeze') }),
          button({ label: 'Dégeler', variant: 'ghost', onClick: () => act(p, 'thaw') }),
          button({ label: 'Tuer', variant: 'ghost', onClick: () => act(p, 'kill') })) : null))));
    }

    async function load() {
      if (!feat('xray').ok) { data = null; draw(); return; } // rien à demander à un agent qui ne le propose pas
      replace(body, loadingState());
      try { data = await get(`/api/hosts/${hostId}/xray/live`); draw(); } catch (err) { replace(body, errorState(err, load)); }
    }
    load();
  },
};
