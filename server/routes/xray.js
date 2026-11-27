// Radiographie : /api/hosts/:id/xray/* — processus, connexions, lignée (agent requis).
// Lecture = viewer ; geler / dégeler / tuer = administrateur de l'hôte (l'agent est root), avec confirmation explicite, journalisé.
import { Router } from 'express';
import * as v from '../lib/validate.js';
import { HttpError } from '../lib/validate.js';

export function xrayRoutes(ctx) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);

  r.get('/hosts/:id/xray/live', async (req, res) => {
    res.json(await ctx.agents.request(hid(req), 'xray.live', {}, 20_000));
  });

  r.post('/hosts/:id/xray/proc', async (req, res) => {
    const hostId = hid(req);
    if (req.body?.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', 'Confirmation explicite requise (confirm: true)');
    const action = v.oneOf(req.body?.action, ['freeze', 'thaw', 'kill'], 'action');
    const pid = v.int(req.body?.pid, 'pid', { min: 2, max: 4_194_304 });
    const start = v.int(req.body?.start, 'start', { min: 0, max: Number.MAX_SAFE_INTEGER });
    const host = ctx.hosts.find(hostId);
    try {
      const result = await ctx.agents.request(hostId, `proc.${action}`, { pid, start });
      ctx.journal.add({ type: 'xray', event: action, host, user: req.user, ip: req.ip, detail: `pid ${pid} ${result.exe}` });
      res.json(result);
    } catch (err) {
      ctx.journal.add({ type: 'xray', event: `${action}-failed`, host, user: req.user, ip: req.ip, ok: false, detail: `pid ${pid} : ${err.message}` });
      throw err;
    }
  });

  return r;
}
