// Dialogue « Copier vers… » : copie un fichier ou un dossier d'un hôte à un autre, en flux à travers Corvus.
// Progression, annulation, refus d'écraser sans confirmation. Rien n'est copié sans un clic explicite.
import { get, post, del } from '../api.js';
import { h, replace, formatBytes } from '../ui/dom.js';
import { button, openDialog, confirmDialog, select, input, checkbox, field, badge, toastError } from '../ui/components.js';
import { state, sshHosts } from '../state.js';

export function copyDialog({ fromHostId, path, name, isDir, onDone }) {
  const targets = sshHosts().filter((x) => state.canOperate(x.id));
  const hostSel = select(targets.map((x) => ({ value: x.id, label: x.name })), { value: targets.find((x) => x.id !== fromHostId)?.id || targets[0]?.id });
  const dir = input({ value: '~', 'aria-label': 'Dossier de destination', placeholder: '~/dossier' });
  const newName = input({ value: '', 'aria-label': 'Nouveau nom (facultatif)', placeholder: name });
  const over = checkbox('Écraser le fichier s\'il existe déjà', { disabled: isDir });
  const status = h('div', { class: 'stack' });
  let job = null;
  let timer = null;

  const startBtn = button({ label: 'Copier', variant: 'primary', icon: 'copy', onClick: start });
  const cancelBtn = button({ label: 'Annuler la copie', variant: 'danger', onClick: cancel });
  cancelBtn.hidden = true;

  const d = openDialog({
    title: `Copier « ${name} » vers…`,
    body: h('div', { class: 'stack' },
      h('p', { class: 'dim' }, `${isDir ? 'Le dossier' : 'Le fichier'} est lu sur l'hôte actuel puis écrit sur l'hôte choisi, en passant par Corvus. Les liens symboliques ne sont pas copiés.`),
      field({ label: 'Hôte de destination', control: hostSel }),
      field({ label: 'Dossier de destination', control: dir, hint: 'Doit exister.' }),
      field({ label: 'Nom sur la destination', control: newName, hint: 'Vide : même nom.' }),
      isDir ? null : over, status),
    actions: [cancelBtn, h('span', { class: 'grow' }), button({ label: 'Fermer', variant: 'ghost', onClick: () => d.close() }), startBtn],
    onClose: () => { clearTimeout(timer); },
  });

  async function start() {
    const overwrite = !isDir && over.input.checked;
    if (overwrite && !(await confirmDialog({ title: 'Écraser le fichier existant ?', message: 'Si un fichier du même nom existe sur la destination, il sera remplacé.', confirmLabel: 'Écraser', danger: true }))) return;
    startBtn.disabled = true;
    try {
      const r = await post('/api/fs/copy', {
        from: { hostId: fromHostId, path },
        to: { hostId: hostSel.value, dir: dir.value.trim() || '~', ...(newName.value.trim() ? { name: newName.value.trim() } : {}) },
        ...(overwrite ? { overwrite: true, confirm: true } : {}),
      });
      job = r.copy;
      cancelBtn.hidden = false;
      poll();
    } catch (err) { startBtn.disabled = false; toastError(err); }
  }

  async function cancel() {
    if (!job) return;
    try { await del(`/api/fs/copy/${job.id}`); } catch (err) { toastError(err); }
  }

  async function poll() {
    try {
      job = (await get(`/api/fs/copy/${job.id}`)).copy;
    } catch (err) { replace(status, h('p', { class: 'danger-text' }, err.message)); startBtn.disabled = false; return; }
    const pct = job.totalBytes ? Math.min(100, Math.round((job.bytes / job.totalBytes) * 100)) : (job.state === 'done' ? 100 : 0);
    replace(status,
      h('progress', { max: '100', value: String(pct), 'aria-label': 'Progression de la copie' }),
      h('p', { class: 'dim' }, `${formatBytes(job.bytes)} / ${formatBytes(job.totalBytes)} · ${job.files} / ${job.totalFiles} fichier(s)${job.skipped ? ` · ${job.skipped} lien(s) ou fichier(s) spécial(aux) ignoré(s)` : ''}`),
      job.state === 'done' ? badge('Copie terminée', 'ok') : job.state === 'cancelled' ? badge('Copie annulée : rien n\'a été laissé sur la destination', 'warn')
        : job.state === 'failed' ? badge(`Échec : ${job.error}`, 'danger') : null);
    if (job.state === 'running') { timer = setTimeout(poll, 600); return; }
    cancelBtn.hidden = true;
    startBtn.disabled = false;
    if (job.state === 'done') onDone?.(job);
  }
}
