// Vue Playbooks : scripts nommés lancés sur un ou plusieurs hôtes (à la main, sur planning ou sur déclencheur).
// L'automatisation est DÉSACTIVÉE par défaut : l'interrupteur général est visible en haut, et le bouton d'arrêt d'urgence aussi.
// Jamais d'innerHTML : tout passe par h() / textContent (les sorties de commandes sont du texte, jamais du HTML).
import { get, post, put, patch, del } from '../api.js';
import { h, replace, formatDate } from '../ui/dom.js';
import { button, busy, openDialog, confirmDialog, field, input, textarea, select, checkbox, segmented, loadingState, emptyState, errorState, badge, toast, toastError } from '../ui/components.js';
import { state } from '../state.js';

const RISK = { safe: ['sans risque', 'ok'], caution: ['prudence', 'warn'], danger: ['danger', 'danger'] };
const STATUS = {
  running: ['en cours', 'warn'], succeeded: ['réussi', 'ok'], ok: ['réussi', 'ok'], failed: ['échec', 'danger'], timeout: ['délai dépassé', 'danger'], error: ['erreur', 'danger'],
  refused: ['refusé', 'danger'], cancelled: ['annulé', 'warn'], skipped: ['sauté', undefined], interrupted: ['interrompu', 'warn'], previewed: ['prévisualisé', undefined],
};
const TRIGGER = { manual: 'à la main', schedule: 'planning', alert: 'alerte', webhook: 'webhook' };
const when = (t) => (t ? formatDate(t) : '—');
const riskBadge = (r) => badge(RISK[r]?.[0] || r, RISK[r]?.[1]);
const statusBadge = (s) => badge(STATUS[s]?.[0] || s, STATUS[s]?.[1]);

/** Pourquoi cet hôte ne peut pas être la cible d'un playbook (null = il le peut). Même principe que partout : on grise en expliquant. */
function unusable(host, needsSsh = true) {
  if (!host) return 'hôte inconnu';
  if (host.osEffective === 'windows') return 'hôte Windows : les commandes d\'un playbook sont POSIX';
  if (needsSsh && host.authType === 'none') return 'hôte « agent seul » : aucun accès SSH pour recevoir des commandes';
  return null;
}

const TEMPLATE = {
  name: 'Mon playbook',
  description: 'Que fait-il ?',
  params: [{ name: 'service', type: 'choice', choices: ['nginx', 'ssh'] }],
  steps: [{ name: 'État du service', run: 'systemctl status {{service}} --no-pager', timeoutSec: 60 }],
  targets: { hostIds: [], groups: [] },
  strategy: { hosts: 'sequential', maxParallel: 3 },
  autoAutorise: false,
};

