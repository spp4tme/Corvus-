// Routes système : état du stockage, alertes, sauvegardes / restauration.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import * as v from '../lib/validate.js';
import { dirSize } from '../lib/storage.js';

function fileSize(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}

/** Mot de passe transmis dans un en-tête (corps = fichier) : encodé en base64url pour l'UTF-8. */
function headerPassword(req) {
  const raw = String(req.headers['x-backup-password'] || '');
  try { return Buffer.from(raw, 'base64url').toString('utf8'); } catch { return ''; }
}

export function systemRoutes(ctx) {
  const r = Router();
  const { storage, storageMonitor, blobs, backups, alerts, db, journal, config } = ctx;
  const admin = (req) => ctx.requireRole?.(req, 'admin');

  r.get('/system/status', (req, res) => {
    const space = storageMonitor.status();
    res.json({
      version: ctx.version,
      storage: {
        dir: storage.dir,
        custom: storage.custom,
        db: fileSize(storage.dbFile) + fileSize(`${storage.dbFile}-wal`),
        blobs: blobs.stats(),
        space,
        low: space.some((s) => s.low),
      },
      alerts: { open: db.get('SELECT COUNT(*) AS n FROM alerts WHERE ack_at IS NULL').n },
      schema: db.version,
      restoredFrom: ctx.restoredFrom || null,
    });
  });

  r.get('/system/usage', (req, res) => {
    admin(req);
    res.json({ blobsOnDisk: dirSize(storage.blobDir), backups: dirSize(storage.backupDir) });
  });

  r.get('/alerts', (req, res) => {
    const open = v.bool(req.query.open, false);
    res.json({ alerts: alerts.list({ open, hostIds: req.allowedHostIds?.() }) });
  });

  r.post('/alerts/:id/ack', (req, res) => {
    alerts.ack(v.int(req.params.id, 'id', { min: 1 }), req.user);
    res.json({ ok: true });
  });

  r.get('/backups', (req, res) => {
    admin(req);
    res.json({ backups: backups.list(), dir: storage.backupDir });
  });

  r.post('/backups', async (req, res) => {
    admin(req);
    res.status(201).json({ backup: await backups.create(req.body?.password, req.user) });
  });

  r.get('/backups/:name/download', async (req, res) => {
    admin(req);
    const file = backups.path(req.params.name);
    journal.add({ type: 'backup', event: 'download', user: req.user, ip: req.ip, detail: req.params.name });
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${req.params.name}"`,
      'Content-Length': String(fs.statSync(file).size),
    });
    await pipeline(fs.createReadStream(file), res).catch(() => res.destroy());
  });

  r.delete('/backups/:name', (req, res) => {
    admin(req);
    backups.remove(req.params.name, req.user);
    res.json({ ok: true });
  });

  // Restauration : le fichier est envoyé brut (corps de la requête), vérifié puis préparé.
  r.post('/backups/restore', async (req, res) => {
    admin(req);
    const tmp = path.join(storage.backupDir, `.upload-${crypto.randomBytes(4).toString('hex')}.cvbk`);
    try {
      await pipeline(req, fs.createWriteStream(tmp, { mode: 0o600 }));
      res.json(await backups.stage(tmp, headerPassword(req), req.user));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  r.post('/backups/:name/restore', async (req, res) => {
    admin(req);
    res.json(await backups.stage(backups.path(req.params.name), req.body?.password, req.user));
  });

  // Redémarrage : seulement sous un superviseur qui relance le processus (systemd, Docker).
  r.post('/system/restart', (req, res) => {
    admin(req);
    const supervised = !!(process.env.INVOCATION_ID || process.env.CORVUS_SUPERVISED || fs.existsSync('/.dockerenv'));
    if (!supervised) {
      return res.status(409).json({ error: { code: 'NOT_SUPERVISED', message: 'Corvus n\'est pas lancé par systemd ou Docker : redémarrez-le à la main.' } });
    }
    journal.add({ type: 'system', event: 'restart', user: req.user, ip: req.ip });
    res.json({ ok: true });
    // Code 75 : considéré comme un échec par systemd (Restart=on-failure) → relance automatique.
    setTimeout(() => process.exit(75), 300);
  });

  r.get('/system/config', (req, res) => {
    admin(req);
    res.json({ retention: config.retention, minFreeMb: config.minFreeMb, dataDir: config.dataDir, storageDir: storage.dir });
  });
  return r;
}
