// Routes Fichiers (SFTP) : /api/hosts/:id/fs/*
import { Router } from 'express';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as v from '../lib/validate.js';
import { IMAGE_TYPES } from '../lib/sftp.js';

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Les fichiers servis depuis un hôte distant ne doivent jamais s'exécuter dans l'origine Corvus.
function isolate(res) {
  res.set({
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
}

async function sendStream(res, { stream, size }) {
  res.set('Content-Length', String(size));
  try {
    await pipeline(stream, res);
  } catch {
    res.destroy();
  }
}

export function fileRoutes({ sftp }) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);
  const qpath = (req, name = 'path') => (req.query[name] ? v.remotePath(String(req.query[name])) : '~');

  r.get('/hosts/:id/fs/list', async (req, res) => {
    res.json(await sftp.list(hid(req), qpath(req)));
  });

  r.get('/hosts/:id/fs/read', async (req, res) => {
    res.json(await sftp.readText(hid(req), v.remotePath(String(req.query.path ?? ''))));
  });

  r.put('/hosts/:id/fs/write', async (req, res) => {
    const { path: p, content, expectedMtime } = req.body || {};
    if (typeof content !== 'string') throw v.bad('content doit être une chaîne');
    const mt = expectedMtime === undefined || expectedMtime === null ? undefined : v.int(expectedMtime, 'expectedMtime');
    res.json(await sftp.writeText(hid(req), v.remotePath(p), content, mt));
  });

  r.get('/hosts/:id/fs/download', async (req, res) => {
    const id = hid(req);
    const file = await sftp.readStream(id, v.remotePath(String(req.query.path ?? '')));
    isolate(res);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': contentDisposition('attachment', file.name) });
    sftp.log(id, 'download', `${file.abs} (${file.size} o)`);
    await sendStream(res, file);
  });

  r.get('/hosts/:id/fs/preview', async (req, res) => {
    const p = v.remotePath(String(req.query.path ?? ''));
    const ext = path.posix.extname(p).slice(1).toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type) throw new v.HttpError(415, 'UNSUPPORTED', 'Aperçu disponible pour les images uniquement');
    const file = await sftp.readStream(hid(req), p, sftp.config.maxPreviewBytes);
    isolate(res);
    res.set({ 'Content-Type': type, 'Content-Disposition': contentDisposition('inline', file.name) });
    await sendStream(res, file);
  });

  r.post('/hosts/:id/fs/upload', async (req, res) => {
    const dir = v.remotePath(String(req.query.dir ?? '~'));
    const name = v.fileName(String(req.query.name ?? ''));
    const overwrite = v.bool(req.query.overwrite, false);
    res.status(201).json(await sftp.upload(hid(req), dir, name, req, { overwrite }));
  });

  r.post('/hosts/:id/fs/mkdir', async (req, res) => {
    res.status(201).json(await sftp.mkdir(hid(req), v.remotePath(req.body?.path)));
  });

  r.post('/hosts/:id/fs/rename', async (req, res) => {
    res.json(await sftp.rename(hid(req), v.remotePath(req.body?.from, 'source'), v.remotePath(req.body?.to, 'destination')));
  });

  r.post('/hosts/:id/fs/delete', async (req, res) => {
    res.json(await sftp.remove(hid(req), v.remotePath(req.body?.path)));
  });

  return r;
}
