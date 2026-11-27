// Copie d'hôte à hôte : /api/fs/copy (global : deux hôtes dans la même requête).
// Contrôles : rôle global « operator » (seconde barrière) ; puis viewer sur la source ET operator sur la destination,
// vérifiés par requireHost dans le service (404 si un hôte n'est pas accordé).
import { Router } from 'express';
import * as v from '../lib/validate.js';
import { roleGuard } from '../lib/access.js';

export function copyRoutes(ctx) {
  const r = Router();
  r.use('/fs/copy', roleGuard(ctx, 'operator'));
  const jid = (req) => v.str(req.params.id, 'id', { min: 16, max: 16 });
  r.get('/fs/copy', (req, res) => res.json({ copies: ctx.copy.list(req.user) }));
  r.post('/fs/copy', async (req, res) => res.status(202).json({ copy: await ctx.copy.start(req.user, req.body || {}, ctx.requireHost) }));
  r.get('/fs/copy/:id', (req, res) => res.json({ copy: ctx.copy.get(req.user, jid(req)) }));
  r.delete('/fs/copy/:id', (req, res) => res.json({ copy: ctx.copy.cancel(req.user, jid(req)) }));
  return r;
}
