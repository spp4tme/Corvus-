// Gestion des agents (réservée aux administrateurs, cf. access.js) : jeton d'enrôlement, liste, révocation.
// L'enrôlement lui-même (POST /api/agent/enroll) est public et vit dans app.js.
import { Router } from 'express';
import * as v from '../lib/validate.js';

export function agentRoutes(ctx) {
  const r = Router();

  r.get('/agents', (req, res) => res.json({ agents: ctx.agents.list(), serverPublicKey: ctx.agents.publicKeyB64 }));

  r.post('/agents/enrollments', (req, res) => {
    const hostId = v.str(req.body?.hostId, 'hostId', { max: 64 });
    res.status(201).json(ctx.agents.createEnrollment(hostId));
  });

  r.delete('/agents/:id', (req, res) => {
    ctx.agents.revoke(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