export default {
  mount(el) {
    const me = state.me;
    const isAdmin = state.isAdmin;
    const canRun = me?.role === 'admin' || me?.role === 'operator';
    const tabs = [{ value: 'history', label: 'Historique' }];
    if (canRun) tabs.unshift({ value: 'playbooks', label: 'Playbooks' });
    if (isAdmin) tabs.push({ value: 'schedules', label: 'Planifications' }, { value: 'triggers', label: 'Alertes' }, { value: 'hooks', label: 'Webhooks' }, { value: 'secrets', label: 'Secrets' }, { value: 'outgoing', label: 'Webhook sortant' });
    let tab = tabs[0].value;
    let enabled = false;
    let closed = false;
    let ws = null; let reconnect = null; let refreshTimer = null;

    const banner = h('div', { class: 'stack' });
    const live = h('div', { class: 'dim', 'aria-live': 'polite' });
    const body = h('div', { class: 'stack' });
    const seg = segmented(tabs, tab, (v) => { tab = v; render(); }, { label: 'Sections' });

    el.appendChild(h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('h2', { class: 'section-title grow' }, 'Playbooks'), live,
        canRun ? button({ label: 'Arrêt d\'urgence', icon: 'stop', variant: 'danger', onClick: emergencyStop }) : null),
      banner, seg, body));

    // --- État général : interrupteur --------------------------------------------------------------------------------------------
    async function loadState() {
      try {
        const s = await get('/api/automation/state');
        enabled = s.enabled;
        const msg = enabled
          ? h('p', { class: 'dim' }, 'Automatisation ', badge('activée', 'ok'), ` — ${s.active} lancement(s) en cours (maximum ${s.maxConcurrentRuns}).`)
          : h('p', { class: 'dim' }, 'Automatisation ', badge('désactivée', 'warn'), ' : rien ne se lance (ni à la main, ni sur planning, alerte ou webhook). C\'est le réglage par défaut.');
        replace(banner, msg, isAdmin ? button({
          label: enabled ? 'Désactiver l\'automatisation' : 'Activer l\'automatisation', icon: enabled ? 'lock' : 'play', variant: enabled ? 'ghost' : 'primary',
          onClick: toggleSwitch,
        }) : null);
      } catch (err) { replace(banner, errorState(err, loadState)); }
    }
    async function toggleSwitch() {
      if (!enabled && !(await confirmDialog({
        title: 'Activer l\'automatisation ?',
        message: 'Les playbooks pourront s\'exécuter sur vos hôtes (à la main, et sur planning, alerte ou webhook pour ceux que vous avez autorisés). Chaque exécution est journalisée. Vous pouvez la couper à tout moment, et l\'arrêt d\'urgence interrompt ce qui tourne.',
        confirmLabel: 'Activer',
      }))) return;
      try { await put('/api/automation/settings', { enabled: !enabled }); toast(enabled ? 'Automatisation désactivée (lancements en cours interrompus)' : 'Automatisation activée', 'ok'); await loadState(); render(); } catch (err) { toastError(err); }
    }
    async function emergencyStop() {
      if (!(await confirmDialog({ title: 'Arrêt d\'urgence', message: 'Tous les playbooks en cours reçoivent l\'ordre de s\'arrêter immédiatement. Les commandes déjà lancées sur les hôtes sont interrompues.', confirmLabel: 'Tout arrêter', danger: true }))) return;
      try { const r = await post('/api/automation/stop', {}); toast(`${r.stopped} lancement(s) interrompu(s)`, r.stopped ? 'ok' : 'info'); scheduleRefresh(); } catch (err) { toastError(err); }
    }

    // --- Playbooks ---------------------------------------------------------------------------------------------------------------
    async function renderPlaybooks() {
      replace(body, loadingState());
      try {
        const { playbooks } = await get('/api/automation/playbooks');
        const head = h('div', { class: 'row' }, h('span', { class: 'grow dim' }, 'Un playbook s\'exécute sur l\'hôte cible, par SSH : jamais dans Corvus.'),
          isAdmin ? button({ label: 'Nouveau playbook', icon: 'plus', variant: 'primary', onClick: () => editor(null) }) : null);
        if (!playbooks.length) { replace(body, head, emptyState({ icon: 'play', title: 'Aucun playbook', text: isAdmin ? 'Créez-en un avec « Nouveau playbook ».' : 'Aucun playbook ne vous est accessible (il faut le droit « opérateur » sur tous ses hôtes).' })); return; }
        replace(body, head, h('ul', { class: 'list' }, playbooks.map((p) => {
          const targets = (p.targets.hostIds || []).map((id) => state.host(id)).filter(Boolean);
          const problems = targets.map((t) => unusable(t, true) && `${t.name} : ${unusable(t, true)}`).filter(Boolean);
          return h('li', { class: 'list-item' },
            h('div', { class: 'grow' },
              h('div', { class: 'host-name' }, p.name, ' ', riskBadge(p.risk), ' ', p.autoAutorise ? badge('auto-autorisé', 'warn') : null, ' ', badge(`v${p.version}`)),
              p.description ? h('div', { class: 'dim' }, p.description) : null,
              h('div', { class: 'dim' }, `${p.steps} commande(s) · ${targets.length ? targets.map((t) => t.name).join(', ') : 'groupes'}${p.targets.groups?.length ? ` · groupes : ${p.targets.groups.join(', ')}` : ''}`),
              ...problems.map((x) => h('div', { class: 'dim' }, `⚠ ${x}`))),
            button({ label: 'Lancer', icon: 'play', variant: 'primary', disabled: !enabled || problems.length > 0, title: !enabled ? 'Automatisation désactivée' : (problems[0] || undefined), onClick: () => runDialog(p.id) }),
            isAdmin ? button({ label: 'Modifier', icon: 'edit', iconOnly: true, variant: 'ghost', onClick: () => editor(p.id) }) : null,
            isAdmin ? button({ label: 'Versions', icon: 'history', iconOnly: true, variant: 'ghost', onClick: () => versionsDialog(p) }) : null,
            isAdmin ? button({ label: 'Supprimer', icon: 'trash', iconOnly: true, variant: 'ghost', onClick: () => removePlaybook(p) }) : null);
        })));
      } catch (err) { replace(body, errorState(err, renderPlaybooks)); }
    }

    async function removePlaybook(p) {
      if (!(await confirmDialog({ title: 'Supprimer ce playbook ?', message: `« ${p.name} », ses versions, planifications, déclencheurs et webhooks seront supprimés. L'historique des exécutions est conservé.`, confirmLabel: 'Supprimer', danger: true }))) return;
      try { await del(`/api/automation/playbooks/${p.id}`, { confirm: true }); toast('Playbook supprimé', 'ok'); renderPlaybooks(); } catch (err) { toastError(err); }
    }

    // Éditeur : texte JSON avec VALIDATION EN DIRECT par le serveur (mêmes règles que l'enregistrement, rien n'est écrit).
    async function editor(id) {
      let current = { ...TEMPLATE };
      if (id) { try { const r = await get(`/api/automation/playbooks/${id}`); const p = r.playbook; current = { name: p.name, description: p.description, params: p.params, steps: p.stepsDetail, targets: p.targets, strategy: p.strategy, autoAutorise: p.autoAutorise }; } catch (err) { toastError(err); return; } }
      const text = textarea({ rows: 18, class: 'textarea mono', 'aria-label': 'Définition du playbook (JSON)' });
      text.value = JSON.stringify(current, null, 2);
      const status = h('div', { class: 'stack', 'aria-live': 'polite' });
      const hostSel = select([{ value: '', label: 'Ajouter un hôte cible…' }, ...state.hosts.map((x) => ({ value: x.id, label: unusable(x) ? `${x.name} — indisponible : ${unusable(x)}` : x.name }))]);
      [...hostSel.options].forEach((o, i) => { if (i > 0 && unusable(state.host(o.value))) o.disabled = true; });
      hostSel.addEventListener('change', () => {
        if (!hostSel.value) return;
        try { const obj = JSON.parse(text.value); obj.targets = obj.targets || {}; obj.targets.hostIds = [...new Set([...(obj.targets.hostIds || []), hostSel.value])]; text.value = JSON.stringify(obj, null, 2); validate(); } catch { toast('Corrigez d\'abord le JSON', 'warn'); }
        hostSel.value = '';
      });
      let timer = null; let seq = 0; let valid = false; let parsed = null;
      const saveBtn = button({ label: id ? 'Enregistrer une nouvelle version' : 'Créer', icon: 'save', variant: 'primary', disabled: true, onClick: save });
      function validate() {
        clearTimeout(timer);
        valid = false; saveBtn.disabled = true;
        try { parsed = JSON.parse(text.value); } catch (err) { replace(status, h('div', { class: 'test-result ko', role: 'alert' }, `JSON invalide : ${err.message}`)); return; }
        const mine = ++seq;
        replace(status, h('div', { class: 'dim' }, 'Validation…'));
        timer = setTimeout(async () => {
          try {
            const r = await post('/api/automation/playbooks/validate', parsed);
            if (mine !== seq) return;
            valid = true; saveBtn.disabled = false;
            replace(status, h('div', { class: 'test-result ok' }, 'Valide · risque ', riskBadge(r.risk), ` · ${r.commands} commande(s) · ${r.hosts.length} hôte(s)${r.secrets.length ? ` · secrets : ${r.secrets.join(', ')}` : ''}`),
              ...r.riskReasons.map((x) => h('div', { class: 'dim' }, `• ${x}`)),
              r.risk === 'danger' ? h('div', { class: 'dim' }, 'Un playbook « danger » exige confirmation (et une prévisualisation) avant chaque lancement et ne peut jamais se lancer automatiquement.') : null);
          } catch (err) { if (mine === seq) replace(status, h('div', { class: 'test-result ko', role: 'alert' }, err.message)); }
        }, 350);
      }
      text.addEventListener('input', validate);
      async function save() {
        if (!valid) return;
        if (parsed.autoAutorise === true && !(await confirmDialog({ title: 'Autoriser le lancement automatique ?', message: 'Ce playbook pourra se lancer SANS que personne ne le valide (planning, alerte, webhook), tant que l\'automatisation est activée. Il ne peut jamais être « danger ».', confirmLabel: 'Autoriser' }))) return;
        try {
          if (id) await busy(saveBtn, () => put(`/api/automation/playbooks/${id}`, parsed)); else await busy(saveBtn, () => post('/api/automation/playbooks', parsed));
          toast(id ? 'Nouvelle version enregistrée' : 'Playbook créé', 'ok'); d.close(true); renderPlaybooks();
        } catch (err) { replace(status, h('div', { class: 'test-result ko', role: 'alert' }, err.message)); }
      }
      const d = openDialog({
        title: id ? `Modifier « ${current.name} »` : 'Nouveau playbook', wide: true,
        body: h('div', { class: 'stack' },
          h('p', { class: 'dim' }, 'Paramètres : {{nom}} (échappé automatiquement, à écrire nu, jamais entre guillemets). Secrets : {{secret.NOM}} (jamais affichés ni journalisés).'),
          hostSel, text, status),
        actions: [button({ label: 'Fermer', variant: 'ghost', onClick: () => d.close() }), saveBtn],
      });
      validate();
    }

    async function versionsDialog(p) {
      try {
        const { versions } = await get(`/api/automation/playbooks/${p.id}/versions`);
        const out = h('pre', { class: 'code' }, 'Choisissez deux versions pour voir la différence.');
        const rows = versions.map((v) => h('li', { class: 'list-item' },
          h('div', { class: 'grow' }, `v${v.version} · ${v.author || '?'} · ${when(v.ts)} · `, riskBadge(v.risk)),
          v.version > 1 ? button({ label: 'Voir la différence avec la précédente', variant: 'ghost', onClick: async () => { try { const r = await get(`/api/automation/playbooks/${p.id}/diff?from=${v.version - 1}&to=${v.version}`); out.textContent = JSON.stringify(r.diff, null, 2); } catch (err) { toastError(err); } } }) : null,
          v.version !== p.version ? button({ label: 'Revenir à cette version', variant: 'ghost', onClick: async () => {
            if (!(await confirmDialog({ title: `Revenir à la v${v.version} ?`, message: 'Une NOUVELLE version recopiant celle-ci sera créée ; l\'historique n\'est jamais réécrit.', confirmLabel: 'Revenir' }))) return;
            try { await post(`/api/automation/playbooks/${p.id}/rollback`, { version: v.version, confirm: true }); toast('Nouvelle version créée', 'ok'); d.close(); renderPlaybooks(); } catch (err) { toastError(err); }
          } }) : null));
        const d = openDialog({ title: `Versions de « ${p.name} »`, wide: true, body: h('div', { class: 'stack' }, h('ul', { class: 'list' }, rows), out), actions: [button({ label: 'Fermer', variant: 'ghost', onClick: () => d.close() })] });
      } catch (err) { toastError(err); }
    }

    // --- Lancement ---------------------------------------------------------------------------------------------------------------
    async function runDialog(id) {
      let p;
      try { p = (await get(`/api/automation/playbooks/${id}`)).playbook; } catch (err) { toastError(err); return; }
      const controls = {};
      const targetHosts = (p.targets.hostIds || []).map((x) => state.host(x)).filter(Boolean);
      const form = h('div', { class: 'stack' }, ...p.params.map((d) => {
        let c;
        if (d.type === 'choice') c = select(d.choices.map((x) => ({ value: x, label: x })), { value: d.default });
        else if (d.type === 'host') c = select(targetHosts.map((x) => ({ value: x.id, label: x.name })));
        else c = input({ value: d.default === undefined ? '' : String(d.default), inputmode: d.type === 'int' ? 'numeric' : undefined, placeholder: d.type === 'path' ? '/chemin/absolu' : '' });
        controls[d.name] = { c, def: d };
        return field({ label: `${d.label || d.name}${d.required === false ? ' (facultatif)' : ''}`, control: c, hint: d.type === 'int' ? `entier entre ${d.min} et ${d.max}` : (d.type === 'path' ? 'chemin absolu, sans « .. »' : undefined) });
      }));
      const values = () => {
        const v = {};
        for (const [name, { c, def }] of Object.entries(controls)) { if (c.value !== '') v[name] = def.type === 'int' ? Number(c.value) : c.value; }
        return v;
      };
      const result = h('div', { class: 'stack' });
      let previewed = false;
      const runBtn = button({ label: 'Lancer', icon: 'play', variant: p.risk === 'danger' ? 'danger' : 'primary', onClick: launch });
      const dryBtn = button({ label: 'Prévisualiser (rien n\'est exécuté)', icon: 'eye', onClick: preview });
      async function preview() {
        try {
          const r = await busy(dryBtn, () => post(`/api/automation/playbooks/${id}/run`, { values: values(), dry: true }));
          previewed = true;
          replace(result, h('div', { class: 'test-result ok' }, 'Prévisualisation : rien n\'a été exécuté sur les hôtes.'),
            ...r.plan.map((host) => h('div', { class: 'stack' }, h('strong', null, host.label),
              ...host.steps.map((s) => h('div', null,
                h('pre', { class: 'code' }, s.command),
                s.analysis ? h('div', { class: 'dim' }, `Risque : ${RISK[s.analysis.level]?.[0] || s.analysis.level}${s.analysis.reasons.length ? ` — ${s.analysis.reasons.join(' ; ')}` : ''}`) : null,
                s.preview?.entries ? h('div', { class: 'dim' }, `Bac à sable de l'agent : ${s.preview.entries.length} changement(s) prévu(s)`) : null,
                s.preview?.error ? h('div', { class: 'dim' }, `Prévisualisation de l'agent : ${s.preview.error}`) : null,
                s.preview?.skipped ? h('div', { class: 'dim' }, s.preview.skipped) : null)))));
        } catch (err) { replace(result, h('div', { class: 'test-result ko', role: 'alert' }, err.message)); }
      }
      async function launch() {
        let confirm = false;
        if (p.risk !== 'safe') {
          if (!(await confirmDialog({
            title: `Playbook à risque « ${RISK[p.risk]?.[0]} »`,
            message: `« ${p.name} » peut modifier ou supprimer des données sur ${targetHosts.length || 'plusieurs'} hôte(s). Voulez-vous vraiment le lancer maintenant ?${p.risk === 'danger' && !previewed ? ' (Astuce : prévisualisez d\'abord ; le serveur l\'exige quand un agent le permet.)' : ''}`,
            confirmLabel: 'Lancer', danger: true,
          }))) return;
          confirm = true;
        }
        try {
          const r = await busy(runBtn, () => post(`/api/automation/playbooks/${id}/run`, { values: values(), confirm }));
          toast('Lancement démarré', 'ok'); d.close(true); tab = 'history'; seg.set(tab); render(); openRun(r.runId);
        } catch (err) { replace(result, h('div', { class: 'test-result ko', role: 'alert' }, err.message)); }
      }
      const d = openDialog({
        title: `Lancer « ${p.name} »`, wide: true,
        body: h('div', { class: 'stack' }, h('div', null, riskBadge(p.risk), ' ', badge(`${p.steps} commande(s)`), ' ', badge(`${targetHosts.length} hôte(s)`)), p.description ? h('p', { class: 'dim' }, p.description) : null, form, result),
        actions: [button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close() }), dryBtn, runBtn],
      });
    }

    // --- Historique --------------------------------------------------------------------------------------------------------------
    async function renderHistory() {
      replace(body, loadingState());
      try {
        const { runs } = await get('/api/automation/runs?limit=50');
        if (!runs.length) { replace(body, emptyState({ icon: 'history', title: 'Aucune exécution', text: 'L\'historique des lancements apparaîtra ici.' })); return; }
        replace(body, h('ul', { class: 'list' }, runs.map((r) => h('li', { class: 'list-item' },
          h('div', { class: 'grow' },
            h('div', { class: 'host-name' }, r.name, ' ', statusBadge(r.status), ' ', badge(TRIGGER[r.trigger] || r.trigger), ' ', r.dry ? badge('prévisualisation') : null, ' ', riskBadge(r.risk || 'safe')),
            h('div', { class: 'dim' }, `${when(r.startedAt)} · ${r.actor || '—'} · v${r.version}${r.counts ? ` · ${r.counts.ok}/${r.counts.hosts} hôte(s) réussi(s)` : ''}`),
            r.error ? h('div', { class: 'dim' }, r.error) : null),
          button({ label: 'Détails', variant: 'ghost', onClick: () => openRun(r.id) })))));
      } catch (err) { replace(body, errorState(err, renderHistory)); }
    }

    async function openRun(runId) {
      const out = h('div', { class: 'stack' });
      let timer = null;
      async function load() {
        try {
          const { run } = await get(`/api/automation/runs/${runId}`);
          const byHost = new Map();
          for (const s of run.steps) { if (!byHost.has(s.hostId)) byHost.set(s.hostId, { label: s.hostLabel, steps: [] }); byHost.get(s.hostId).steps.push(s); }
          replace(out, h('div', null, statusBadge(run.status), ' ', badge(TRIGGER[run.trigger] || run.trigger), ' ', riskBadge(run.risk || 'safe'), ` ${run.actor || ''} · ${when(run.startedAt)}`),
            run.active ? button({ label: 'Annuler ce lancement', variant: 'danger', onClick: async () => { try { await post(`/api/automation/runs/${runId}/cancel`, {}); toast('Annulation demandée', 'ok'); } catch (err) { toastError(err); } } }) : null,
            run.error ? h('div', { class: 'test-result ko' }, run.error) : null,
            ...[...byHost.values()].map((hh) => h('div', { class: 'stack' }, h('h3', null, hh.label),
              ...hh.steps.map((s) => h('div', null,
                h('div', null, `${s.name} `, statusBadge(s.status), s.code !== null && s.code !== undefined ? ` code ${s.code}` : ''),
                s.output ? h('pre', { class: 'code' }, s.output) : null, // textContent : une sortie n'est jamais interprétée comme du HTML
                s.truncated ? h('div', { class: 'dim' }, 'Sortie tronquée.') : null)))));
          if (run.status !== 'running') clearInterval(timer);
        } catch (err) { replace(out, errorState(err, load)); clearInterval(timer); }
      }
      const d = openDialog({ title: 'Détails du lancement', wide: true, body: out, actions: [button({ label: 'Fermer', variant: 'ghost', onClick: () => d.close() })], onClose: () => clearInterval(timer) });
      await load();
      timer = setInterval(load, 2000);
    }

    // --- Sections d'administration (planifications, alertes, webhooks, secrets, webhook sortant) ----------------------------------
    function jsonDialog({ title, hint, template, onSubmit, submitLabel = 'Créer' }) {
      const text = textarea({ rows: 12, class: 'textarea mono' });
      text.value = JSON.stringify(template, null, 2);
      const msg = h('div', { class: 'stack' });
      const go = button({ label: submitLabel, variant: 'primary', onClick: async () => {
        let obj;
        try { obj = JSON.parse(text.value); } catch (err) { replace(msg, h('div', { class: 'test-result ko', role: 'alert' }, `JSON invalide : ${err.message}`)); return; }
        try { const r = await busy(go, () => onSubmit(obj)); d.close(true); return r; } catch (err) { replace(msg, h('div', { class: 'test-result ko', role: 'alert' }, err.message)); }
      } });
      const d = openDialog({ title, wide: true, body: h('div', { class: 'stack' }, hint ? h('p', { class: 'dim' }, hint) : null, text, msg), actions: [button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close() }), go] });
    }
    let names = new Map();
    const pbName = (id) => names.get(id) || id;
    async function loadNames() { try { names = new Map((await get('/api/automation/playbooks')).playbooks.map((p) => [p.id, p.name])); } catch { /* l'identifiant s'affichera */ } }

    async function renderAdminList({ path, key, title, hint, template, describe, createLabel }) {
      replace(body, loadingState());
      try {
        await loadNames();
        const data = await get(path);
        const items = data[key];
        const head = h('div', { class: 'row' }, h('span', { class: 'grow dim' }, hint),
          button({ label: createLabel, icon: 'plus', variant: 'primary', onClick: () => jsonDialog({ title: createLabel, hint, template, onSubmit: async (obj) => { const r = await post(path, obj); if (key === 'hooks') showSecrets(r.hook); toast('Créé', 'ok'); render(); } }) }));
        if (!items.length) { replace(body, head, emptyState({ icon: 'settings', title: `Aucun(e) ${title}`, text: 'Rien n\'est configuré : rien ne se déclenche.' })); return; }
        replace(body, head, h('ul', { class: 'list' }, items.map((it) => h('li', { class: 'list-item' },
          h('div', { class: 'grow' }, describe(it)),
          key === 'hooks' ? button({ label: it.enabled ? 'Désactiver' : 'Activer', variant: 'ghost', onClick: async () => { try { await patch(`${path}/${it.id}`, { enabled: !it.enabled }); render(); } catch (err) { toastError(err); } } }) : null,
          button({ label: 'Supprimer', icon: 'trash', iconOnly: true, variant: 'ghost', onClick: async () => {
            if (!(await confirmDialog({ title: 'Supprimer ?', message: 'Cette suppression est immédiate.', confirmLabel: 'Supprimer', danger: true }))) return;
            try { await del(`${path}/${it.id}`, { confirm: true }); render(); } catch (err) { toastError(err); }
          } })))));
      } catch (err) { replace(body, errorState(err, render)); }
    }
    function showSecrets(hook) {
      const d = openDialog({
        title: 'Webhook créé : à copier MAINTENANT', wide: true,
        body: h('div', { class: 'stack' }, h('p', { class: 'dim' }, 'Le jeton et le secret ne seront plus jamais affichés. Chaque appel POST /api/hooks/run doit porter : Authorization: Bearer <jeton>, X-Corvus-Timestamp (secondes) et X-Corvus-Signature: sha256=HMAC(secret, "<horodatage>.<corps>").'),
          field({ label: 'Jeton', control: input({ value: hook.token, readonly: true }) }), field({ label: 'Secret de signature', control: input({ value: hook.secret, readonly: true }) })),
        actions: [button({ label: 'J\'ai tout copié', variant: 'primary', onClick: () => d.close() })],
      });
    }
    async function renderSecrets() {
      replace(body, loadingState());
      try {
        const { secrets } = await get('/api/automation/secrets');
        const name = input({ placeholder: 'NOM_DU_SECRET' });
        const value = input({ type: 'password', autocomplete: 'new-password', placeholder: 'valeur (6 à 512 caractères, une seule ligne)' });
        const add = button({ label: 'Enregistrer', icon: 'save', variant: 'primary', onClick: async () => {
          try { await busy(add, () => put(`/api/automation/secrets/${encodeURIComponent(name.value.trim())}`, { value: value.value })); toast('Secret enregistré', 'ok'); renderSecrets(); } catch (err) { toastError(err); }
        } });
        replace(body, h('p', { class: 'dim' }, 'Les secrets sont stockés chiffrés. Dans un playbook : {{secret.NOM}}. Leur valeur n\'est jamais réaffichée, ni écrite dans le journal ; elle est masquée dans les sorties.'),
          h('div', { class: 'row' }, field({ label: 'Nom', control: name }), field({ label: 'Valeur', control: value }), add),
          secrets.length ? h('ul', { class: 'list' }, secrets.map((n) => h('li', { class: 'list-item' }, h('div', { class: 'grow mono' }, n),
            button({ label: 'Supprimer', icon: 'trash', iconOnly: true, variant: 'ghost', onClick: async () => {
              if (!(await confirmDialog({ title: `Supprimer le secret ${n} ?`, message: 'Les playbooks qui l\'utilisent ne pourront plus se lancer.', confirmLabel: 'Supprimer', danger: true }))) return;
              try { await del(`/api/automation/secrets/${encodeURIComponent(n)}`, { confirm: true }); renderSecrets(); } catch (err) { toastError(err); }
            } })))) : emptyState({ icon: 'lock', title: 'Aucun secret', text: 'Ajoutez-en un ci-dessus.' }));
      } catch (err) { replace(body, errorState(err, renderSecrets)); }
    }
    async function renderOutgoing() {
      replace(body, loadingState());
      try {
        const { outgoing } = await get('/api/automation/outgoing');
        replace(body,
          h('p', { class: 'dim' }, 'Un évènement signé (HMAC) est envoyé à votre outil (n8n…) à la fin d\'un playbook. Le contenu est minimal : jamais de sortie de commande ni de paramètre. Pas de redirection, délai de 5 secondes.'),
          h('div', null, outgoing.url ? ['Cible : ', h('span', { class: 'mono' }, outgoing.url), ' ', badge(outgoing.enabled ? 'actif' : 'désactivé', outgoing.enabled ? 'ok' : 'warn'), ` · évènements : ${outgoing.events.join(', ')}`] : 'Aucune cible configurée.'),
          h('div', { class: 'row' },
            button({ label: outgoing.url ? 'Modifier' : 'Configurer', icon: 'edit', variant: 'primary', onClick: () => jsonDialog({
              title: 'Webhook sortant', hint: 'events : succeeded, failed, cancelled. Mettez rotateSecret à true pour générer un nouveau secret.',
              template: { url: outgoing.url || 'https://n8n.exemple.ts.net/webhook/corvus', events: outgoing.events, enabled: true }, submitLabel: 'Enregistrer',
              onSubmit: async (obj) => { const r = await put('/api/automation/outgoing', obj); if (r.outgoing.secret) openDialog({ title: 'Secret de signature : à copier MAINTENANT', body: h('div', { class: 'stack' }, field({ label: 'Secret', control: input({ value: r.outgoing.secret, readonly: true }) }), h('p', { class: 'dim' }, 'Il ne sera plus jamais affiché.')), actions: [] }); render(); },
            }) }),
            outgoing.url ? button({ label: 'Envoyer un test', onClick: async () => { try { const r = await post('/api/automation/outgoing/test', {}); toast(r.sent ? 'Envoyé' : `Non envoyé : ${r.reason}`, r.sent ? 'ok' : 'warn'); } catch (err) { toastError(err); } } }) : null,
            outgoing.url ? button({ label: 'Supprimer', variant: 'danger', onClick: async () => { if (!(await confirmDialog({ title: 'Supprimer le webhook sortant ?', message: 'Plus rien ne sera envoyé.', confirmLabel: 'Supprimer', danger: true }))) return; try { await del('/api/automation/outgoing', { confirm: true }); render(); } catch (err) { toastError(err); } } }) : null));
      } catch (err) { replace(body, errorState(err, render)); }
    }

    function render() {
      loadState();
      if (tab === 'playbooks') renderPlaybooks();
      else if (tab === 'history') renderHistory();
      else if (tab === 'schedules') renderAdminList({ path: '/api/automation/schedules', key: 'schedules', title: 'planification', createLabel: 'Nouvelle planification',
        hint: 'Cron + fuseau horaire OBLIGATOIRE ; jamais pour un playbook non auto-autorisé ou « danger » ; pas plus d\'un déclenchement toutes les 5 minutes ; aucune exécution de rattrapage après une panne.',
        template: { playbookId: 'IDENTIFIANT_DU_PLAYBOOK', cron: '0 3 * * *', tz: 'Europe/Paris', window: { from: '02:00', to: '05:00' }, values: {} },
        describe: (s) => [h('div', { class: 'host-name mono' }, `${s.cron} (${s.tz})`), h('div', { class: 'dim' }, `playbook ${pbName(s.playbookId)} · prochaine : ${when(s.nextAt)} · dernière : ${s.lastStatus || '—'} ${s.enabled ? '' : '· désactivée'}`)] });
      else if (tab === 'triggers') renderAdminList({ path: '/api/automation/triggers', key: 'triggers', title: 'déclencheur d\'alerte', createLabel: 'Nouveau déclencheur',
        hint: 'LISTE D\'AUTORISATIONS : un type d\'alerte précis → un playbook. Limité en fréquence ; au-delà de maxRuns en windowMin minutes il se désactive tout seul et lève une alerte critique.',
        template: { playbookId: 'IDENTIFIANT_DU_PLAYBOOK', alertKind: 'host-down', minSeverity: 'warn', maxRuns: 3, windowMin: 60, cooldownSec: 120 },
        describe: (t) => [h('div', { class: 'host-name mono' }, `${t.alertKind} (≥ ${t.minSeverity}) → ${pbName(t.playbookId)}`), h('div', { class: 'dim' }, `au plus ${t.maxRuns} en ${t.windowMin} min · repos ${t.cooldownSec} s ${t.enabled ? '' : (t.trippedAt ? `· COUPE-CIRCUIT déclenché le ${when(t.trippedAt)}` : '· désactivé')}`)] });
      else if (tab === 'hooks') renderAdminList({ path: '/api/automation/hooks', key: 'hooks', title: 'webhook', createLabel: 'Nouveau webhook',
        hint: 'Un jeton limité à UN playbook (auto-autorisé, jamais « danger »), signé en HMAC, anti-rejeu. Le jeton et le secret ne sont montrés qu\'une fois.',
        template: { playbookId: 'IDENTIFIANT_DU_PLAYBOOK', name: 'ci-github' },
        describe: (x) => [h('div', { class: 'host-name' }, x.name, ' ', badge(x.enabled ? 'actif' : 'désactivé', x.enabled ? 'ok' : 'warn')), h('div', { class: 'dim' }, `playbook ${pbName(x.playbookId)} · dernier appel : ${when(x.lastUsedAt)}`)] });
      else if (tab === 'secrets') renderSecrets();
      else if (tab === 'outgoing') renderOutgoing();
    }

    // --- État en direct (WebSocket authentifié) ------------------------------------------------------------------------------------
    function scheduleRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { if (!closed && (tab === 'history' || tab === 'playbooks')) render(); else loadState(); }, 400);
    }
    function connect() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws/automation`);
      ws.addEventListener('message', (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'hello') live.textContent = m.active.length ? `${m.active.length} en cours` : '';
        else if (m.type === 'run-start') { live.textContent = `${m.name} : démarré`; scheduleRefresh(); }
        else if (m.type === 'run-end') { live.textContent = `${m.name} : ${STATUS[m.status]?.[0] || m.status}`; scheduleRefresh(); }
      });
      ws.addEventListener('close', () => { if (!closed) reconnect = setTimeout(connect, 4000); });
      ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignoré */ } });
    }

    render();
    connect();
    return () => { closed = true; clearTimeout(reconnect); clearTimeout(refreshTimer); try { ws?.close(); } catch { /* ignoré */ } };
  },
};
