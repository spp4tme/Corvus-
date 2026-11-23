// Routes Git : /api/hosts/:id/git/*  (le dépôt est passé en paramètre `repo`).
import { Router } from 'express';
import * as v from '../lib/validate.js';

export function gitRoutes({ git }) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);
  const repoOf = (req) => v.remotePath(String(req.query.repo ?? req.body?.repo ?? ''), 'dépôt');

  r.get('/hosts/:id/git/discover', async (req, res) => res.json(await git.discover(hid(req))));
  r.get('/hosts/:id/git/status', async (req, res) => res.json(await git.status(hid(req), repoOf(req))));
  r.get('/hosts/:id/git/branches', async (req, res) => res.json(await git.branches(hid(req), repoOf(req))));

  r.get('/hosts/:id/git/log', async (req, res) => {
    res.json(await git.history(hid(req), repoOf(req), {
      ref: req.query.ref ? v.gitRef(String(req.query.ref)) : undefined,
      skip: v.int(req.query.skip, 'skip', { min: 0, max: 1_000_000, def: 0 }),
      limit: v.int(req.query.limit, 'limit', { min: 1, max: 200, def: 40 }),
    }));
  });

  r.get('/hosts/:id/git/show', async (req, res) => {
    res.json(await git.show(hid(req), repoOf(req), v.sha(String(req.query.sha ?? ''))));
  });

  r.get('/hosts/:id/git/diff', async (req, res) => {
    res.json(await git.diff(hid(req), repoOf(req), v.remotePath(String(req.query.path ?? ''), 'fichier'), {
      staged: v.bool(req.query.staged, false),
      untracked: v.bool(req.query.untracked, false),
    }));
  });

  r.post('/hosts/:id/git/checkout', async (req, res) => {
    res.json(await git.checkout(hid(req), repoOf(req), v.gitRef(req.body?.branch), {
      remote: v.bool(req.body?.remote, false),
      create: v.bool(req.body?.create, false),
    }));
  });

  r.post('/hosts/:id/git/stage', async (req, res) => {
    const repo = repoOf(req);
    if (req.body?.all) return res.json(await git.stageAll(hid(req), repo));
    res.json(await git.stage(hid(req), repo, v.pathList(req.body?.paths)));
  });

  r.post('/hosts/:id/git/unstage', async (req, res) => {
    res.json(await git.unstage(hid(req), repoOf(req), v.pathList(req.body?.paths)));
  });

  r.post('/hosts/:id/git/commit', async (req, res) => {
    const message = v.str(req.body?.message, 'message', { min: 1, max: 10_000 });
    if (!message.trim()) throw v.bad('Message de commit vide');
    res.json(await git.commit(hid(req), repoOf(req), message));
  });

  for (const op of ['pull', 'push', 'fetch']) {
    r.post(`/hosts/:id/git/${op}`, async (req, res) => res.json(await git.remoteOp(hid(req), repoOf(req), op)));
  }
  return r;
}
