// Empreinte du normal : /api/hosts/:id/behavior — consultation, autorisation d'un élément, réglages.
import { Router } from 'express';
import * as v from '../lib/validate.js';
import { HttpError } from '../lib/validate.js';

export function behaviorRoutes(ctx) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);

  r.get('/hosts/:id/behavior', (req, res) => res.json(ctx.behavior.overview(hid(req))));

  r.post('/hosts/:id/behavior/allow', (req, res) => {
    const kind = v.oneOf(req.body?.kind, ['proc', 'conn', 'listen'], 'type');
    const item = v.str(String(req.body?.item ?? ''), 'élément', { min: 1, max: 400 });
    if (!ctx.behavior.allow(hid(req), kind, item)) throw new HttpError(404, 'NOT_FOUND', 'Élément inconnu');
    ctx.journal.add({ type: 'behavior', event: 'allow', host: ctx.hosts.find(hid(req)), user: req.user, ip: req.ip, detail: `${kind} ${item}` });
    res.json({ ok: true });
  });

  r.put('/hosts/:id/behavior/settings', (req, res) => {
    const hostId = hid(req);
    if (typeof req.body?.autoFreeze === 'boolean') {
      ctx.behavior.setAutoFreeze(hostId, req.body.autoFreeze);
      ctx.journal.add({ type: 'behavior', event: 'autofreeze', host: ctx.hosts.find(hostId), user: req.user, ip: req.ip, detail: req.body.autoFreeze ? 'gel automatique activé' : 'gel automatique désactivé' });
    }
    if (typeof req.body?.autoIsolate === 'boolean') {
      ctx.behavior.setAutoIsolate(hostId, req.body.autoIsolate);
      ctx.journal.add({ type: 'behavior', event: 'autoisolate', host: ctx.hosts.find(hostId), user: req.user, ip: req.ip, detail: req.body.autoIsolate ? 'isolement automatique activé' : 'isolement automatique désactivé' });
    }
    if (req.body?.isolateTtl !== undefined) ctx.behavior.setIsolateTtl(hostId, v.int(req.body.isolateTtl, 'durée', { min: 60, max: 86_400 }));
    res.json(ctx.behavior.overview(hostId));
  });

  // Isolement réseau manuel (administrateur de l'hôte). Tailscale et le serveur Corvus restent toujours joignables.
  r.get('/hosts/:id/isolation', async (req, res) => res.json(await ctx.agents.request(hid(req), 'net.status', {})));
  r.post('/hosts/:id/isolation', async (req, res) => {
    const hostId = hid(req);
    if (req.body?.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', 'Confirmation explicite requise (confirm: true)');
    const action = v.oneOf(req.body?.action, ['isolate', 'release'], 'action');
    const ttlSec = req.body?.ttlSec === undefined ? 900 : v.int(req.body.ttlSec, 'durée', { min: 60, max: 86_400 });
    const host = ctx.hosts.find(hostId);
    try {
      const out = await ctx.agents.request(hostId, action === 'isolate' ? 'net.isolate' : 'net.release', action === 'isolate' ? { ttlSec } : {});
      ctx.journal.add({ type: 'ransom', event: action === 'isolate' ? 'isolate' : 'release', host, user: req.user, ip: req.ip, detail: action === 'isolate' ? `isolement réseau demandé (${ttlSec} s)` : 'levée de l\'isolement demandée' });
      res.json(out);
    } catch (err) {
      ctx.journal.add({ type: 'ransom', event: `${action}-failed`, host, user: req.user, ip: req.ip, ok: false, detail: err.message });
      throw err;
    }
  });

  r.post('/hosts/:id/behavior/restart', (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', 'Confirmation explicite requise (confirm: true)');
    const days = req.body?.days === undefined ? undefined : v.int(req.body.days, 'jours', { min: 1, max: 90 });
    ctx.behavior.restartLearning(hid(req), days);
    ctx.journal.add({ type: 'behavior', event: 'restart', host: ctx.hosts.find(hid(req)), user: req.user, ip: req.ip, detail: 'apprentissage recommencé' });
    res.json(ctx.behavior.overview(hid(req)));
  });

  return r;
}
