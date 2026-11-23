// Routes Claude Code : /api/hosts/:id/claude (diagnostic + sessions tmux), la session elle-même
// s'ouvre par le WebSocket /ws/terminal?claude=1 (voir TerminalManager.create).
import { Router } from 'express';
import * as v from '../lib/validate.js';

export function claudeRoutes({ claude, terminals }) {
  const r = Router();
  const hid = (req) => v.id(req.params.id);

  r.get('/hosts/:id/claude', async (req, res) => {
    const dir = typeof req.query.dir === 'string' ? req.query.dir : undefined;
    res.json(await claude.status(hid(req), { dir }));
  });

  r.delete('/hosts/:id/claude/sessions/:name', async (req, res) => {
    const id = hid(req);
    const name = v.claudeSession(req.params.name);
    await claude.kill(id, name);
    // Ferme les terminaux Corvus encore rattachés à cette session tmux.
    for (const t of terminals.list()) if (t.hostId === id && t.claude === name) terminals.close(t.id);
    res.json({ ok: true });
  });
  return r;
}
