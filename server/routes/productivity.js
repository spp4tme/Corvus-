// Routes de productivité : snippets, exécution sur plusieurs hôtes, historique et suggestions,
// analyse des commandes risquées et mode « annulable ».
import crypto from 'node:crypto';
import { Router } from 'express';
import { HttpError } from '../lib/validate.js';
import * as v from '../lib/validate.js';
import { analyze } from '../lib/risk.js';
import { rankHistory, nextCommands, repeatedSequences, parseShellHistory } from '../lib/predict.js';

const MAX_PARALLEL = 8;

export function productivityRoutes(ctx) {
  const r = Router();
  const { db, journal, hosts, pool, sftp, undo } = ctx;
  const hid = (req) => v.id(req.params.id);
  const command = (x, name = 'commande') => {
    const s = v.str(x, name, { min: 1, max: 4000 });
    if (!s.trim()) throw v.bad(`${name} vide`);
    return s;
  };

  // ---------- Snippets (personnels ; globaux ou propres à un hôte) ----------
  const snippetView = (s) => ({ id: s.id, hostId: s.host_id, name: s.name, command: s.command, description: s.description, updatedAt: s.updated_at });
  r.get('/snippets', (req, res) => {
    const hostId = req.query.hostId ? v.id(req.query.hostId) : null;
    const rows = hostId
      ? db.all('SELECT * FROM snippets WHERE owner_id = ? AND (host_id IS NULL OR host_id = ?) ORDER BY name', req.user.id, hostId)
      : db.all('SELECT * FROM snippets WHERE owner_id = ? ORDER BY name', req.user.id);
    res.json({ snippets: rows.map(snippetView) });
  });
  const parseSnippet = (body, user) => {
    const hostId = body?.hostId ? v.id(body.hostId) : null;
    if (hostId) ctx.requireHost(user, hostId, 'viewer');
    return {
      hostId,
      name: v.str(body?.name, 'nom', { min: 1, max: 80 }).trim(),
      command: command(body?.command),
      description: v.str(body?.description ?? '', 'description', { max: 500 }),
    };
  };
  r.post('/snippets', (req, res) => {
    const s = parseSnippet(req.body, req.user);
    const id = crypto.randomBytes(6).toString('hex');
    db.run('INSERT INTO snippets (id, owner_id, host_id, name, command, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, req.user.id, s.hostId, s.name, s.command, s.description, Date.now(), Date.now());
    res.status(201).json({ snippet: snippetView(db.get('SELECT * FROM snippets WHERE id = ?', id)) });
  });
  r.put('/snippets/:sid', (req, res) => {
    const s = parseSnippet(req.body, req.user);
    const ch = db.run('UPDATE snippets SET host_id = ?, name = ?, command = ?, description = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
      s.hostId, s.name, s.command, s.description, Date.now(), v.str(req.params.sid, 'id', { min: 12, max: 12 }), req.user.id).changes;
    if (!ch) throw new HttpError(404, 'NOT_FOUND', 'Snippet introuvable');
    res.json({ snippet: snippetView(db.get('SELECT * FROM snippets WHERE id = ?', req.params.sid)) });
  });
  r.delete('/snippets/:sid', (req, res) => {
    if (!db.run('DELETE FROM snippets WHERE id = ? AND owner_id = ?', String(req.params.sid), req.user.id).changes) throw new HttpError(404, 'NOT_FOUND', 'Snippet introuvable');
    res.json({ ok: true });
  });

  // ---------- Analyse d'une commande (règles) ----------
  r.post('/commands/analyze', (req, res) => res.json({ analysis: analyze(command(req.body?.command)) }));

  // ---------- Exécution sur plusieurs hôtes, résultats côte à côte ----------
  r.post('/exec', async (req, res) => {
    const cmd = command(req.body?.command);
    if (!Array.isArray(req.body?.hostIds) || !req.body.hostIds.length || req.body.hostIds.length > 50) throw v.bad('Choisissez entre 1 et 50 hôtes');
    const ids = [...new Set(req.body.hostIds.map((x) => v.id(x)))];
    for (const id of ids) ctx.requireHost(req.user, id, 'operator');
    const analysis = analyze(cmd);
    // Commande risquée : confirmation explicite obligatoire (jamais d'exécution « par surprise »).
    if (analysis.level !== 'safe' && req.body?.confirm !== true) {
      return res.status(409).json({ error: { code: 'CONFIRM_REQUIRED', message: 'Commande à risque : confirmation requise', details: { analysis } } });
    }
    const timeoutMs = v.int(req.body?.timeoutSec ?? 60, 'délai', { min: 1, max: 1800 }) * 1000;
    const results = [];
    const run = async (id) => {
      const host = hosts.get(id);
      const started = Date.now();
      try {
        const out = await pool.exec(id, cmd, { timeoutMs, maxBytes: 256 * 1024 });
        results.push({ hostId: id, host: host.name, ok: out.code === 0, code: out.code, stdout: out.stdout.toString('utf8'), stderr: out.stderr, truncated: out.truncated, durationMs: Date.now() - started });
        journal.add({ type: 'exec', event: 'run', host, ok: out.code === 0, detail: `code ${out.code} : ${cmd.slice(0, 200)}` });
      } catch (err) {
        results.push({ hostId: id, host: host.name, ok: false, code: null, error: err.message, durationMs: Date.now() - started });
        journal.add({ type: 'exec', event: 'run', host, ok: false, detail: `${err.message} : ${cmd.slice(0, 200)}` });
      }
      recordHistory(id, req.user, cmd, null, 'exec');
    };
    for (let i = 0; i < ids.length; i += MAX_PARALLEL) await Promise.all(ids.slice(i, i + MAX_PARALLEL).map(run));
    results.sort((a, b) => ids.indexOf(a.hostId) - ids.indexOf(b.hostId));
    res.json({ results, analysis });
  });

  // ---------- Historique et suggestions ----------
  function recordHistory(hostId, user, cmd, cwd, source) {
    db.run('INSERT INTO command_history (host_id, user_id, cwd, command, ts, source) VALUES (?, ?, ?, ?, ?, ?)',
      hostId, user?.id ?? null, cwd ?? null, cmd.slice(0, 2000), Date.now(), source);
  }
  const historyOf = (hostId, userId, cwd) => db.all(
    `SELECT command, ts FROM command_history WHERE host_id = ? AND (user_id = ? OR user_id IS NULL) ${cwd ? 'AND cwd = ?' : ''} ORDER BY ts DESC, id DESC LIMIT 5000`,
    ...(cwd ? [hostId, userId, cwd] : [hostId, userId]),
  ).reverse();

  r.post('/hosts/:id/history', (req, res) => {
    const cwd = req.body?.cwd ? v.remotePath(req.body.cwd, 'dossier') : null;
    recordHistory(hid(req), req.user, command(req.body?.command), cwd, v.oneOf(req.body?.source ?? 'bar', ['bar', 'hook', 'osc'], 'source'));
    res.status(201).json({ ok: true });
  });

  // Reprend l'historique du shell de l'hôte (~/.bash_history, ~/.zsh_history), en lecture seule.
  r.post('/hosts/:id/history/import', async (req, res) => {
    const id = hid(req);
    let imported = 0;
    for (const file of ['~/.bash_history', '~/.zsh_history']) {
      let text;
      try { text = (await sftp.readText(id, file)).content; } catch { continue; }
      const items = parseShellHistory(text).slice(-5000);
      db.tx(() => {
        for (const it of items) db.run('INSERT INTO command_history (host_id, user_id, cwd, command, ts, source) VALUES (?, ?, NULL, ?, ?, ?)', id, req.user.id, it.command, it.ts, 'import');
      });
      imported += items.length;
    }
    journal.add({ type: 'exec', event: 'history-import', host: hosts.get(id), detail: `${imported} commande(s)` });
    res.json({ imported });
  });

  r.get('/hosts/:id/complete', async (req, res) => {
    const id = hid(req);
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix.slice(0, 500) : '';
    const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? v.remotePath(req.query.cwd, 'dossier') : null;
    const prev = [req.query.prev2, req.query.prev1].filter((x) => typeof x === 'string').map((x) => x.slice(0, 500));
    const hist = historyOf(id, req.user.id);
    const out = {
      history: rankHistory(cwd ? historyOf(id, req.user.id, cwd).concat(hist) : hist, prefix, { limit: 8 }),
      next: prefix ? [] : nextCommands(hist, prev),
      paths: [],
    };
    // Complétion de chemin : dernier mot qui ressemble à un chemin → lecture du dossier par SFTP.
    const last = prefix.split(/\s+/).pop() || '';
    if (prefix.includes(' ') && /^(~|\.{1,2}|\/)|\//.test(last)) {
      const slash = last.lastIndexOf('/');
      const dir = slash >= 0 ? last.slice(0, slash + 1) || '/' : '.';
      const base = slash >= 0 ? last.slice(slash + 1) : last;
      try {
        const listing = await sftp.list(id, dir === '.' ? (cwd || '~') : (dir.startsWith('/') || dir.startsWith('~') || !cwd ? dir : `${cwd}/${dir}`));
        out.paths = listing.entries.filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.hidden)).slice(0, 30)
          .map((e) => `${dir === '.' ? '' : dir}${e.name}${e.type === 'dir' || e.target === 'dir' ? '/' : ''}`);
      } catch { /* dossier illisible : pas de suggestion */ }
    }
    res.json(out);
  });

  r.get('/hosts/:id/sequences', (req, res) => {
    res.json({ sequences: repeatedSequences(historyOf(hid(req), req.user.id)) });
  });

  // ---------- Mode « annulable » ----------
  r.post('/hosts/:id/undo/prepare', async (req, res) => {
    const id = hid(req);
    const cmd = command(req.body?.command);
    const cwd = req.body?.cwd ? v.remotePath(req.body.cwd, 'dossier') : undefined;
    res.json(await undo.prepare(id, cmd, { cwd, user: req.user }));
  });
  r.get('/hosts/:id/undo', (req, res) => res.json({ ops: undo.list(hid(req), req.user.role === 'admin' ? null : req.user.id) }));
  r.post('/hosts/:id/undo/:op', async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'CONFIRM_REQUIRED', 'Confirmation explicite requise pour restaurer');
    res.json(await undo.restore(hid(req), v.str(req.params.op, 'opération', { min: 16, max: 16 }), { user: req.user }));
  });

  return r;
}
