// Mode « annulable » : avant une commande jugée risquée, les fichiers qu'elle va toucher sont
// copiés (blobs chiffrés) ; « Annuler la dernière commande » les remet exactement en place.
//
// Limites (affichées dans l'interface) : seuls les fichiers déductibles des arguments sont
// sauvegardés (pas ceux qu'un script modifie en douce) ; fichiers lisibles par le compte SSH
// seulement (pas de sudo) ; 200 Mo / 2 000 fichiers au plus ; effets réseau, services, bases de
// données et processus ne sont jamais annulables.
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { analyze } from './risk.js';
import { q } from './shell.js';
import { HttpError } from './validate.js';

const P = path.posix;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 2000;
const S_IFMT = 0o170000;
const TYPES = { 0o040000: 'dir', 0o120000: 'link', 0o100000: 'file' };

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
});

/** Chemin tapé par l'utilisateur → mot shell : jokers (* ? […]) actifs, tout le reste cité. */
export function globWord(p) {
  let out = '';
  let rest = p;
  if (rest === '~' || rest.startsWith('~/')) { out = '"$HOME"'; rest = rest.slice(1); }
  for (const part of rest.split(/(\*|\?|\[[^\]/]*\])/)) {
    if (!part) continue;
    out += /^(\*|\?|\[[^\]/]*\])$/.test(part) ? part : q(part);
  }
  return out || "''";
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

export class UndoService {
  constructor({ db, pool, blobs, journal, hosts }) {
    Object.assign(this, { db, pool, blobs, journal, hosts });
  }

  /** Chemins absolus visés (jokers développés par le shell distant, sans aucune substitution). */
  async resolve(hostId, files, cwd) {
    const list = files.map(globWord).join(' ');
    const script = `cd -- ${cwd ? globWord(cwd) : '"$HOME"'} 2>/dev/null || exit 3
for f in ${list}; do
  if [ -e "$f" ] || [ -L "$f" ]; then d=$(cd -- "$(dirname -- "$f")" 2>/dev/null && pwd -P) && printf 'E%s/%s\\0' "$d" "$(basename -- "$f")"
  else case "$f" in *'*'*|*'?'*|*'['*) ;; *)
    if d=$(cd -- "$(dirname -- "$f")" 2>/dev/null && pwd -P); then printf 'N%s/%s\\0' "$d" "$(basename -- "$f")"
    else case "$f" in /*) printf 'N%s\\0' "$f" ;; *) printf 'N%s/%s\\0' "$(pwd -P)" "$f" ;; esac; fi ;; esac; fi
done`;
    const r = await this.pool.exec(hostId, script, { timeoutMs: 15_000, maxBytes: 1024 * 1024 });
    if (r.code === 3) throw new HttpError(404, 'NOT_FOUND', `Dossier courant introuvable : ${cwd}`);
    return [...new Set(r.stdout.toString('utf8').split('\0').filter(Boolean))].map((x) => ({ path: P.normalize(x.slice(1)), existed: x[0] === 'E' }));
  }

  async snapshot(sftp, target, out, budget) {
    const st = await call(sftp, 'lstat', target);
    const type = TYPES[st.mode & S_IFMT] || 'other';
    const base = { path: target, existed: true, type, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, mtime: st.mtime };
    if (++budget.files > MAX_FILES) throw new HttpError(413, 'TOO_MANY', `Plus de ${MAX_FILES} fichiers : annulation impossible, utilisez la prévisualisation`);
    if (type === 'link') { out.push({ ...base, target: await call(sftp, 'readlink', target) }); return; }
    if (type === 'dir') {
      out.push(base);
      for (const it of await call(sftp, 'readdir', target)) {
        if (it.filename === '.' || it.filename === '..') continue;
        await this.snapshot(sftp, P.join(target, it.filename), out, budget);
      }
      return;
    }
    if (type !== 'file') throw new HttpError(400, 'UNSUPPORTED', `Type de fichier non sauvegardable : ${target}`);
    budget.bytes += st.size;
    if (budget.bytes > MAX_BYTES) throw new HttpError(413, 'TOO_LARGE', 'Plus de 200 Mo à sauvegarder : annulation impossible, utilisez la prévisualisation');
    const buf = await readAll(sftp.createReadStream(target));
    out.push({ ...base, sha: this.blobs.put(buf, 'undo'), size: buf.length });
  }

