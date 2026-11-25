// Routes : services web (proxy) et notifications push.
import { Router } from 'express';
import * as v from '../lib/validate.js';

export function serviceRoutes({ proxy, push, config }) {
  const r = Router();

  r.get('/services', (req, res) => res.json({ enabled: config.webProxy, services: proxy.list() }));
  r.post('/services', (req, res) => res.status(201).json({ service: proxy.create(req.body) }));
  r.delete('/services/:id', (req, res) => { proxy.delete(v.str(req.params.id, 'id', { min: 12, max: 12 })); res.json({ ok: true }); });
  r.post('/services/:id/open', async (req, res) => {
    if (!config.webProxy) throw new v.HttpError(403, 'DISABLED', 'Proxy web désactivé (CORVUS_WEB_PROXY=0)');
    res.json(await proxy.open(v.str(req.params.id, 'id', { min: 12, max: 12 })));
  });

  r.get('/push/key', (req, res) => res.json({ publicKey: push.publicKey, subscriptions: push.count() }));
  r.post('/push/subscribe', (req, res) => res.json(push.subscribe(req.body)));
  r.delete('/push/subscribe', (req, res) => { push.unsubscribe(String(req.body?.endpoint || '')); res.json({ ok: true }); });
  r.post('/push/test', async (req, res) => res.json(await push.notify({ title: 'Corvus', body: 'Notification de test ✔' })));
  r.get('/push/latest', (req, res) => res.json({ notification: push.latestNotification() }));
  return r;
}
