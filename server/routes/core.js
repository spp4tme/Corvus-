// Routes : hôtes, terminaux, journal, tailscale. (Authentification : routes/accounts.js ;
// droits : lib/access.js, appliqué avant ces routes.)
import { Router } from 'express';
import { tailscalePeers } from '../lib/tailscale.js';
import { HttpError } from '../lib/validate.js';
import * as v from '../lib/validate.js';


export function hostRoutes(ctx) {
  const r = Router();
  const { hosts, pool, knownHosts, journal, terminals, config } = ctx;

  r.get('/hosts', (req, res) => {
    const allowed = req.allowedHostIds();
    res.json({
      hosts: hosts.list().filter((h) => !allowed || allowed.includes(h.id)).map((h) => ({
        ...h, connection: pool.status(h.id), knownHost: knownHosts.get(h.hostname, h.port),
        status: ctx.hostStatus?.get(h.id) || null, agent: ctx.agents.forHost(h.id), role: ctx.users.hostRole(req.user, h),
      })),
    });
  });

  r.post('/hosts', (req, res) => {
    const host = hosts.create(req.body);
    journal.add({ type: 'admin', event: 'host-create', user: req.user, host, ip: req.ip });
    res.status(201).json({ host });
  });

  // Test d'une configuration non enregistrée (formulaire d'ajout).
  r.post('/hosts/test', async (req, res) => {
    const draft = hosts.parse(req.body);
    const secrets = hosts.parseSecrets(req.body) || {};
    const result = await pool.test(hosts.connectConfig(draft, secrets));
    journal.add({ type: 'test', event: 'test', host: draft, ok: result.ok });
    res.json(result);
  });

  r.get('/hosts/:id', (req, res) => {
    const h = hosts.get(v.id(req.params.id));
    res.json({ host: { ...hosts.publicView(h), connection: pool.status(h.id), knownHost: knownHosts.get(h.hostname, h.port) } });
  });

  r.patch('/hosts/:id', (req, res) => {
    const id = v.id(req.params.id);
    const connChanged = ['hostname', 'port', 'username', 'authType', 'password', 'privateKey', 'passphrase', 'clearSecrets']
      .some((k) => k in (req.body || {}));
    const host = hosts.update(id, req.body);
    journal.add({ type: 'admin', event: 'host-update', user: req.user, host, ip: req.ip, detail: Object.keys(req.body || {}).filter((k) => !['password', 'privateKey', 'passphrase'].includes(k)).join(', ') + (connChanged ? ' (connexion)' : '') });
    if (connChanged) {
      pool.drop(id);
      ctx.sftp?.forget(id);
    }
    res.json({ host });
  });

  r.delete('/hosts/:id', (req, res) => {
    const id = v.id(req.params.id);
    hosts.get(id);
    for (const t of terminals.list()) if (t.hostId === id) terminals.close(t.id);
    pool.drop(id);
    journal.add({ type: 'admin', event: 'host-delete', user: req.user, host: hosts.get(id), ip: req.ip });
    hosts.delete(id);
    res.json({ ok: true });
  });

  r.post('/hosts/:id/test', async (req, res) => {
    const h = hosts.get(v.id(req.params.id));
    try {
      const result = await pool.test(hosts.connectConfig(h));
      journal.add({ type: 'test', event: 'test', host: h, ok: result.ok, detail: result.uname });
      res.json(result);
    } catch (err) {
      journal.add({ type: 'test', event: 'test', host: h, ok: false, detail: err.message });
      throw err;
    }
  });

  r.get('/hosts/:id/hostkey', (req, res) => {
    const h = hosts.get(v.id(req.params.id));
    res.json({ knownHost: knownHosts.get(h.hostname, h.port) });
  });

  // Oublier l'empreinte (après vérification hors-bande d'une réinstallation légitime).
  r.delete('/hosts/:id/hostkey', (req, res) => {
    const h = hosts.get(v.id(req.params.id));
    knownHosts.forget(h.hostname, h.port);
    pool.drop(h.id);
    journal.add({ type: 'test', event: 'hostkey-reset', host: h });
    res.json({ ok: true });
  });

  r.get('/tailscale/peers', async (req, res) => {
    res.json(await tailscalePeers(config.tailscaleBin));
  });

  // Chacun ne voit que ses terminaux (les sessions partagées avec lui sont listées à part).
  r.get('/terminals', (req, res) => {
    res.json({ terminals: terminals.list().filter((t) => t.ownerId === req.user.id) });
  });

  r.delete('/terminals/:id', (req, res) => {
    const id = v.str(req.params.id, 'id', { min: 8, max: 32 });
    const t = terminals.list().find((x) => x.id === id);
    if (t && t.ownerId !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Ce terminal appartient à un autre compte');
    terminals.close(id);
    res.json({ ok: true });
  });

  r.get('/journal', (req, res) => {
    const limit = v.int(req.query.limit, 'limit', { min: 1, max: 2000, def: 200 });
    const type = req.query.type ? v.str(req.query.type, 'type', { max: 20 }) : undefined;
    const hostId = req.query.hostId ? v.id(req.query.hostId) : undefined;
    const before = req.query.before ? v.int(req.query.before, 'before', { min: 1 }) : undefined;
    res.json({ entries: journal.list({ limit, type, hostId, before, hostIds: req.allowedHostIds() || undefined }), head: req.user.role === 'admin' ? journal.head() : undefined });
  });

  // Le journal d'audit n'est jamais vidé (chaîne infalsifiable) : vérification à la place.
  r.get('/journal/verify', (req, res) => {
    res.json({ ...journal.verify(), head: journal.head() });
  });

  return r;
}
