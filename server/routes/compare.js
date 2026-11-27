// Route « Comparer » : /api/compare (global : plusieurs hôtes dans une même requête).
// Contrôles : rôle global « viewer » (seconde barrière) + viewer SUR CHAQUE hôte lu (404 si non accordé).
import { Router } from 'express';
import { roleGuard } from '../lib/access.js';

export function compareRoutes(ctx) {
  const r = Router();
  r.use('/compare', roleGuard(ctx, 'viewer'));
  r.post('/compare', async (req, res) => {
    res.json(await ctx.compare.run(req.user, req.body || {}, ctx.requireHost));
  });
  return r;
}
