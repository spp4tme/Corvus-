// Rembobinage : /api/hosts/:id/rewind/* — lecture = viewer ; restauration = admin de l'hôte (access.js).
import { Router } from 'express';
import * as v from '../lib/validate.js';
import { HttpError } from '../lib/validate.js';

export function rewindRoutes(ctx) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);
  const at = (raw) => {
    const t = Date.parse(String(raw));
    const n = Number.isFinite(t) ? t : Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'BAD_TIME', 'Instant invalide');
    return n;
  };

  r.get('/hosts/:id/rewind/events', (req, res) => {
    res.json({ events: ctx.rewind.events(hid(req), {
      before: req.query.before ? v.int(Number(req.query.before), 'before', { min: 1, max: 9e15 }) : undefined,
      limit: req.query.limit ? v.int(Number(req.query.limit), 'limit', { min: 1, max: 500 }) : 100,
      type: req.query.type ? v.str(String(req.query.type), 'type', { max: 40 }) : undefined,
      q: req.query.q ? v.str(String(req.query.q), 'recherche', { max: 120 }) : undefined,
    }), agent: ctx.agents.forHost(hid(req)) });
  });

  /** Ce que changerait un retour à l'instant `at` (aucune modification). */
  r.get('/hosts/:id/rewind/changes', (req, res) => {
    const prefix = req.query.prefix ? v.str(String(req.query.prefix), 'préfixe', { max: 300 }) : '';
    res.json({ at: at(req.query.at), changes: ctx.rewind.changesSince(hid(req), at(req.query.at), prefix) });
  });

  r.get('/hosts/:id/rewind/diff', (req, res) => {
    const sha = (x) => (x ? v.str(String(x), 'empreinte', { min: 64, max: 64 }) : null);
    res.json(ctx.rewind.diff(hid(req), sha(req.query.a), sha(req.query.b)));
  });

  r.get('/hosts/:id/rewind/version/:sha', (req, res) => {
    const buf = ctx.rewind.versionBuffer(hid(req), req.params.sha);
    res.type('text/plain; charset=utf-8').send(buf.includes(0) ? '(contenu binaire)' : buf.toString('utf8'));
  });

  r.post('/hosts/:id/rewind/restore', async (req, res) => {
    const hostId = hid(req);
    if (req.body?.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', 'Confirmation explicite requise (confirm: true)');
    const when = at(req.body?.at);
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map((p) => v.str(String(p), 'chemin', { min: 1, max: 4096 })) : [];
    const host = ctx.hosts.find(hostId);
    ctx.journal.add({ type: 'rewind', event: 'restore-start', host, user: req.user, ip: req.ip, detail: `retour à ${new Date(when).toISOString()} : ${paths.length} chemin(s)` });
    const results = await ctx.rewind.restore(hostId, when, paths);
    for (const x of results) {
      ctx.journal.add({ type: 'rewind', event: x.ok ? `restore-${x.action}` : 'restore-failed', host, user: req.user, ip: req.ip, ok: !!x.ok, detail: `${x.path}${x.error ? ` : ${x.error}` : ''}` });
    }
    res.json({ results });
  });

  return r;
}
