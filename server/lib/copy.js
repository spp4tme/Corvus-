// Copie d'un fichier ou d'un dossier d'un hôte A vers un hôte B, EN FLUX à travers Corvus :
// SFTP lecture (A) → SFTP écriture (B). Aucun shell, aucun fichier ne touche le disque de Corvus.
//
// Garanties :
//   - rien n'est écrasé sans demande explicite (fichier seulement ; un dossier existant n'est jamais fusionné) ;
//   - les liens symboliques ne sont JAMAIS suivis (ni recréés) : ils sont comptés comme « ignorés » ;
//   - écriture atomique : un fichier est écrit sous un nom temporaire puis renommé ; un dossier est construit dans un
//     dossier temporaire puis renommé d'un seul coup. Annulation ou échec : le temporaire est supprimé, rien ne reste ;
//   - tout est borné : taille totale, nombre d'éléments, profondeur, copies simultanées, débit (facultatif).
import crypto from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './validate.js';
import * as v from './validate.js';
import { mapSftpError, typeOf, call, finalizeUpload } from './sftp.js';
import { requestContext } from './context.js';

const P = path.posix;
const MAX_DEPTH = 32;
const PER_USER = 2;
const GLOBAL = 6;
const KEEP_MS = 10 * 60_000;
const rand = () => crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CopyService {
  constructor({ pool, hosts, journal, config, sftp }) {
    Object.assign(this, { pool, hosts, journal, config, sftp });
    this.jobs = new Map();
  }

  #purge() {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.endedAt && now - j.endedAt > KEEP_MS) this.jobs.delete(id);
    if (this.jobs.size > 100) {
      for (const [id, j] of this.jobs) { if (j.endedAt) this.jobs.delete(id); if (this.jobs.size <= 100) break; }
    }
  }

  /** Vue publique d'une copie (jamais de chemins internes ni de flux). */
  view(j) {
    return {
      id: j.id, state: j.state, bytes: j.bytes, totalBytes: j.totalBytes, files: j.files, totalFiles: j.totalFiles, skipped: j.skipped,
      startedAt: j.startedAt, endedAt: j.endedAt, error: j.error, from: j.from, to: j.to, target: j.target, overwrote: j.overwrote,
    };
  }

  get(user, id) {
    const j = this.jobs.get(id);
    if (!j || j.userId !== user.id) throw new HttpError(404, 'NOT_FOUND', 'Copie introuvable');
    return this.view(j);
  }

  list(user) {
    this.#purge();
    return [...this.jobs.values()].filter((j) => j.userId === user.id).map((j) => this.view(j));
  }

  cancel(user, id) {
    const j = this.jobs.get(id);
    if (!j || j.userId !== user.id) throw new HttpError(404, 'NOT_FOUND', 'Copie introuvable');
    if (j.state === 'running') { j.cancelled = true; j.abort.abort(); }
    return this.view(j);
  }

  /**
   * Valide, contrôle les droits (viewer sur la source, operator sur la destination), pré-analyse (taille, nombre
   * d'éléments) puis lance la copie en tâche de fond. Renvoie la copie en cours.
   */
  async start(user, input, requireHost) {
    const srcHostId = v.id(input?.from?.hostId, 'hôte source');
    const dstHostId = v.id(input?.to?.hostId, 'hôte destination');
    const srcPath = v.remotePath(input?.from?.path, 'source');
    const dstDir = v.remotePath(input?.to?.dir ?? '~', 'dossier destination');
    const name = input?.to?.name === undefined || input?.to?.name === null || input?.to?.name === '' ? null : v.fileName(input.to.name);
    const overwrite = v.bool(input?.overwrite, false);
    // Écraser un fichier est une action destructive : confirmation explicite, comme « undo » et « rewind ».
    if (overwrite && input?.confirm !== true) throw v.bad('Écraser un fichier existant exige confirm: true');
    // Contrôle des deux hôtes AVANT toute connexion : 404 si non accordé, 403 si lecture seule sur la destination.
    const srcHost = requireHost(user, srcHostId, 'viewer').host;
    const dstHost = requireHost(user, dstHostId, 'operator').host;

    this.#purge();
    const mine = [...this.jobs.values()].filter((j) => j.state === 'running');
    if (mine.filter((j) => j.userId === user.id).length >= PER_USER || mine.length >= GLOBAL) throw new HttpError(429, 'TOO_MANY_COPIES', 'Trop de copies en cours : attendez la fin de l\'une d\'elles');

    const cfg = this.config;
    const src = await this.sftp.open(srcHostId, srcPath);
    let st;
    try { st = await call(src.sftp, 'lstat', src.abs); } catch (err) { throw mapSftpError(err, src.abs); }
    const kind = typeOf(st.mode);
    if (kind === 'link') throw new HttpError(400, 'SYMLINK', 'La source est un lien symbolique : copie refusée (les liens ne sont jamais suivis)');
    if (kind !== 'file' && kind !== 'dir') throw new HttpError(400, 'NOT_COPYABLE', 'Seuls les fichiers et les dossiers se copient');

    const dst = await this.sftp.open(dstHostId, dstDir);
    let dstSt;
    try { dstSt = await call(dst.sftp, 'stat', dst.abs); } catch (err) { throw mapSftpError(err, dst.abs); }
    if (typeOf(dstSt.mode) !== 'dir') throw new HttpError(400, 'NOT_A_DIR', 'La destination doit être un dossier');
    const target = P.join(dst.abs, name || P.basename(src.abs));
    if (srcHostId === dstHostId && (target === src.abs || (kind === 'dir' && (target + '/').startsWith(`${src.abs}/`)))) {
      throw new HttpError(400, 'SAME_PLACE', 'La destination est la source elle-même (ou se trouve à l\'intérieur)');
    }
    const previous = await call(dst.sftp, 'lstat', target).then((x) => x, () => null);
    if (previous) {
      if (typeOf(previous.mode) === 'link') throw new HttpError(409, 'EXISTS', `« ${P.basename(target)} » existe déjà (lien symbolique)`);
      if (kind === 'dir' || typeOf(previous.mode) === 'dir') throw new HttpError(409, 'EXISTS', `« ${P.basename(target)} » existe déjà : un dossier n'est jamais fusionné ni écrasé`);
      if (!overwrite) throw new HttpError(409, 'EXISTS', `« ${P.basename(target)} » existe déjà (confirmez l'écrasement pour le remplacer)`);
    }

    // Pré-analyse bornée : taille totale et nombre d'éléments, avant d'écrire quoi que ce soit.
    let plan;
    if (kind === 'file') {
      if (st.size > cfg.copyMaxBytes) throw new HttpError(413, 'TOO_LARGE', `Fichier trop volumineux (> ${Math.round(cfg.copyMaxBytes / 1048576)} Mo, COPY_MAX_MB)`);
      plan = { entries: [{ rel: '', type: 'file', size: st.size, mode: st.mode }], files: 1, bytes: st.size, skipped: 0 };
    } else {
      plan = await scan(src.sftp, src.abs, { maxFiles: cfg.copyMaxFiles, maxBytes: cfg.copyMaxBytes });
    }

    const store = requestContext.getStore();
    const job = {
      id: crypto.randomBytes(8).toString('hex'), userId: user.id, state: 'running', cancelled: false, abort: new AbortController(),
      bytes: 0, totalBytes: plan.bytes, files: 0, totalFiles: plan.files, skipped: plan.skipped,
      startedAt: Date.now(), endedAt: null, error: null, overwrote: !!previous,
      from: { hostId: srcHostId, host: srcHost.name, path: src.abs }, to: { hostId: dstHostId, host: dstHost.name, dir: dst.abs }, target,
    };
    this.jobs.set(job.id, job);
    const who = { user: { id: user.id, username: user.username }, ip: store?.ip };
    this.journal.add({ ...who, type: 'sftp', event: 'copy', host: srcHost, detail: `${srcHost.name}:${src.abs} → ${dstHost.name}:${target} (${plan.files} fichier(s), ${plan.bytes} o${previous ? ', écrasement confirmé' : ''})` });
    this.#run(job, { kind, src, dst, plan, previous, srcHost, dstHost, who, overwrite }).catch(() => {});
    return this.view(job);
  }

  async #run(job, ctx) {
    const { kind, src, dst, plan, previous, srcHost, who } = ctx;
    const releaseA = this.pool.hold(job.from.hostId);
    const releaseB = this.pool.hold(job.to.hostId);
    const signal = job.abort.signal;
    let cleanup = null;
    try {
      if (kind === 'file') {
        const tmp = P.join(dst.abs, `.${P.basename(job.target).slice(0, 100)}.corvus-${rand()}.part`);
        cleanup = () => call(dst.sftp, 'unlink', tmp).catch(() => {});
        await this.#copyFile(job, src.sftp, src.abs, dst.sftp, tmp, plan.entries[0], signal);
        // Écrasement : la destination a pu changer depuis le contrôle initial.
        const exists = () => call(dst.sftp, 'lstat', job.target).then((x) => x, () => null);
        const now = await exists();
        if (now && !ctx.overwrite) throw new HttpError(409, 'EXISTS', 'Le fichier vient d\'être créé par ailleurs');
        if (now && typeOf(now.mode) === 'dir') throw new HttpError(409, 'EXISTS', 'Un dossier occupe maintenant la destination');
        if (signal.aborted) throw new HttpError(499, 'CANCELLED', 'Copie annulée');
        await finalizeUpload(dst.sftp, tmp, job.target, { overwrite: ctx.overwrite, previous: now || previous, exists });
        cleanup = null;
        job.files = 1;
      } else {
        const stage = P.join(dst.abs, `.${P.basename(job.target).slice(0, 100)}.corvus-${rand()}.part`);
        cleanup = () => rmTree(dst.sftp, stage, this.config.copyMaxFiles * 2 + 100);
        await call(dst.sftp, 'mkdir', stage);
        for (const e of plan.entries) {
          if (signal.aborted) throw new HttpError(499, 'CANCELLED', 'Copie annulée');
          const to = e.rel ? P.join(stage, e.rel) : stage;
          if (e.type === 'dir') { if (e.rel) await call(dst.sftp, 'mkdir', to); continue; }
          await this.#copyFile(job, src.sftp, P.join(src.abs, e.rel), dst.sftp, to, e, signal);
          job.files++;
        }
        if (signal.aborted) throw new HttpError(499, 'CANCELLED', 'Copie annulée');
        if (await call(dst.sftp, 'lstat', job.target).then(() => true, () => false)) throw new HttpError(409, 'EXISTS', 'La destination vient d\'être créée par ailleurs');
        await call(dst.sftp, 'rename', stage, job.target);
        cleanup = null;
      }
      job.state = 'done';
      this.journal.add({ ...who, type: 'sftp', event: 'copy-done', host: srcHost, detail: `${job.from.host}:${job.from.path} → ${job.to.host}:${job.target} (${job.files} fichier(s), ${job.bytes} o${job.skipped ? `, ${job.skipped} lien(s)/spécial(aux) ignoré(s)` : ''})` });
    } catch (err) {
      if (cleanup) await cleanup();
      const cancelled = job.cancelled || err?.name === 'AbortError' || err?.code === 'CANCELLED';
      job.state = cancelled ? 'cancelled' : 'failed';
      job.error = cancelled ? null : (err instanceof HttpError ? err.message : mapSftpError(err, job.target).message);
      this.journal.add({ ...who, type: 'sftp', event: cancelled ? 'copy-cancel' : 'copy-fail', ok: false, host: srcHost, detail: `${job.from.host}:${job.from.path} → ${job.to.host}:${job.target} après ${job.bytes} o${cancelled ? '' : ` : ${job.error}`}` });
    } finally {
      job.endedAt = Date.now();
      releaseA();
      releaseB();
    }
  }

  async #copyFile(job, srcSftp, from, dstSftp, to, entry, signal) {
    const cfg = this.config;
    const limit = cfg.copyMaxBytes;
    const bps = cfg.copyMaxBps;
    const t0 = Date.now();
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        job.bytes += chunk.length;
        // Un fichier a pu grossir depuis l'analyse : on borne aussi pendant le flux.
        if (job.bytes > limit) return cb(new HttpError(413, 'TOO_LARGE', 'Taille maximale de copie dépassée pendant le transfert'));
        if (!bps) return cb(null, chunk);
        const wait = Math.max(0, (job.bytes / bps) * 1000 - (Date.now() - t0));
        if (!wait) return cb(null, chunk);
        sleep(wait).then(() => cb(null, chunk));
      },
    });
    try {
      await pipeline(srcSftp.createReadStream(from), meter, dstSftp.createWriteStream(to, { flags: 'wx', mode: (entry.mode & 0o777) || 0o644 }), { signal });
    } catch (err) {
      await call(dstSftp, 'unlink', to).catch(() => {});
      throw err;
    }
    // Droits d'origine (sans bits spéciaux) ; échec sans conséquence (certains serveurs SFTP refusent).
    await call(dstSftp, 'chmod', to, (entry.mode & 0o777) || 0o644).catch(() => {});
  }
}

