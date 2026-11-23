// Vue Git : dépôts d'un hôte, statut, stage/unstage, commit, branches, historique, diff, pull/push.
import { get, post, patch, qs } from '../api.js';
import { h, clear, replace, formatDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import {
  button, busy, select, segmented, openDialog, confirmDialog, promptDialog, toast, toastError,
  loadingState, emptyState, errorState, badge, textarea, field,
} from '../ui/components.js';
import { hostPicker } from '../ui/hostpicker.js';
import { state } from '../state.js';
import { prefs } from '../ui/dom.js';

const MAX_DIFF_LINES = 4000;

/** Rendu d'un diff unifié : chaque ligne en texte pur, colorée par classe. */
export function renderDiff(text, truncated) {
  const lines = text.split('\n');
  const pre = h('pre', { class: 'diff' });
  for (const line of lines.slice(0, MAX_DIFF_LINES)) {
    let cls = '';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'd-meta';
    else if (line.startsWith('+')) cls = 'd-add';
    else if (line.startsWith('-')) cls = 'd-del';
    else if (line.startsWith('@@')) cls = 'd-hunk';
    pre.appendChild(h('span', { class: cls }, `${line}\n`));
  }
  const notes = [];
  if (lines.length > MAX_DIFF_LINES) notes.push(`${lines.length - MAX_DIFF_LINES} lignes non affichées.`);
  if (truncated) notes.push('Sortie tronquée à 1 Mo.');
  if (!text.trim()) return emptyState({ icon: 'check', title: 'Aucune différence' });
  return h('div', null, pre, notes.length ? h('p', { class: 'dim' }, notes.join(' ')) : null);
}

const STATUS_LABEL = { M: 'modifié', A: 'ajouté', D: 'supprimé', R: 'renommé', C: 'copié', T: 'type', U: 'conflit', '?': 'non suivi' };

export default {
  mount(el) {
    let hostId = state.activeHostId;
    let repo = null;
    let tab = prefs.get('gitTab', 'status');
    const repoSlot = h('div', { class: 'row grow' });
    const tabs = segmented([
      { value: 'status', label: 'Statut' }, { value: 'branches', label: 'Branches' }, { value: 'log', label: 'Historique' },
    ], tab, (v) => { tab = v; prefs.set('gitTab', v); render(); }, { label: 'Section git' });
    const content = h('div');
    const picker = hostPicker((id) => { hostId = id; repo = null; renderRepos(); });

    el.append(h('div', { class: 'toolbar' }, picker, repoSlot), h('div', { class: 'toolbar' }, tabs), content);

    const api = (action) => `/api/hosts/${hostId}/git/${action}`;

    function renderRepos() {
      clear(repoSlot);
      if (!hostId) {
        tabs.hidden = true;
        return replace(content, emptyState({ icon: 'git', title: 'Choisissez un hôte', text: 'Puis un dépôt git présent sur cette machine.' }));
      }
      const host = state.host(hostId);
      const repos = host?.repos || [];
      repo = repo && repos.includes(repo) ? repo : prefs.get(`gitRepo.${hostId}`, repos[0] || null);
      if (repo && !repos.includes(repo)) repo = repos[0] || null;
      if (repos.length) {
        const sel = select(repos.map((r) => ({ value: r, label: r })), { value: repo, 'aria-label': 'Dépôt' });
        sel.addEventListener('change', () => { repo = sel.value; prefs.set(`gitRepo.${hostId}`, repo); render(); });
        repoSlot.append(h('div', { class: 'grow' }, sel));
      }
      repoSlot.append(
        button({ label: 'Ajouter un dépôt', icon: 'plus', iconOnly: true, onClick: addRepo }),
        button({ label: 'Découvrir les dépôts', icon: 'search', iconOnly: true, onClick: discover }),
        repo ? button({ label: 'Retirer ce dépôt de la liste', icon: 'trash', iconOnly: true, variant: 'ghost', onClick: removeRepo }) : null);
      tabs.hidden = !repo;
      if (!repo) {
        return replace(content, emptyState({
          icon: 'git', title: 'Aucun dépôt enregistré', text: 'Indiquez le chemin d\'un dépôt, ou laissez Corvus chercher sous ~.',
          action: h('div', { class: 'row' }, button({ label: 'Découvrir', icon: 'search', variant: 'primary', onClick: discover }), button({ label: 'Saisir un chemin', icon: 'plus', onClick: addRepo })),
        }));
      }
      render();
    }

    async function saveRepos(list) {
      await patch(`/api/hosts/${hostId}`, { repos: list });
      await state.refreshHosts();
    }

    async function addRepo(pathValue) {
      const p = typeof pathValue === 'string' ? pathValue : await promptDialog({ title: 'Ajouter un dépôt', label: 'Chemin du dépôt', value: '~/', hint: 'Absolu (/srv/app) ou relatif au dossier personnel (~/projets/app).' });
      if (!p) return;
      try {
        await get(`${api('status')}?${qs({ repo: p })}`);
        const list = [...new Set([...(state.host(hostId).repos || []), p])];
        await saveRepos(list);
        repo = p;
        prefs.set(`gitRepo.${hostId}`, repo);
        renderRepos();
      } catch (err) { toastError(err); }
    }

    async function removeRepo() {
      try {
        await saveRepos((state.host(hostId).repos || []).filter((r) => r !== repo));
        repo = null;
        renderRepos();
      } catch (err) { toastError(err); }
    }

    async function discover() {
      const body = h('div', null, loadingState('Recherche des dépôts sous ~ (profondeur 4)…'));
      const d = openDialog({ title: 'Dépôts trouvés', body });
      try {
        const { repos } = await get(api('discover'));
        const known = new Set(state.host(hostId).repos || []);
        if (!repos.length) return replace(body, emptyState({ icon: 'git', title: 'Aucun dépôt trouvé', text: 'Ajoutez-le en saisissant son chemin.' }));
        replace(body, h('div', { class: 'list' }, repos.map((r) => h('button', {
          type: 'button', class: 'list-item clickable list-button', disabled: known.has(r),
          onclick: async () => { d.close(); await addRepo(r); },
        }, icon('git', { size: 20 }), h('span', { class: 'grow mono ellipsis' }, r), known.has(r) ? badge('déjà ajouté', 'accent') : null))));
      } catch (err) { replace(body, errorState(err)); }
    }

    function render() {
      if (!repo) return;
      if (tab === 'branches') return renderBranches();
      if (tab === 'log') return renderLog();
      return renderStatus();
    }

    // ---------- Statut ----------
    async function renderStatus(prefetched) {
      if (!prefetched) replace(content, loadingState('git status…'));
      let st;
      try {
        st = prefetched || await get(`${api('status')}?${qs({ repo })}`);
      } catch (err) { return replace(content, errorState(err, renderStatus)); }

      const remoteBtn = (op, label, ic) => {
        const b = button({ label, icon: ic, onClick: async () => {
          try {
            const r = await busy(b, () => post(api(op), { repo }));
            toast(r.output ? r.output.split('\n').slice(-2).join(' ') : `${label} : OK`, 'ok', 5000);
            renderStatus(r.status);
          } catch (err) { toastError(err); }
        } });
        return b;
      };
      const head = h('div', { class: 'card card-pad stack' },
        h('div', { class: 'row' }, icon('branch', { size: 20 }),
          h('strong', { class: 'ellipsis' }, st.detached ? 'HEAD détachée' : st.branch || '?'),
          st.upstream ? h('span', { class: 'dim ellipsis' }, `→ ${st.upstream}`) : badge('pas d\'amont', 'warn'),
          st.ahead ? badge(`↑ ${st.ahead}`, 'accent') : null, st.behind ? badge(`↓ ${st.behind}`, 'warn') : null,
          st.initial ? badge('aucun commit', 'warn') : null),
        st.remotes.length ? h('div', { class: 'row wrap' }, remoteBtn('fetch', 'Fetch', 'refresh'), remoteBtn('pull', 'Pull (ff-only)', 'download'), remoteBtn('push', 'Push', 'upload')) : null);

      const conflicts = st.files.filter((f) => f.conflict);
      const staged = st.files.filter((f) => f.staged);
      const unstaged = st.files.filter((f) => f.unstaged);
      const untracked = st.files.filter((f) => f.untracked);

      const section = (title, files, kind) => (files.length ? [
        h('h2', { class: 'section-title' }, title, badge(String(files.length)),
          kind === 'unstaged' || kind === 'untracked' ? button({ label: 'Tout indexer', variant: 'ghost', onClick: () => stage(files.map((f) => f.path)) }) : null,
          kind === 'staged' ? button({ label: 'Tout retirer', variant: 'ghost', onClick: () => unstage(files.map((f) => f.path)) }) : null),
        h('ul', { class: 'list' }, files.map((f) => h('li', null, fileRow(f, kind)))),
      ] : null);

      const msg = textarea({ rows: 3, placeholder: 'Message de commit', class: 'textarea commit-msg' });
      const msgField = field({ label: 'Message de commit', control: msg });
      const commitBtn = button({ label: `Commit (${staged.length})`, icon: 'commit', variant: 'primary', disabled: !staged.length });
      commitBtn.addEventListener('click', async () => {
        if (!msg.value.trim()) { msgField.setError('Écrivez un message'); msg.focus(); return; }
        try {
          const r = await busy(commitBtn, () => post(api('commit'), { repo, message: msg.value }));
          toast(`Commit ${r.short} créé`, 'ok');
          renderStatus(r.status);
        } catch (err) { msgField.setError(err.message); }
      });
      msg.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') commitBtn.click(); });

      replace(content, head,
        !st.files.length ? emptyState({ icon: 'check', title: 'Arbre de travail propre', text: 'Aucune modification.' }) : null,
        section('Conflits', conflicts, 'conflict'),
        section('Indexés', staged, 'staged'),
        section('Modifiés', unstaged, 'unstaged'),
        section('Non suivis', untracked, 'untracked'),
        staged.length || st.files.length ? h('div', { class: 'card card-pad stack commit-box' }, msgField, h('div', { class: 'row' }, h('span', { class: 'grow dim' }, 'Ctrl+Entrée pour valider'), commitBtn)) : null);
    }

    function fileRow(f, kind) {
      const letter = kind === 'staged' ? f.x : kind === 'untracked' ? '?' : kind === 'conflict' ? 'U' : f.y;
      const label = STATUS_LABEL[letter] || letter;
      const kindBadge = { A: 'ok', '?': 'ok', D: 'danger', U: 'danger' }[letter] || 'accent';
      return h('div', { class: 'list-item file-row' },
        h('button', { type: 'button', class: 'file-open', onclick: () => showDiff(f, kind) },
          h('span', { class: 'grow' }, h('span', { class: 'file-name mono ellipsis' }, f.path),
            f.orig ? h('span', { class: 'file-meta' }, `depuis ${f.orig}`) : null),
          badge(label, kindBadge)),
        kind === 'staged'
          ? button({ label: `Retirer ${f.path} de l'index`, icon: 'arrowDown', iconOnly: true, variant: 'ghost', onClick: () => unstage([f.path]) })
          : button({ label: `Indexer ${f.path}`, icon: 'plus', iconOnly: true, variant: 'ghost', onClick: () => stage([f.path]) }));
    }

    async function stage(paths) {
      try { renderStatus(await post(api('stage'), { repo, paths })); } catch (err) { toastError(err); }
    }
    async function unstage(paths) {
      try { renderStatus(await post(api('unstage'), { repo, paths })); } catch (err) { toastError(err); }
    }

    async function showDiff(f, kind) {
      const body = h('div', null, loadingState('git diff…'));
      openDialog({ title: f.path, body, wide: true });
      try {
        const d = await get(`${api('diff')}?${qs({ repo, path: f.path, staged: kind === 'staged' ? 1 : undefined, untracked: kind === 'untracked' ? 1 : undefined })}`);
        replace(body, renderDiff(d.text, d.truncated));
      } catch (err) { replace(body, errorState(err)); }
    }

    // ---------- Branches ----------
    async function renderBranches() {
      replace(content, loadingState('Branches…'));
      let br;
      try { br = await get(`${api('branches')}?${qs({ repo })}`); } catch (err) { return replace(content, errorState(err, renderBranches)); }
      const localNames = new Set(br.local.map((b) => b.name));
      const row = (b, remote) => h('li', null, h('div', { class: 'list-item' },
        icon('branch', { size: 20 }),
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('strong', { class: 'mono ellipsis' }, b.name), b.current ? badge('actuelle', 'ok') : null),
          h('div', { class: 'file-meta ellipsis' }, `${b.sha} · ${b.subject || ''}${b.date ? ` · ${formatDate(b.date * 1000)}` : ''}`)),
        b.current ? null : button({
          label: remote ? 'Suivre' : 'Basculer', variant: remote ? undefined : 'primary',
          disabled: remote && localNames.has(b.name.replace(/^[^/]+\//, '')),
          onClick: () => checkout(b.name, remote),
        })));
      replace(content,
        h('div', { class: 'toolbar' }, button({ label: 'Nouvelle branche', icon: 'plus', onClick: newBranch })),
        h('h2', { class: 'section-title' }, 'Locales', badge(String(br.local.length))),
        h('ul', { class: 'list' }, br.local.map((b) => row(b, false))),
        br.remote.length ? [h('h2', { class: 'section-title' }, 'Distantes', badge(String(br.remote.length))), h('ul', { class: 'list' }, br.remote.map((b) => row(b, true)))] : null);
    }

    async function checkout(name, remote) {
      const ok = await confirmDialog({
        title: remote ? 'Suivre la branche distante ?' : 'Changer de branche ?',
        message: remote ? `Créer une branche locale qui suit ${name} et basculer dessus.` : `Basculer sur ${name}. Les modifications non commitées incompatibles bloqueront l'opération.`,
        confirmLabel: 'Basculer',
      });
      if (!ok) return;
      try {
        await post(api('checkout'), { repo, branch: name, remote });
        toast(`Sur ${name}`, 'ok');
        renderBranches();
      } catch (err) { toastError(err); }
    }

    async function newBranch() {
      const name = await promptDialog({ title: 'Nouvelle branche', label: 'Nom', hint: 'Créée depuis HEAD, puis activée.', validate: (v) => (/^[A-Za-z0-9._/+-]+$/.test(v) && !v.startsWith('-') && !v.includes('..') ? null : 'Nom de branche invalide') });
      if (!name) return;
      try { await post(api('checkout'), { repo, branch: name, create: true }); toast(`Branche ${name} créée`, 'ok'); renderBranches(); } catch (err) { toastError(err); }
    }

    // ---------- Historique ----------
    async function renderLog() {
      replace(content, loadingState('git log…'));
      const ul = h('ul', { class: 'list' });
      let skip = 0;
      const more = button({ label: 'Plus anciens', icon: 'chevronDown', block: true });
      const loadPage = async () => {
        const r = await get(`${api('log')}?${qs({ repo, skip, limit: 40 })}`);
        skip += r.commits.length;
        for (const cm of r.commits) {
          ul.appendChild(h('li', null, h('button', { type: 'button', class: 'list-item clickable list-button', onclick: () => showCommit(cm) },
            icon('commit', { size: 20 }),
            h('span', { class: 'grow' },
              h('span', { class: 'file-name ellipsis' }, cm.subject),
              h('span', { class: 'file-meta ellipsis' }, `${cm.short} · ${cm.author} · ${formatDate(cm.date * 1000)}`)),
            cm.refs.length ? badge(cm.refs[0].replace('HEAD -> ', ''), 'accent') : null)));
        }
        more.hidden = !r.more;
        return r;
      };
      try {
        const first = await loadPage();
        if (!first.commits.length) return replace(content, emptyState({ icon: 'history', title: 'Aucun commit' }));
        replace(content, ul, more);
        more.addEventListener('click', () => busy(more, loadPage).catch(toastError));
      } catch (err) { replace(content, errorState(err, renderLog)); }
    }

    async function showCommit(cm) {
      const body = h('div', null, loadingState('git show…'));
      openDialog({ title: `${cm.short} — ${cm.subject}`, body, wide: true });
      try {
        const d = await get(`${api('show')}?${qs({ repo, sha: cm.sha })}`);
        replace(body, renderDiff(d.text, d.truncated));
      } catch (err) { replace(body, errorState(err)); }
    }

    renderRepos();
    return () => picker.destroy();
  },
};
