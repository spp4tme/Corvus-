// Routes d'administration d'un hôte : /api/hosts/:id/admin/*
// Lecture : tout compte ayant accès à l'hôte. Écriture : administrateurs (voir lib/access.js),
// et toujours avec `confirm: true` (aucune action modifiante sans confirmation explicite).
import { Router } from 'express';
import { HttpError } from '../lib/validate.js';
import * as v from '../lib/validate.js';

export function hostAdminRoutes({ hostAdmin }) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);
  const confirmed = (req) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', 'Confirmation explicite requise');
  };

  r.get('/hosts/:id/admin/services', async (req, res) => res.json(await hostAdmin.services(hid(req))));
  r.post('/hosts/:id/admin/services/:unit/:action', async (req, res) => {
    confirmed(req);
    res.json(await hostAdmin.serviceAction(hid(req), req.params.unit, req.params.action));
  });

  r.get('/hosts/:id/admin/logs', async (req, res) => {
    res.json(await hostAdmin.logs(hid(req), {
      unit: req.query.unit ? String(req.query.unit) : undefined,
      lines: v.int(req.query.lines, 'lignes', { min: 1, max: 5000, def: 200 }),
      priority: req.query.priority === undefined || req.query.priority === '' ? undefined : req.query.priority,
      cursor: req.query.cursor ? String(req.query.cursor) : undefined,
    }));
  });

  r.get('/hosts/:id/admin/firewall', async (req, res) => res.json(await hostAdmin.firewall(hid(req))));
  r.post('/hosts/:id/admin/firewall/ufw', async (req, res) => {
    confirmed(req);
    res.json(await hostAdmin.ufw(hid(req), req.body));
  });

  r.get('/hosts/:id/admin/users', async (req, res) => res.json(await hostAdmin.users(hid(req))));
  r.post('/hosts/:id/admin/users/:name/:action', async (req, res) => {
    confirmed(req);
    const action = v.oneOf(req.params.action, ['lock', 'unlock'], 'action');
    res.json(await hostAdmin.lockUser(hid(req), req.params.name, action === 'lock'));
  });

  r.get('/hosts/:id/admin/updates', async (req, res) => res.json(await hostAdmin.updates(hid(req))));
  r.post('/hosts/:id/admin/updates/refresh', async (req, res) => {
    confirmed(req);
    res.json(await hostAdmin.refreshUpdates(hid(req)));
  });

  r.get('/hosts/:id/sudoers', async (req, res) => res.json(await hostAdmin.sudoersRule(hid(req))));
  return r;
}
