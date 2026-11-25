// Réglages → Stockage et sauvegardes : espace disque, sauvegarde chiffrée en un bouton,
// restauration (depuis la liste ou depuis un fichier), redémarrage.
import { get, post, del, upload } from '../api.js';
import { h, replace, formatBytes, formatDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import {
  button, busy, field, input, openDialog, confirmDialog, toast, toastError, loadingState, errorState, badge,
} from '../ui/components.js';

const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function passwordDialog({ title, confirmLabel, twice }) {
  const p1 = input({ type: 'password', autocomplete: 'new-password' });
  const p2 = input({ type: 'password', autocomplete: 'new-password' });
  const f1 = field({ label: 'Mot de passe de la sauvegarde', control: p1, hint: '10 caractères minimum. Sans lui, la sauvegarde est illisible : conservez-le à part.' });
  const f2 = field({ label: 'Confirmer le mot de passe', control: p2 });
  const form = h('form', { class: 'stack', novalidate: true }, f1, twice ? f2 : null);
  const submit = () => {
    f1.setError(p1.value.length < 10 ? '10 caractères minimum' : null);
    if (twice) f2.setError(p1.value !== p2.value ? 'Les deux mots de passe diffèrent' : null);
    if (p1.value.length < 10 || (twice && p1.value !== p2.value)) return;
    d.close(p1.value);
  };
  const d = openDialog({
    title, body: form,
    actions: [button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close(null) }), button({ label: confirmLabel, variant: 'primary', onClick: submit })],
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  setTimeout(() => p1.focus(), 30);
  return d.closed;
}

export function renderStorageSettings(slot) {
  const box = h('div', { class: 'card card-pad stack' }, loadingState());
  replace(slot, h('h2', { class: 'section-title' }, 'Stockage et sauvegardes'), box);

  async function restartPrompt() {
    const ok = await confirmDialog({
      title: 'Restauration prête',
      message: 'La sauvegarde a été vérifiée. Elle sera appliquée au redémarrage de Corvus (l\'état actuel est conservé dans un dossier « pre-restore »). Redémarrer maintenant ?',
      confirmLabel: 'Redémarrer', danger: true,
    });
    if (!ok) return;
    try {
      await post('/api/system/restart');
      toast('Redémarrage… la page va se recharger.', 'ok', 8000);
      setTimeout(() => location.reload(), 6000);
    } catch (err) { toastError(err); }
  }

  async function load() {
    let st;
    let list;
    try {
      [st, list] = await Promise.all([get('/api/system/status'), get('/api/backups')]);
    } catch (err) {
      if (err.status === 403) return replace(box, h('p', { class: 'dim' }, 'Réservé aux administrateurs.'));
      return replace(box, errorState(err, load));
    }
    const s = st.storage;
    const spaceRows = s.space.map((d) => h('div', { class: 'row wrap' },
      h('span', { class: 'grow' }, h('strong', null, d.label), h('br'), h('span', { class: 'mono dim', style: 'overflow-wrap: anywhere' }, d.dir)),
      d.error ? badge('illisible', 'danger') : badge(`${formatBytes(d.free)} libres / ${formatBytes(d.total)}`, d.low ? 'danger' : 'ok')));

    const createBtn = button({ label: 'Créer une sauvegarde', icon: 'save', variant: 'primary' });
    createBtn.addEventListener('click', async () => {
      const pw = await passwordDialog({ title: 'Nouvelle sauvegarde chiffrée', confirmLabel: 'Créer', twice: true });
      if (!pw) return;
      try {
        const r = await busy(createBtn, () => post('/api/backups', { password: pw }));
        toast(`Sauvegarde créée (${formatBytes(r.backup.size)})`, 'ok');
        load();
      } catch (err) { toastError(err); }
    });

    const fileInput = h('input', { type: 'file', accept: '.cvbk', hidden: true });
    const fromFile = button({ label: 'Restaurer un fichier…', icon: 'upload', onClick: () => fileInput.click() });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      const pw = await passwordDialog({ title: `Restaurer ${f.name}`, confirmLabel: 'Vérifier et préparer' });
      if (!pw) return;
      try {
        await busy(fromFile, () => upload('/api/backups/restore', f, null, { 'X-Backup-Password': b64url(pw) }));
        restartPrompt();
      } catch (err) { toastError(err); }
    });

    const rows = list.backups.map((b) => {
      const restoreBtn = button({ label: `Restaurer ${b.name}`, icon: 'history', iconOnly: true, variant: 'ghost' });
      restoreBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Restaurer cette sauvegarde ?', message: `Tout Corvus (hôtes, comptes, journal, enregistrements) reviendra à l'état du ${formatDate(b.createdAt)}.`, confirmLabel: 'Continuer', danger: true });
        if (!ok) return;
        const pw = await passwordDialog({ title: 'Mot de passe de la sauvegarde', confirmLabel: 'Vérifier et préparer' });
        if (!pw) return;
        try { await busy(restoreBtn, () => post(`/api/backups/${b.name}/restore`, { password: pw })); restartPrompt(); } catch (err) { toastError(err); }
      });
      return h('li', { class: 'list-item' },
        h('span', { class: 'grow' }, h('span', { class: 'mono' }, b.name), h('br'), h('span', { class: 'dim' }, `${formatBytes(b.size)} · ${formatDate(b.createdAt)}`)),
        h('a', { class: 'btn btn-ghost btn-icon', href: `/api/backups/${b.name}/download`, download: b.name, 'aria-label': `Télécharger ${b.name}`, title: 'Télécharger' }, icon('download')),
        restoreBtn,
        button({
          label: `Supprimer ${b.name}`, icon: 'trash', iconOnly: true, variant: 'ghost',
          onClick: async () => {
            if (!await confirmDialog({ title: 'Supprimer la sauvegarde ?', message: b.name, confirmLabel: 'Supprimer', danger: true })) return;
            try { await del(`/api/backups/${b.name}`); load(); } catch (err) { toastError(err); }
          },
        }));
    });

    replace(box,
      s.low ? h('div', { class: 'test-result ko', role: 'alert' }, 'Espace disque faible : libérez de la place, ou déplacez le stockage sur un SSD (variable CORVUS_STORAGE, voir README).') : null,
      ...spaceRows,
      h('p', { class: 'dim' }, `Base : ${formatBytes(s.db)} · enregistrements et sauvegardes de fichiers : ${s.blobs.count} élément(s), ${formatBytes(s.blobs.stored)} sur disque${s.custom ? '' : ' · stockage sur le même disque que la configuration (CORVUS_STORAGE non défini)'}.`),
      h('div', { class: 'row wrap' }, createBtn, fromFile, fileInput),
      list.backups.length ? h('ul', { class: 'list' }, rows) : h('p', { class: 'dim' }, 'Aucune sauvegarde pour l\'instant.'),
      h('p', { class: 'dim' }, `Les sauvegardes contiennent la base, les enregistrements et le token d'amorçage, chiffrés par le mot de passe choisi. Si une passphrase maître (CORVUS_MASTER_PASSPHRASE) est utilisée, elle sera aussi nécessaire après restauration.`));
  }
  load();
}
