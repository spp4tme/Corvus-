// « Partager vers Corvus » : stockage TEMPORAIRE, dans le navigateur, des fichiers reçus du menu Partager (Android,
// ordinateur — la PWA déclare un share_target). Aucune dépendance au DOM : le service worker et la page l'utilisent,
// et les tests le chargent dans une machine virtuelle Node avec de faux `caches`.
//
// Principes :
//   - RIEN n'est envoyé au serveur tant que l'utilisateur n'a pas choisi l'hôte et le dossier (écran « Partager ») ;
//   - chaque dépôt appartient à un compte (`owner`) : un autre compte, sur le même navigateur, ne voit rien ;
//   - tout est borné (nombre, taille, noms) et expire (30 min) ; supprimé dès l'envoi, l'annulation ou la déconnexion.
(function (root) {
  const CACHE = 'corvus-share-v1';
  const PREFIX = '/__share/';
  const MAX_FILES = 20;
  const MAX_TOTAL = 200 * 1024 * 1024;
  const MAX_AGE_MS = 30 * 60 * 1000;
  const ID_RE = /^sh[0-9a-f]{16}$/;

  /** Nom de fichier sûr : pas de chemin, pas de caractères de contrôle, jamais « . » ni « .. », 200 caractères au plus. */
  function safeName(name, fallback) {
    let n = String(name == null ? '' : name).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
    if (!n || n === '.' || n === '..') n = fallback;
    return n;
  }

  /**
   * Qui a le droit de déposer un partage ? Le système (menu Partager : `Sec-Fetch-Site: none`) ou l'application
   * elle-même. Un formulaire caché sur un AUTRE site (`cross-site`) est refusé : sinon il pourrait glisser un fichier
   * dans la liste d'attente de l'utilisateur connecté (le service worker, lui, envoie le cookie de session).
   */
  function sourceAllowed(getHeader, selfOrigin) {
    const site = getHeader('sec-fetch-site');
    if (site) return site === 'none' || site === 'same-origin';
    const origin = getHeader('origin');
    return !origin || origin === selfOrigin;
  }

  function create({ caches, now = () => Date.now(), random = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }, ResponseCtor = Response } = {}) {
    const open = () => caches.open(CACHE);
    const metaKey = (id) => `${PREFIX}${id}/meta`;
    const fileKey = (id, i) => `${PREFIX}${id}/${i}`;
    const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

    async function readMeta(cache, id) {
      const r = await cache.match(metaKey(id));
      if (!r) return null;
      try { return await r.json(); } catch { return null; }
    }

    /** Enregistre un partage reçu (FormData). `owner` : identifiant du compte connecté (obligatoire). */
    async function store(formData, owner) {
      if (!owner || typeof owner !== 'string') throw new Error('Connexion requise');
      const files = [];
      let total = 0;
      for (const v of formData.getAll('files')) {
        if (typeof v === 'string' || v == null || typeof v.size !== 'number') continue;
        if (files.length >= MAX_FILES) throw new Error(`Plus de ${MAX_FILES} fichiers`);
        total += v.size;
        if (total > MAX_TOTAL) throw new Error('Partage trop volumineux (200 Mo au plus)');
        files.push(v);
      }
      const text = String(formData.get('text') || '').slice(0, 20000);
      const url = String(formData.get('url') || '').slice(0, 2000);
      const title = String(formData.get('title') || '').slice(0, 200);
      // Seulement du texte ou une adresse partagés : on en fait un petit fichier texte.
      if (!files.length && (text || url)) {
        const body = [title, text, url].filter(Boolean).join('\n');
        files.push(new Blob([body], { type: 'text/plain' }));
        files[0].__name = 'partage.txt';
      }
      if (!files.length) throw new Error('Rien à partager');
      const cache = await open();
      const id = `sh${hex(random(8))}`;
      const meta = { id, owner, ts: now(), files: [] };
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const name = safeName(f.name || f.__name, `fichier-${i + 1}`);
        meta.files.push({ name, type: String(f.type || 'application/octet-stream').slice(0, 100), size: f.size });
        await cache.put(fileKey(id, i), new ResponseCtor(f, { headers: { 'content-type': 'application/octet-stream' } }));
      }
      await cache.put(metaKey(id), new ResponseCtor(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
      return meta;
    }

    /** Dépôts du compte `owner` (jamais ceux des autres), les plus récents d'abord ; les périmés sont supprimés. */
    async function list(owner) {
      await purge();
      const cache = await open();
      const out = [];
      for (const req of await cache.keys()) {
        const p = new URL(req.url).pathname;
        const m = /^\/__share\/(sh[0-9a-f]{16})\/meta$/.exec(p);
        if (!m) continue;
        const meta = await readMeta(cache, m[1]);
        if (meta && meta.owner === owner) out.push(meta);
      }
      return out.sort((a, b) => b.ts - a.ts);
    }

    /** Contenu d'un fichier d'un dépôt, seulement pour son propriétaire. */
    async function blob(id, index, owner) {
      if (!ID_RE.test(String(id))) return null;
      const cache = await open();
      const meta = await readMeta(cache, id);
      if (!meta || meta.owner !== owner || !Number.isInteger(index) || index < 0 || index >= meta.files.length) return null;
      const r = await cache.match(fileKey(id, index));
      return r ? { blob: await r.blob(), ...meta.files[index] } : null;
    }

    async function drop(cache, id) {
      for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith(`${PREFIX}${id}/`)) await cache.delete(req);
    }

    /** Supprime un dépôt ; avec `owner`, seulement s'il appartient à ce compte. */
    async function remove(id, owner) {
      if (!ID_RE.test(String(id))) return false;
      const cache = await open();
      if (owner !== undefined) { const meta = await readMeta(cache, id); if (!meta || meta.owner !== owner) return false; }
      await drop(cache, id);
      return true;
    }

    /** Supprime les dépôts périmés (ou tous : déconnexion). */
    async function purge({ all = false, owner } = {}) {
      const cache = await open();
      const ids = new Set();
      for (const req of await cache.keys()) { const m = /^\/__share\/(sh[0-9a-f]{16})\//.exec(new URL(req.url).pathname); if (m) ids.add(m[1]); }
      for (const id of ids) {
        const meta = await readMeta(cache, id);
        if (all || !meta || now() - meta.ts > MAX_AGE_MS || (owner && meta.owner === owner)) await drop(cache, id);
      }
    }

    return { store, list, blob, remove, purge };
  }

  root.CorvusShare = { create, safeName, sourceAllowed, MAX_FILES, MAX_TOTAL, MAX_AGE_MS, CACHE };
}(typeof self !== 'undefined' ? self : globalThis));
