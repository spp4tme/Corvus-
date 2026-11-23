// Routes Supervision et Docker : /api/hosts/:id/monitor/*, /api/hosts/:id/docker/*
import { Router } from 'express';
import * as v from '../lib/validate.js';

export function monitorRoutes({ monitor }) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);

  r.get('/hosts/:id/monitor/stats', async (req, res) => res.json(await monitor.stats(hid(req))));
  r.get('/hosts/:id/monitor/processes', async (req, res) => res.json(await monitor.processes(hid(req))));
  r.post('/hosts/:id/monitor/kill', async (req, res) => {
    const pid = v.int(req.body?.pid, 'pid', { min: 2, max: 4_194_304 });
    const signal = v.oneOf(req.body?.signal ?? 'TERM', v.SIGNALS, 'signal');
    res.json(await monitor.kill(hid(req), pid, signal));
  });

  r.get('/hosts/:id/docker/containers', async (req, res) => res.json(await monitor.containers(hid(req))));
  r.post('/hosts/:id/docker/:name/:action', async (req, res) => {
    const action = v.oneOf(req.params.action, ['start', 'stop', 'restart'], 'action');
    res.json(await monitor.containerAction(hid(req), v.container(req.params.name), action));
  });
  r.get('/hosts/:id/docker/:name/logs', async (req, res) => {
    const tail = v.int(req.query.tail, 'tail', { min: 1, max: 5000, def: 300 });
    res.json(await monitor.containerLogs(hid(req), v.container(req.params.name), tail));
  });
  return r;
}
