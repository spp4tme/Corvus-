// Routes Supervision et Docker : /api/hosts/:id/monitor/*, /api/hosts/:id/docker/*
import { Router } from 'express';
import * as v from '../lib/validate.js';
import { RANGES } from '../lib/metrics.js';

export function monitorRoutes({ monitor, metrics, hostStatus, hosts }) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);

  r.get('/hosts/:id/monitor/stats', async (req, res) => res.json(await monitor.stats(hid(req))));
  r.get('/hosts/:id/monitor/history', (req, res) => {
    const list = String(req.query.metrics || 'cpu').split(',').slice(0, 20).map((m) => v.str(m, 'métrique', { min: 1, max: 80 }));
    const range = v.oneOf(String(req.query.range || '1h'), Object.keys(RANGES), 'plage');
    res.json(metrics.history(hid(req), list, range));
  });
  r.get('/hosts/:id/monitor/metrics', (req, res) => res.json({ metrics: metrics.available(hid(req)) }));
  r.post('/hosts/:id/probe', async (req, res) => {
    res.json({ status: await hostStatus.check(hosts.get(hid(req))) });
  });
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
