// Routes : partage de terminal en direct et enregistrements de session.
import { Router } from 'express';
import { HttpError } from '../lib/validate.js';
import * as v from '../lib/validate.js';
import { Users, publicUser } from '../lib/users.js';

export function terminalRoutes(ctx) {
  const r = Router();
  const { terminals, users, recorder, hosts, journal } = ctx;
  const tid = (req) => v.str(req.params.id, 'id', { min: 8, max: 32 });

  r.get('/terminals/shared', (req, res) => res.json({ terminals: terminals.sharedWith(req.user.id) }));

  // Comptes à qui ce terminal peut être montré : ceux qui ont accès à l'hôte.
  r.get('/terminals/:id/share/candidates', (req, res) => {
    const t = terminals.get(tid(req));
    const host = hosts.find(t.hostId);
    const list = users.list().filter((u) => !u.disabled && u.id !== req.user.id).map((u) => ({ id: u.id, username: u.username, role: users.hostRole(users.row(u.id), host) }))
      .filter((u) => u.role);
    res.json({ users: list });
  });

  r.post('/terminals/:id/share', (req, res) => {
    const t = terminals.get(tid(req));
    const mode = v.oneOf(req.body?.mode ?? 'view', ['view', 'control'], 'mode');
    const guestRow = users.row(v.str(req.body?.userId, 'compte', { min: 16, max: 16 }));
    if (!guestRow || guestRow.disabled) throw new HttpError(404, 'NOT_FOUND', 'Compte introuvable');
    const role = users.hostRole(guestRow, hosts.find(t.hostId));
    // Co-piloter = taper dans le shell : il faut au moins le rôle opérateur sur cet hôte.
    if (!Users.atLeast(role, mode === 'control' ? 'operator' : 'viewer')) {
      throw new HttpError(403, 'FORBIDDEN', mode === 'control' ? 'Ce compte n\'est pas opérateur de cet hôte : partage en lecture seule uniquement' : 'Ce compte n\'a pas accès à cet hôte');
    }
    res.json({ terminal: terminals.share(t.id, req.user, publicUser(guestRow), mode) });
  });

  r.delete('/terminals/:id/share/:userId', (req, res) => {
    res.json({ terminal: terminals.unshare(tid(req), req.user, v.str(req.params.userId, 'compte', { min: 16, max: 16 })) });
  });

  // ---------- Enregistrements ----------
  // Un compte non administrateur ne voit que SES sessions (sur les hôtes qui lui restent accessibles).
  r.get('/recordings', (req, res) => {
    const admin = req.user.role === 'admin';
    const hostId = req.query.hostId ? v.id(req.query.hostId) : undefined;
    res.json({ recordings: recorder.list({ userId: admin ? undefined : req.user.id, hostIds: req.allowedHostIds() || undefined, hostId, limit: 200 }) });
  });

  r.get('/recordings/:id', (req, res) => {
    const { row, cast } = recorder.get(tid(req));
    // Comme la liste : ses propres sessions, et seulement sur un hôte qui lui est ENCORE accessible
    // (un accès retiré coupe aussi la relecture de ce qui s'y affichait).
    if (req.user.role !== 'admin' && (row.user_id !== req.user.id || !req.allowedHostIds()?.includes(row.host_id))) throw new HttpError(404, 'NOT_FOUND', 'Enregistrement introuvable');
    journal.add({ type: 'terminal', event: 'replay', host: hosts.find(row.host_id) || undefined, detail: `session ${row.id} de ${row.username || '?'}` });
    res.set({ 'Content-Type': 'application/x-asciicast; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(cast);
  });
  return r;
}
