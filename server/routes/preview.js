// Prévisualisation de commandes (étape 5.2) : /api/hosts/:id/preview. Le bac à sable est exécuté par
// l'agent (désactivé par défaut, root requis). « root » exige d'être administrateur de l'hôte.
import { Router } from 'express';
import * as v from '../lib/validate.js';
import { HttpError } from '../lib/validate.js';
import { lineDiff } from '../lib/rewind.js';

export function previewRoutes(ctx) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);
  // Prévisualisations récentes : l'application d'un diff est réservée à qui l'a demandé (ou à un admin de l'hôte).
  const recent = new Map();
  const forget = () => { for (const [k, p] of recent) if (Date.now() - p.ts > 3600_000) recent.delete(k); };

  r.post('/hosts/:id/preview', async (req, res) => {
    const hostId = hid(req);
    const host = ctx.hosts.find(hostId);
    const command = v.str(String(req.body?.command ?? ''), 'commande', { min: 1, max: 4000 });
    const asRoot = req.body?.root === true;
    const timeoutSec = req.body?.timeoutSec === undefined ? 30 : v.int(req.body.timeoutSec, 'délai', { min: 1, max: 120 });
    if (asRoot) ctx.requireHost(req.user, hostId, 'admin');
    const agent = ctx.agents.forHost(hostId);
    if (!agent?.online) throw new HttpError(409, 'AGENT_OFFLINE', 'La prévisualisation nécessite un agent connecté sur cet hôte');
    ctx.journal.add({ type: 'preview', event: 'run', host, user: req.user, ip: req.ip, detail: `${asRoot ? '[root] ' : ''}${command.slice(0, 300)}` });
    const result = await ctx.agents.request(hostId, 'preview.run', { command, root: asRoot, user: host.username, timeoutSec }, (timeoutSec + 60) * 1000);
    // Diff calculé ici ; les textes bruts ne sont pas renvoyés au navigateur.
    result.entries = (result.entries || []).map((e) => {
      const { before, after, ...rest } = e;
      return typeof after === 'string' || typeof before === 'string' ? { ...rest, diff: lineDiff(before || '', after || '') } : rest;
    });
    forget();
    recent.set(`${hostId}:${result.id}`, { ts: Date.now(), userId: req.user.id, root: asRoot });
    res.json(result);
  });

  r.post('/hosts/:id/preview/:pid/apply', async (req, res) => {
    const hostId = hid(req);
    const host = ctx.hosts.find(hostId);
    if (req.body?.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', 'Confirmation explicite requise (confirm: true)');
    const p = recent.get(`${hostId}:${req.params.pid}`);
    if (!p) throw new HttpError(404, 'PREVIEW_UNKNOWN', 'Prévisualisation expirée ou inconnue : relancez-la');
    if (p.root) ctx.requireHost(req.user, hostId, 'admin');
    else if (p.userId !== req.user.id) ctx.requireHost(req.user, hostId, 'admin');
    const result = await ctx.agents.request(hostId, 'preview.apply', { id: req.params.pid }, 60_000).catch((err) => {
      ctx.journal.add({ type: 'preview', event: 'apply-failed', host, user: req.user, ip: req.ip, ok: false, detail: err.message });
      throw err;
    });
    recent.delete(`${hostId}:${req.params.pid}`);
    ctx.journal.add({ type: 'preview', event: 'apply', host, user: req.user, ip: req.ip, detail: `${result.applied} changement(s) appliqué(s)` });
    res.json(result);
  });

  return r;
}