  /** Sauvegarde avant exécution. Retourne l'analyse et, si possible, l'opération d'annulation. */
  async prepare(hostId, command, { cwd, user } = {}) {
    const analysis = analyze(command);
    if (!analysis.undoable) return { analysis, op: null };
    const targets = await this.resolve(hostId, analysis.files, cwd);
    const sftp = await this.pool.sftp(hostId);
    const files = [];
    const budget = { files: 0, bytes: 0 };
    try {
      for (const t of targets) {
        if (!t.existed) { files.push({ path: t.path, existed: false }); continue; }
        try {
          await this.snapshot(sftp, t.path, files, budget);
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(403, 'UNREADABLE', `Sauvegarde impossible de ${t.path} (${err.code === 3 ? 'permission refusée : fichier root ? la prévisualisation via l\'agent le permettra' : err.message})`);
        }
      }
    } catch (err) {
      for (const f of files) if (f.sha) this.blobs.release(f.sha);
      throw err;
    }
    const op = { id: crypto.randomBytes(8).toString('hex'), hostId, ts: Date.now(), command: String(command).slice(0, 2000), files };
    this.db.run('INSERT INTO undo_ops (id, host_id, user_id, ts, command, files) VALUES (?, ?, ?, ?, ?, ?)',
      op.id, hostId, user?.id ?? null, op.ts, op.command, JSON.stringify(files));
    this.journal.add({ type: 'undo', event: 'prepare', host: this.hosts.find(hostId), detail: `${files.length} élément(s) sauvegardé(s) avant : ${op.command}` });
    return { analysis, op: { id: op.id, ts: op.ts, command: op.command, files: files.length, bytes: budget.bytes } };
  }

  list(hostId, userId) {
    return this.db.all(`SELECT id, ts, command, files, state, undone_at FROM undo_ops WHERE host_id = ? ${userId ? 'AND user_id = ?' : ''} ORDER BY ts DESC LIMIT 20`,
      ...(userId ? [hostId, userId] : [hostId])).map((r) => ({ id: r.id, ts: r.ts, command: r.command, files: JSON.parse(r.files).map((f) => ({ path: f.path, existed: f.existed, type: f.type })), state: r.state, undoneAt: r.undone_at }));
  }

  /** Remet les fichiers dans l'état d'avant la commande. */
  async restore(hostId, opId, { user } = {}) {
    const row = this.db.get('SELECT * FROM undo_ops WHERE id = ? AND host_id = ?', opId, hostId);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Opération introuvable (expirée ?)');
    if (user && user.role !== 'admin' && row.user_id && row.user_id !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Cette annulation appartient à un autre compte');
    if (row.state !== 'ready') throw new HttpError(409, 'ALREADY_DONE', 'Déjà annulée');
    const files = JSON.parse(row.files);
    const sftp = await this.pool.sftp(hostId);
    const report = { restored: 0, removed: 0, errors: [] };
    const exists = (p) => call(sftp, 'lstat', p).then((s) => s, () => null);
    // 1. Ce qui n'existait pas avant (créé par la commande) : supprimé (fichiers et liens seulement).
    for (const f of files.filter((x) => !x.existed)) {
      const st = await exists(f.path);
      if (!st) continue;
      if (TYPES[st.mode & S_IFMT] === 'dir') { report.errors.push(`${f.path} : dossier créé par la commande, laissé en place`); continue; }
      try { await call(sftp, 'unlink', f.path); report.removed++; } catch (err) { report.errors.push(`${f.path} : ${err.message}`); }
    }
    // 2. Dossiers (du plus court au plus long), puis fichiers et liens.
    const ordered = files.filter((x) => x.existed).sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.path.length - b.path.length);
    for (const f of ordered) {
      try {
        const cur = await exists(f.path);
        if (f.type === 'dir') {
          if (!cur) await call(sftp, 'mkdir', f.path);
          await call(sftp, 'chmod', f.path, f.mode).catch(() => {});
        } else if (f.type === 'link') {
          if (cur) await call(sftp, 'unlink', f.path);
          await call(sftp, 'symlink', f.target, f.path);
        } else {
          // Écriture dans un fichier voisin puis renommage : jamais de fichier à moitié restauré.
          const tmp = `${f.path}.corvus-undo-${crypto.randomBytes(3).toString('hex')}`;
          await pipeline(Readable.from([this.blobs.get(f.sha)]), sftp.createWriteStream(tmp, { flags: 'w', mode: f.mode }));
          await call(sftp, 'chmod', tmp, f.mode).catch(() => {});
          try { await call(sftp, 'ext_openssh_rename', tmp, f.path); } catch {
            if (await exists(f.path)) await call(sftp, 'unlink', f.path);
            await call(sftp, 'rename', tmp, f.path);
          }
          await call(sftp, 'utimes', f.path, f.mtime, f.mtime).catch(() => {});
        }
        await call(sftp, 'chown', f.path, f.uid, f.gid).catch(() => {}); // possible seulement en root
        report.restored++;
      } catch (err) {
        report.errors.push(`${f.path} : ${err.message}`);
      }
    }
    const ok = report.errors.length === 0;
    this.db.run('UPDATE undo_ops SET state = ?, undone_at = ? WHERE id = ?', ok ? 'undone' : 'failed', Date.now(), opId);
    this.journal.add({ type: 'undo', event: 'restore', ok, host: this.hosts.find(hostId), detail: `${row.command} — ${report.restored} restauré(s), ${report.removed} supprimé(s)${ok ? '' : `, ${report.errors.length} erreur(s)`}` });
    return report;
  }
}
