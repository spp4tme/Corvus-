// Rembobinage (étape 6) : reconstruit l'état des fichiers surveillés d'un hôte à un instant T à partir
// des événements envoyés par son agent, compare deux instants, et restaure sur demande.
//
// Les contenus sont les copies chiffrées reçues de l'agent (table agent_versions + BlobStore) :
// un ransomware qui chiffrerait l'hôte ne peut pas toucher cet historique.
import { HttpError } from './validate.js';
import { MAX_VERSION_BYTES } from './agents.js';

const FILE_TYPES = ['file.baseline', 'file.created', 'file.modified', 'file.meta', 'file.deleted'];
const MAX_PATHS = 200_000;
const MAX_RESTORE_ITEMS = 200;

const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const same = (a, b) => a && b && a.sha === b.sha && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;

/** Diff par lignes : préfixe/suffixe communs retirés, puis plus longue sous-suite commune sur le milieu. */
export function lineDiff(aText, bText, context = 3) {
  const a = aText === '' ? [] : aText.split('\n');
  const b = bText === '' ? [] : bText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > 4_000_000) return { tooBig: true, hunks: [] };

  // Tableau LCS (longueurs) en UN seul bloc mémoire (≤ 16 Mo) : un tableau par ligne coûtait des
  // centaines de milliers d'objets pour un fichier long face à une ou deux lignes. Puis reconstruction.
  const n = midA.length;
  const m = midB.length;
  const W = m + 1;
  const T = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i * W + j] = midA[i] === midB[j] ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
  const L = (i, j) => T[i * W + j];
  const ops = a.slice(0, start).map((s) => ({ t: ' ', s }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) { ops.push({ t: ' ', s: midA[i] }); i++; j++; }
    else if (i < n && (j === m || L(i + 1, j) >= L(i, j + 1))) { ops.push({ t: '-', s: midA[i++] }); }
    else { ops.push({ t: '+', s: midB[j++] }); }
  }
  for (const s of a.slice(endA)) ops.push({ t: ' ', s });

  // Regroupement en blocs avec `context` lignes autour de chaque changement.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => { if (o.t !== ' ') for (let d = -context; d <= context; d++) if (ops[k + d]) keep[k + d] = true; });
  const hunks = [];
  let cur = null;
  ops.forEach((o, k) => {
    if (!keep[k]) { cur = null; return; }
    if (!cur) { cur = { lines: [] }; hunks.push(cur); }
    cur.lines.push(o);
  });
  return { tooBig: false, hunks, added: ops.filter((o) => o.t === '+').length, removed: ops.filter((o) => o.t === '-').length };
}

export class Rewind {
  constructor({ db, blobs, agents, journal, hosts, alerts }) {
    Object.assign(this, { db, blobs, agents, journal, hosts, alerts });
  }

