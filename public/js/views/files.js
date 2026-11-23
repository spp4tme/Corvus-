// Vue Fichiers (SFTP) : navigation, upload/download, dossier, renommer, supprimer,
// éditeur texte (≤ 2 Mo), aperçu images/texte.
import { get, post, put, upload, qs } from '../api.js';
import { h, clear, replace, prefs, formatBytes, formatDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import {
  button, busy, openDialog, confirmDialog, promptDialog, toast, toastError,
  loadingState, emptyState, errorState, textarea, checkbox,
} from '../ui/components.js';
import { hostPicker } from '../ui/hostpicker.js';
import { state } from '../state.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i;
const TEXT_LIMIT = 2 * 1024 * 1024;

export default {
  mount(el) {
    let hostId = state.activeHostId;
    let current = null; // { path, home, entries }
    let showHidden = prefs.get('fsHidden', false);

    const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Chemin' });
    const list = h('div', { class: 'file-list' });
    const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
    const progress = h('div', { class: 'stack' });
    const hiddenToggle = checkbox('Fichiers cachés', { checked: showHidden });
    hiddenToggle.input.addEventListener('change', () => { showHidden = hiddenToggle.input.checked; prefs.set('fsHidden', showHidden); renderList(); });

    const picker = hostPicker((id) => { hostId = id; load(prefs.get(`fsPath.${id}`, '~')); });
    const actions = h('div', { class: 'toolbar' },
      button({ label: 'Envoyer', icon: 'upload', variant: 'primary', onClick: () => fileInput.click() }),
      button({ label: 'Nouveau dossier', icon: 'folderPlus', onClick: newFolder }),
      button({ label: 'Rafraîchir', icon: 'refresh', iconOnly: true, onClick: () => load(current?.path) }),
      hiddenToggle,
      fileInput);
    const body = h('div', { class: 'stack' }, crumbs, actions, progress, list);
    el.append(h('div', { class: 'toolbar' }, picker), body);

    fileInput.addEventListener('change', () => { sendFiles([...fileInput.files]); fileInput.value = ''; });
    // Glisser-déposer (desktop)
    list.addEventListener('dragover', (e) => { if (current) { e.preventDefault(); list.classList.add('drop'); } });
    list.addEventListener('dragleave', () => list.classList.remove('drop'));
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      list.classList.remove('drop');
      if (e.dataTransfer?.files?.length) sendFiles([...e.dataTransfer.files]);
    });

    const url = (action, params) => `/api/hosts/${hostId}/fs/${action}?${qs(params)}`;
    const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

    async function load(path = '~') {
      if (!hostId) {
        body.hidden = true;
        replace(list);
        el.querySelector('.fs-empty')?.remove();
        el.appendChild(h('div', { class: 'fs-empty' }, emptyState({ icon: 'folder', title: 'Choisissez un hôte', text: 'Sélectionnez une machine pour parcourir ses fichiers.' })));
        return;
      }
      el.querySelector('.fs-empty')?.remove();
      body.hidden = false;
      replace(list, loadingState('Lecture du dossier…'));
      try {
        current = await get(url('list', { path }));
        prefs.set(`fsPath.${hostId}`, current.path);
        renderCrumbs();
        renderList();
      } catch (err) {
        if (err.status === 404 && path !== '~') { toast(`${path} introuvable — retour au dossier personnel`, 'warn'); return load('~'); }
        replace(list, errorState(err, () => load(path)));
      }
    }

    function renderCrumbs() {
      clear(crumbs);
      const parts = current.path.split('/').filter(Boolean);
      const items = [{ label: '/', path: '/' }];
      parts.forEach((p, i) => items.push({ label: p, path: `/${parts.slice(0, i + 1).join('/')}` }));
      crumbs.appendChild(button({ label: 'Dossier personnel', icon: 'server', iconOnly: true, variant: 'ghost', onClick: () => load(current.home) }));
      items.forEach((it, i) => {
        if (i > 1) crumbs.appendChild(h('span', { class: 'faint', 'aria-hidden': 'true' }, '/'));
        const last = i === items.length - 1;
        crumbs.appendChild(h('button', {
          type: 'button', class: 'crumb', 'aria-current': last ? 'location' : undefined,
          onclick: () => !last && load(it.path),
        }, it.label));
      });
      crumbs.lastElementChild?.scrollIntoView?.({ inline: 'end', block: 'nearest' });
    }

    function renderList() {
      if (!current) return;
      const entries = current.entries.filter((e) => showHidden || !e.hidden);
      const rows = [];
      if (current.path !== '/') {
        const parent = current.path.replace(/\/[^/]+$/, '') || '/';
        rows.push(h('li', null, h('button', { type: 'button', class: 'list-item clickable list-button', onclick: () => load(parent) },
          h('span', { class: 'file-icon' }, icon('arrowUp')), h('span', { class: 'grow' }, '..'))));
      }
      for (const e of entries) rows.push(h('li', null, row(e)));
      if (!entries.length) {
        replace(list, h('ul', { class: 'list' }, rows), emptyState({ icon: 'folder', title: 'Dossier vide', text: 'Envoyez un fichier ou créez un dossier.' }));
        return;
      }
      replace(list, h('ul', { class: 'list' }, rows), current.truncated ? h('p', { class: 'dim' }, 'Liste tronquée à 5000 éléments.') : null);
    }

    function row(e) {
      const isDir = e.type === 'dir' || e.target === 'dir';
      const ic = isDir ? 'folder' : IMAGE_EXT.test(e.name) ? 'image' : e.type === 'link' ? 'link' : 'file';
      const open = h('button', { type: 'button', class: 'file-open', onclick: () => (isDir ? load(join(current.path, e.name)) : openFile(e)) },
        h('span', { class: `file-icon${isDir ? ' is-dir' : ''}` }, icon(ic)),
        h('span', { class: 'grow' },
          h('span', { class: 'file-name ellipsis' }, e.name, e.type === 'link' ? h('span', { class: 'faint' }, ' →') : null),
          h('span', { class: 'file-meta' }, isDir ? formatDate(e.mtime * 1000) : `${formatBytes(e.size)} · ${formatDate(e.mtime * 1000)}`)));
      return h('div', { class: 'list-item file-row' }, open,
        button({ label: `Actions pour ${e.name}`, icon: 'more', iconOnly: true, variant: 'ghost', onClick: () => itemMenu(e, isDir) }));
    }

    function itemMenu(e, isDir) {
      const p = join(current.path, e.name);
      const d = openDialog({
        title: e.name,
        body: h('div', { class: 'list' },
          !isDir ? menuItem('download', 'Télécharger', () => { d.close(); download(p); }) : null,
          !isDir ? menuItem('edit', 'Ouvrir dans l\'éditeur', () => { d.close(); openEditor(p); }) : null,
          menuItem('edit', 'Renommer / déplacer', () => { d.close(); rename(e); }),
          menuItem('copy', 'Copier le chemin', async () => {
            d.close();
            try { await navigator.clipboard.writeText(p); toast('Chemin copié', 'ok', 1500); } catch { toast(p, 'info', 8000); }
          }),
          menuItem('trash', 'Supprimer', () => { d.close(); remove(e, isDir); }, true)),
      });
    }

    function menuItem(ic, label, onClick, danger = false) {
      return h('button', { type: 'button', class: `list-item clickable list-button${danger ? ' danger-text' : ''}`, onclick: onClick }, icon(ic, { size: 20 }), h('span', null, label));
    }

    function openFile(e) {
      const p = join(current.path, e.name);
      if (IMAGE_EXT.test(e.name)) return previewImage(p, e.name);
      if (e.size > TEXT_LIMIT) {
        return confirmDialog({ title: e.name, message: `Fichier de ${formatBytes(e.size)} : trop gros pour l'éditeur (2 Mo max). Le télécharger ?`, confirmLabel: 'Télécharger' })
          .then((ok) => ok && download(p));
      }
      return openEditor(p);
    }

    function download(p) {
      const a = h('a', { href: url('download', { path: p }), download: '', hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    function previewImage(p, name) {
      const img = h('img', { class: 'preview-img', alt: name, src: url('preview', { path: p }) });
      img.addEventListener('error', () => replace(img.parentNode, errorState(new Error('Aperçu impossible (fichier trop gros ou illisible).'))));
      openDialog({
        title: name, wide: true, body: h('div', { class: 'preview' }, img),
        actions: [button({ label: 'Télécharger', icon: 'download', onClick: () => download(p) })],
      });
    }

    async function openEditor(p) {
      const area = textarea({ class: 'textarea editor', 'aria-label': `Contenu de ${p}`, wrap: 'off' });
      const status = h('span', { class: 'dim' });
      const saveBtn = button({ label: 'Enregistrer', icon: 'save', variant: 'primary', disabled: true });
      const d = openDialog({
        title: p.split('/').pop(), wide: true,
        body: h('div', { class: 'editor-wrap' }, loadingState('Ouverture…')),
        actions: [status, h('span', { class: 'grow' }), button({ label: 'Télécharger', icon: 'download', onClick: () => download(p) }), saveBtn],
      });
      let file;
      try {
        file = await get(url('read', { path: p }));
      } catch (err) {
        replace(d.body, errorState(err));
        return;
      }
      area.value = file.content;
      replace(d.body, h('div', { class: 'editor-wrap' }, area));
      status.textContent = `${formatBytes(file.size)} · enregistré`;
      let dirty = false;
      area.addEventListener('input', () => {
        if (!dirty) { dirty = true; saveBtn.disabled = false; status.textContent = 'Modifications non enregistrées'; }
      });
      area.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey) {
          e.preventDefault();
          area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
          area.dispatchEvent(new Event('input'));
        }
      });
      saveBtn.addEventListener('click', save);
      async function save() {
        if (!dirty) return;
        try {
          const r = await busy(saveBtn, () => put(`/api/hosts/${hostId}/fs/write`, { path: p, content: area.value, expectedMtime: file.mtime }));
          file.mtime = r.mtime;
          dirty = false;
          saveBtn.disabled = true;
          status.textContent = `${formatBytes(r.size)} · enregistré`;
          toast('Fichier enregistré', 'ok', 1500);
          load(current.path);
        } catch (err) {
          if (err.code === 'CONFLICT') {
            const overwrite = await confirmDialog({ title: 'Conflit', message: `${err.message} Écraser quand même la version du serveur ?`, confirmLabel: 'Écraser', danger: true });
            if (overwrite) { file.mtime = undefined; save(); }
          } else toastError(err);
        }
      }
      setTimeout(() => area.focus(), 30);
    }

    async function newFolder() {
      const name = await promptDialog({ title: 'Nouveau dossier', label: 'Nom du dossier', validate: (v) => (/[/\n]/.test(v) || v === '.' || v === '..' ? 'Nom invalide' : null) });
      if (!name) return;
      try { await post(`/api/hosts/${hostId}/fs/mkdir`, { path: join(current.path, name) }); load(current.path); } catch (err) { toastError(err); }
    }

    async function rename(e) {
      const from = join(current.path, e.name);
      const to = await promptDialog({ title: 'Renommer / déplacer', label: 'Nouveau nom ou chemin complet', value: e.name, hint: 'Un nom simple renomme dans ce dossier ; un chemin commençant par / ou ~ déplace.' });
      if (!to || to === e.name) return;
      const target = to.startsWith('/') || to.startsWith('~') ? to : join(current.path, to);
      try { await post(`/api/hosts/${hostId}/fs/rename`, { from, to: target }); load(current.path); } catch (err) { toastError(err); }
    }

    async function remove(e, isDir) {
      const ok = await confirmDialog({
        title: `Supprimer ${isDir ? 'le dossier' : 'le fichier'} ?`,
        message: isDir ? `« ${e.name} » et TOUT son contenu seront supprimés définitivement.` : `« ${e.name} » sera supprimé définitivement.`,
        confirmLabel: 'Supprimer', danger: true,
      });
      if (!ok) return;
      try {
        const r = await post(`/api/hosts/${hostId}/fs/delete`, { path: join(current.path, e.name) });
        toast(r.deleted > 1 ? `${r.deleted} éléments supprimés` : 'Supprimé', 'ok');
        load(current.path);
      } catch (err) { toastError(err); }
    }

    async function sendFiles(files) {
      if (!current) return;
      const dir = current.path;
      for (const f of files) {
        const bar = h('progress', { max: '1', value: '0', 'aria-label': `Envoi de ${f.name}` });
        const line = h('div', { class: 'upload-line' }, h('span', { class: 'ellipsis grow' }, f.name), bar);
        progress.appendChild(line);
        const send = (overwrite) => upload(url('upload', { dir, name: f.name, overwrite: overwrite ? 1 : undefined }), f, (x) => { bar.value = x; });
        try {
          try {
            await send(false);
          } catch (err) {
            if (err.code !== 'EXISTS') throw err;
            const ok = await confirmDialog({ title: 'Fichier existant', message: `« ${f.name} » existe déjà. L'écraser ?`, confirmLabel: 'Écraser', danger: true });
            if (!ok) { line.remove(); continue; }
            await send(true);
          }
          toast(`${f.name} envoyé`, 'ok', 2000);
        } catch (err) {
          toastError(err);
        } finally {
          line.remove();
        }
      }
      if (current?.path === dir) load(dir);
    }

    load(hostId ? prefs.get(`fsPath.${hostId}`, '~') : undefined);
    return () => picker.destroy();
  },
};