/** Parcours borné d'un dossier source : éléments (dossiers puis fichiers), liens et fichiers spéciaux ignorés. */
async function scan(sftp, root, { maxFiles, maxBytes }) {
  const entries = [{ rel: '', type: 'dir', size: 0, mode: 0 }];
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let seen = 0;
  const walk = async (abs, rel, depth) => {
    if (depth > MAX_DEPTH) throw new HttpError(413, 'TOO_DEEP', `Dossiers imbriqués sur plus de ${MAX_DEPTH} niveaux : copie refusée`);
    let items;
    try { items = await call(sftp, 'readdir', abs); } catch (err) { throw mapSftpError(err, abs); }
    for (const i of items) {
      if (i.filename === '.' || i.filename === '..') continue;
      if (++seen > maxFiles * 2) throw new HttpError(413, 'TOO_MANY', `Plus de ${maxFiles} éléments : copie refusée (COPY_MAX_FILES)`);
      const type = typeOf(i.attrs.mode);
      const r = rel ? `${rel}/${i.filename}` : i.filename;
      if (type === 'dir') { entries.push({ rel: r, type: 'dir', size: 0, mode: i.attrs.mode }); await walk(P.join(abs, i.filename), r, depth + 1); }
      else if (type === 'file') {
        files++; bytes += i.attrs.size;
        if (files > maxFiles) throw new HttpError(413, 'TOO_MANY', `Plus de ${maxFiles} fichiers : copie refusée (COPY_MAX_FILES)`);
        if (bytes > maxBytes) throw new HttpError(413, 'TOO_LARGE', `Plus de ${Math.round(maxBytes / 1048576)} Mo : copie refusée (COPY_MAX_MB)`);
        entries.push({ rel: r, type: 'file', size: i.attrs.size, mode: i.attrs.mode });
      } else skipped++;
    }
  };
  await walk(root, '', 0);
  return { entries, files, bytes, skipped };
}

/** Supprime un dossier TEMPORAIRE créé par la copie (borné ; ne suit jamais un lien : lstat). */
async function rmTree(sftp, target, limit) {
  let count = 0;
  const rm = async (p) => {
    if (++count > limit) return;
    const st = await call(sftp, 'lstat', p);
    if (typeOf(st.mode) === 'dir') {
      for (const i of await call(sftp, 'readdir', p)) if (i.filename !== '.' && i.filename !== '..') await rm(P.join(p, i.filename));
      await call(sftp, 'rmdir', p);
    } else await call(sftp, 'unlink', p);
  };
  try { await rm(target); } catch { /* meilleur effort : le nom temporaire commence par « . » et finit par .part */ }
}
