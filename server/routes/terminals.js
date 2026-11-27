// Routes : partage de terminal en direct et enregistrements de session.
import { Router } from 'express';
import { HttpError } from '../lib/validate.js';
import * as v from '../lib/validate.js';
import { Users, publicUser } from '../lib/users.js';
import { roleGuard } from '../lib/access.js';
import { SEARCH_MAX_Q } from '../lib/castsearch.js';

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
  // Seconde barrière : un rôle valide est exigé dans le routeur lui-même (le contrôle d'accès propre à chaque
  // enregistrement — ses sessions, ses hôtes — est fait ci-dessous, route par route).
  r.use('/recordings', roleGuard(ctx, 'viewer'));
  const admin = (req) => req.user.role === 'admin';
  // Un compte non administrateur ne voit que SES sessions, et seulement sur un hôte qui lui reste accessible
  // (un accès retiré coupe aussi la relecture, la recherche et l'export de ce qui s'y affichait).
  const visible = (req, row) => admin(req) || (row.user_id === req.user.id && !!req.allowedHostIds()?.includes(row.host_id));
  const scope = (req) => ({ userId: admin(req) ? undefined : req.user.id, hostIds: req.allowedHostIds() || undefined });
  const query = (req) => {
    const q = v.str(req.query.q, 'q', { min: 1, max: SEARCH_MAX_Q });
    if (/[\u0000-\u001f\u007f]/.test(q)) throw v.bad('q : caractères de contrôle interdits');
    return q;
  };
  const owned = (req) => {
    // Même réponse qu'une session inexistante : on ne révèle pas l'existence des sessions des autres.
    let found;
    try { found = recorder.get(tid(req)); } catch { throw new HttpError(404, 'NOT_FOUND', 'Enregistrement introuvable'); }
    if (!visible(req, found.row)) throw new HttpError(404, 'NOT_FOUND', 'Enregistrement introuvable');
    return found;
  };
  const slug = (t) => String(t || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';

  r.get('/recordings', (req, res) => {
    const hostId = req.query.hostId ? v.id(req.query.hostId) : undefined;
    res.json({ recordings: recorder.list({ ...scope(req), hostId, limit: 200 }) });
  });

  // Recherche dans l'ensemble des sessions visibles (déclarée AVANT « /recordings/:id »).
  r.get('/recordings/search', (req, res) => {
    const q = query(req);
    const before = req.query.before ? v.int(req.query.before, 'before', { min: 1 }) : undefined;
    const hostId = req.query.hostId ? v.id(req.query.hostId) : undefined;
    const rows = recorder.rowsFor({ ...scope(req), hostId, before, limit: 500 });
    const { results, scanned, next } = recorder.searchMany(rows, q);
    journal.add({ type: 'terminal', event: 'search', detail: `recherche (${q.length} caractères) dans ${scanned} session(s) : ${results.length} avec résultat` });
    res.json({
      scanned, next,
      results: results.map(({ row, matches, total, capped }) => ({
        id: row.id, hostId: row.host_id, host: row.host_label, user: row.username, title: row.title, startedAt: row.started_at, total, capped, matches,
      })),
    });
  });

  r.get('/recordings/:id/search', (req, res) => {
    const { row, cast } = owned(req);
    const q = query(req);
    const offset = v.int(req.query.offset, 'offset', { min: 0, max: 100000, def: 0 });
    const limit = v.int(req.query.limit, 'limit', { min: 1, max: 200, def: 50 });
    const out = recorder.search(row, cast, q, { offset, limit });
    journal.add({ type: 'terminal', event: 'search', host: hosts.find(row.host_id) || undefined, detail: `session ${row.id} : recherche (${q.length} caractères), ${out.total} occurrence(s)` });
    res.json({ ...out, offset, limit });
  });

  r.get('/recordings/:id/export', (req, res) => {
    const { row, cast } = owned(req);
    journal.add({ type: 'terminal', event: 'export', host: hosts.find(row.host_id) || undefined, detail: `session ${row.id} de ${row.username || '?'} (${cast.length} o)` });
    const day = new Date(row.started_at).toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/x-asciicast; charset=utf-8',
      'Content-Disposition': `attachment; filename="corvus-${slug(row.host_label)}-${day}.cast"`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.send(cast);
  });

  r.get('/recordings/:id', (req, res) => {
    const { row, cast } = owned(req);
    journal.add({ type: 'terminal', event: 'replay', host: hosts.find(row.host_id) || undefined, detail: `session ${row.id} de ${row.username || '?'}` });
    res.set({ 'Content-Type': 'application/x-asciicast; charset=utf-8', 'Cache-Control': 'no-store' });
    res.send(cast);
  });
  return r;
}