  /** Événements récents d'un hôte (plus récent d'abord), filtrables par type (préfixe) et par texte. */
  events(hostId, { before, limit = 100, type, q } = {}) {
    const where = ['host_id = ?'];
    const params = [hostId];
    if (type) { where.push('type LIKE ?'); params.push(`${type.replace(/[%_]/g, '')}%`); }
    if (before) { where.push('id < ?'); params.push(before); }
    if (q) { where.push('body LIKE ?'); params.push(`%${String(q).replace(/[%_]/g, '')}%`); }
    params.push(Math.min(limit, 500));
    return this.db.all(`SELECT id, ts, type, body FROM agent_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...params)
      .map((r) => ({ id: r.id, ts: r.ts, type: r.type, body: parse(r.body) }));
  }

  /** État des fichiers à l'instant `at` (ms) : Map chemin → { …métadonnées, deleted, firstType, firstTs }. */
  fileState(hostId, at = Infinity, prefix = '') {
    // Regroupement par chemin DANS SQLite : seuls le premier et le dernier événement de chaque fichier
    // remontent. (Avant : les 200 000 plus ANCIENS événements, ce qui rendait invisibles les changements
    // récents d'un hôte actif — précisément ceux qu'on veut rembobiner.)
    const rows = this.db.all(
      `SELECT e.type, e.ts, e.body, f.type AS first_type, f.ts AS first_ts
       FROM (SELECT json_extract(body, '$.path') AS p, MAX(id) AS last_id, MIN(id) AS first_id
             FROM agent_events WHERE host_id = ? AND type IN (${FILE_TYPES.map(() => '?').join(',')}) AND ts <= ?
             GROUP BY p) g
       JOIN agent_events e ON e.id = g.last_id
       JOIN agent_events f ON f.id = g.first_id
       WHERE typeof(g.p) = 'text' AND g.p <> '' AND substr(g.p, 1, length(?)) = ?
       LIMIT ?`,
      hostId, ...FILE_TYPES, Number.isFinite(at) ? at : 9e15, prefix, prefix, MAX_PATHS,
    );
    const state = new Map();
    for (const r of rows) {
      const b = parse(r.body);
      if (typeof b.path !== 'string' || !b.path) continue;
      state.set(b.path, {
        path: b.path, sha: b.sha ?? null, size: b.size, mode: b.mode, uid: b.uid, gid: b.gid, noContent: !!b.noContent, reason: b.reason || '',
        deleted: r.type === 'file.deleted', ts: r.ts,
        firstType: r.first_type, firstTs: r.first_ts,
      });
    }
    return state;
  }

  /** Différences entre l'instant `at` et maintenant : ce qu'une restauration à `at` changerait. */
  changesSince(hostId, at, prefix = '') {
    const then = this.fileState(hostId, at, prefix);
    const now = this.fileState(hostId, Infinity, prefix);
    const out = [];
    for (const path of new Set([...then.keys(), ...now.keys()])) {
      const t = then.get(path);
      const n = now.get(path);
      const tPresent = t && !t.deleted;
      const nPresent = n && !n.deleted;
      if (tPresent && nPresent) {
        if (same(t, n)) continue;
        out.push(this.#item('restore', path, t, n, t.sha === n.sha ? 'droits' : 'contenu modifié'));
      } else if (tPresent && !nPresent) {
        out.push(this.#item('restore', path, t, n, 'fichier supprimé depuis'));
      } else if (!tPresent && nPresent) {
        // Un fichier absent à T n'est « créé depuis » que si on l'a vu apparaître APRÈS T (pas dans l'état initial).
        const createdAfter = n.firstType === 'file.created' && n.firstTs > at;
        if (createdAfter) out.push(this.#item('remove', path, t, n, 'fichier créé depuis'));
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  #item(action, path, then, now, why) {
    const restorable = action === 'remove' ? !!now && !now.noContent : !!then.sha && !then.noContent && this.#hasVersion(then.sha, then);
    return {
      action, path, why,
      then: then && !then.deleted ? { sha: then.sha, size: then.size, mode: then.mode } : null,
      now: now && !now.deleted ? { sha: now.sha, size: now.size, mode: now.mode } : null,
      restorable: action === 'remove' ? true : restorable,
      blockedReason: action === 'restore' && !restorable ? (then.reason === 'secret' ? 'secret : contenu jamais copié' : then.reason === 'trop-gros' ? 'fichier trop gros pour être versionné' : 'contenu absent de l\'historique') : '',
    };
  }

  #hasVersion(sha) {
    return !!sha;
  }

  versionBuffer(hostId, sha) {
    if (!/^[0-9a-f]{64}$/.test(String(sha))) throw new HttpError(400, 'BAD_SHA', 'Empreinte invalide');
    // Seuls les contenus REÇUS de l'agent de CET hôte sont lisibles (pas n'importe quel blob).
    if (!this.db.get('SELECT 1 AS x FROM agent_versions WHERE host_id = ? AND sha256 = ?', hostId, sha)) throw new HttpError(404, 'VERSION_MISSING', 'Version absente de l\'historique');
    return this.blobs.get(sha);
  }

  diff(hostId, a, b) {
    const get = (sha) => (sha ? this.versionBuffer(hostId, sha) : Buffer.alloc(0));
    const A = get(a);
    const B = get(b);
    if (A.includes(0) || B.includes(0)) return { binary: true, hunks: [] };
    return { binary: false, ...lineDiff(A.toString('utf8'), B.toString('utf8')) };
  }

  /**
   * Restaure `paths` à leur état de l'instant `at`. Le serveur recalcule lui-même ce qu'il faut faire
   * (il ne fait jamais confiance aux empreintes envoyées par le navigateur). Les changements en cours sont
   * relevés par l'agent juste avant, donc l'état actuel est lui aussi dans l'historique (annulation possible).
   */
  async restore(hostId, at, paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_RESTORE_ITEMS) throw new HttpError(400, 'BAD_PATHS', `1 à ${MAX_RESTORE_ITEMS} chemins attendus`);
    const wanted = new Set(paths.map(String));
    const plan = this.changesSince(hostId, at).filter((c) => wanted.has(c.path));
    if (!plan.length) throw new HttpError(409, 'NOTHING_TO_DO', 'Aucune différence à restaurer pour ces chemins');
    // État à T calculé UNE fois (avant : recalculé pour chaque chemin, jusqu'à 200 fois).
    const thenState = this.fileState(hostId, at);
    const results = [];
    for (const c of plan) {
      const res = { path: c.path, action: c.action };
      try {
        if (!c.restorable) throw new HttpError(422, 'NOT_RESTORABLE', c.blockedReason || 'non restaurable');
        if (c.action === 'remove') {
          await this.agents.request(hostId, 'file.remove', { path: c.path });
        } else {
          const buf = this.versionBuffer(hostId, c.then.sha);
          if (buf.length > MAX_VERSION_BYTES) throw new HttpError(422, 'TOO_BIG', 'version trop grosse');
          const meta = thenState.get(c.path);
          await this.agents.request(hostId, 'file.restore', { path: c.path, sha256: c.then.sha, data: buf.toString('base64'), mode: meta.mode, uid: meta.uid, gid: meta.gid });
        }
        res.ok = true;
      } catch (err) {
        res.ok = false;
        res.error = err.message;
        if (err.code === 'AGENT_OFFLINE') { results.push(res); break; }
      }
      results.push(res);
    }
    return results;
  }
}
