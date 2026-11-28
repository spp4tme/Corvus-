// Playbooks : /api/automation/… (désactivés par défaut : `automation.enabled`).
//
// Liste de contrôle (CLAUDE.md, « Sécurité », §2) :
//  a. roleGuard dans CE routeur (seconde barrière, insensible à la casse et au « / » final) : viewer (lecture de l'historique),
//     operator (lancer, annuler, arrêt d'urgence, lire les playbooks accessibles), admin (tout le reste) ;
//  b. un opérateur lance un playbook seulement si TOUS ses hôtes cibles lui sont accordés au niveau operator (sinon 404) ;
//  c. règles ajoutées à GLOBAL_RULES (access.js) et STRICT_PATHS (ratelimit.js : lancer coûte cher) ;
//  d. tests : test/second-barrier.test.js, test/accounts.test.js (variantes), test/automation-routes.test.js ;
//  e. journal : qui / quoi / où / résultat, jamais de sortie ni de valeur de secret.
import { Router } from 'express';
import * as v from '../lib/validate.js';
import { HttpError } from '../lib/validate.js';
import { roleGuard } from '../lib/access.js';
import { Users } from '../lib/users.js';

export function automationRoutes(ctx) {
  const r = Router();
  const A = ctx.automation;
  const runs = () => ctx.automationRuns;
  const viewer = roleGuard(ctx, 'viewer');
  const operator = roleGuard(ctx, 'operator');
  const admin = roleGuard(ctx, 'admin');
  const pid = (req) => v.id(req.params.id);
  const needConfirm = (req, what) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', `Confirmation explicite requise (confirm: true) : ${what}`);
  };
  r.use('/automation', viewer); // refuse un rôle inconnu avant tout le reste

  /** Playbook visible par ce compte : admin, ou opérateur accordé sur TOUS les hôtes cibles. */
  const runnable = (user, def) => {
    if (user.role === 'admin') return true;
    const hosts = A.resolveTargets(def);
    return hosts.length > 0 && hosts.every((h) => Users.atLeast(ctx.users.hostRole(user, h), 'operator'));
  };
  const accessible = (req, id) => {
    const def = A.definitionOf(id); // 404 si inconnu
    if (!runnable(req.user, def)) throw new HttpError(404, 'NOT_FOUND', 'Playbook introuvable');
    return def;
  };

  r.get('/automation/state', (req, res) => res.json({
    enabled: A.enabled, active: runs().active.size, maxConcurrentRuns: runs().maxConcurrentRuns,
    ...(req.user.role === 'admin' ? { secrets: A.secretNames() } : {}),
  }));

  r.put('/automation/settings', admin, (req, res) => {
    res.json({ enabled: A.setEnabled(req.body?.enabled, { user: req.user, ip: req.ip }) });
  });

  // Playbooks : l'administrateur voit tout ; un opérateur seulement ceux qu'il peut lancer.
  r.get('/automation/playbooks', operator, (req, res) => {
    const all = A.list();
    res.json({ playbooks: req.user.role === 'admin' ? all : all.filter((p) => runnable(req.user, A.definitionOf(p.id))) });
  });
  r.post('/automation/playbooks', admin, (req, res) => res.status(201).json({ playbook: A.create(req.body, { user: req.user, ip: req.ip }) }));
  r.get('/automation/playbooks/:id', operator, (req, res) => { accessible(req, pid(req)); res.json({ playbook: A.get(pid(req)) }); });
  r.put('/automation/playbooks/:id', admin, (req, res) => res.json({ playbook: A.update(pid(req), req.body, { user: req.user, ip: req.ip }) }));
  r.delete('/automation/playbooks/:id', admin, (req, res) => {
    needConfirm(req, 'le playbook et ses versions seront supprimés (l\'historique d\'exécution est conservé)');
    A.delete(pid(req), { user: req.user, ip: req.ip });
    res.json({ ok: true });
  });
  r.get('/automation/playbooks/:id/versions', admin, (req, res) => res.json({ versions: A.versions(pid(req)) }));
  r.get('/automation/playbooks/:id/diff', admin, (req, res) => {
    const from = v.int(req.query.from, 'from', { min: 1 });
    const to = v.int(req.query.to, 'to', { min: 1 });
    res.json(A.diff(pid(req), from, to));
  });
  r.post('/automation/playbooks/:id/rollback', admin, (req, res) => {
    needConfirm(req, 'une nouvelle version recopiant l\'ancienne sera créée');
    res.json({ playbook: A.rollback(pid(req), v.int(req.body?.version, 'version', { min: 1 }), { user: req.user, ip: req.ip }) });
  });

  // Lancer : opérateur (puis droit « operator » sur chaque hôte cible, vérifié par le gestionnaire). Route coûteuse (STRICT_PATHS).
  r.post('/automation/playbooks/:id/run', operator, async (req, res) => {
    const id = pid(req);
    const out = await runs().start({
      playbookId: id, values: req.body?.values, confirm: req.body?.confirm === true, dry: req.body?.dry === true,
      trigger: 'manual', user: req.user, ip: req.ip, authorize: (h) => ctx.requireHost(req.user, h.id, 'operator'),
    });
    res.status(out.dry ? 200 : 202).json(out);
  });

  // Historique : lisible par un lecteur, limité aux hôtes qu'il voit.
  r.get('/automation/runs', (req, res) => {
    const limit = req.query.limit === undefined ? 50 : v.int(req.query.limit, 'limit', { min: 1, max: 200 });
    const playbookId = req.query.playbook === undefined ? null : v.id(req.query.playbook);
    res.json({ runs: runs().list(req.allowedHostIds(), { limit, playbookId }) });
  });
  r.get('/automation/runs/:id', (req, res) => res.json({ run: runs().get(req.allowedHostIds(), pid(req)) }));
  r.post('/automation/runs/:id/cancel', operator, (req, res) => res.json(runs().cancel(pid(req), { user: req.user, ip: req.ip })));
  // Arrêt d'urgence : stoppe tout ce qui tourne. Sans danger (il n'exécute rien) : un opérateur peut le demander.
  r.post('/automation/stop', operator, (req, res) => res.json(runs().stopAll({ user: req.user, ip: req.ip })));

  // Secrets nommés : noms seulement, jamais les valeurs.
  r.get('/automation/secrets', admin, (req, res) => res.json({ secrets: A.secretNames() }));
  r.put('/automation/secrets/:name', admin, (req, res) => {
    A.setSecret(String(req.params.name), req.body?.value, { user: req.user, ip: req.ip });
    res.json({ ok: true, secrets: A.secretNames() });
  });
  r.delete('/automation/secrets/:name', admin, (req, res) => {
    needConfirm(req, 'les playbooks qui utilisent ce secret ne pourront plus se lancer');
    A.deleteSecret(String(req.params.name), { user: req.user, ip: req.ip });
    res.json({ ok: true, secrets: A.secretNames() });
  });

  return r;
}
