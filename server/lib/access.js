// Contrôle d'accès centralisé : UN middleware décide, pour chaque route, du rôle nécessaire.
// Les routes elles-mêmes n'ont donc pas à y penser (et une nouvelle route /hosts/:id/… est
// protégée d'office : lecture → « viewer », écriture → « operator »).
import { HttpError } from './validate.js';
import { Users } from './users.js';

// Insensible à la casse : un identifiant en majuscules est traité comme un identifiant (donc 404), jamais ignoré.
const ID_RE = /^[a-z0-9]{8,32}$/i;
const ANY = '*';

// Routes globales réservées : [méthode, motif, rôle global minimal].
const GLOBAL_RULES = [
  ['POST', /^\/hosts\/?$/i, 'admin'],
  ['POST', /^\/hosts\/test\/?$/i, 'admin'],
  [ANY, /^\/tailscale\//i, 'admin'],
  [ANY, /^\/users(\/|$)/i, 'admin'],
  [ANY, /^\/backups(\/|$)/i, 'admin'],
  [ANY, /^\/system\/(usage|config|restart)\/?$/i, 'admin'],
  ['POST', /^\/services\/?$/i, 'admin'],
  ['DELETE', /^\/services\//i, 'admin'],
  ['POST', /^\/services\/[^/]+\/open\/?$/i, 'operator'],
  ['GET', /^\/journal\/verify\/?$/i, 'admin'],
  ['POST', /^\/alerts\//i, 'operator'],
  [ANY, /^\/exec(\/|$)/i, 'operator'],
  // Copie d'hôte à hôte : opérateur au minimum ; les droits SUR CHAQUE HÔTE sont vérifiés par le service (requireHost).
  [ANY, /^\/fs\/copy(\/|$)/i, 'operator'],
  [ANY, /^\/agents(\/|$)/i, 'admin'],
];

const forbidden = (msg) => new HttpError(403, 'FORBIDDEN', msg);

/** Rôle nécessaire sur un hôte pour `méthode + sous-chemin`. */
export function hostLevel(method, sub, body) {
  // Express route sans tenir compte de la casse (/Admin/… atteint /admin/…) ni du « / » final : on décide sur
  // la forme canonique (minuscules, sans « / » final), sinon une variante contournerait le niveau exigé.
  sub = String(sub || '').toLowerCase().replace(/\/+$/, '');
  const read = method === 'GET' || method === 'HEAD';
  if (!sub) {
    if (read) return 'viewer';
    // Ajouter / retirer un dépôt git de la liste : permis aux opérateurs.
    if (method === 'PATCH' && body && Object.keys(body).length && Object.keys(body).every((k) => k === 'repos')) return 'operator';
    return 'admin';
  }
  if (sub === '/hostkey' && !read) return 'admin';
  if (sub.startsWith('/admin/') && !read) return 'admin';
  if (sub === '/sudoers') return 'admin';
  // Restaurer des fichiers sur un hôte : écriture à distance par l'agent, donc réservé aux administrateurs de l'hôte.
  if (sub === '/rewind/restore') return 'admin';
  // Réglages de l'empreinte du normal (apprentissage, gel automatique) : administrateur de l'hôte.
  if (sub === '/behavior/settings' || sub === '/behavior/restart') return 'admin';
  // Isolement réseau d'un hôte : coupe presque tout le trafic, donc administrateur de l'hôte (lecture de l'état : viewer).
  if (sub === '/isolation' && !read) return 'admin';
  // Lectures qui exposent des informations d'administration de l'hôte : journaux système, règles du pare-feu, comptes
  // de la machine, et contenu des anciennes versions de fichiers (l'agent, root, a pu copier ce que le compte SSH ne lit pas).
  if (read && (sub === '/admin/logs' || sub === '/admin/firewall' || sub === '/admin/users' || sub === '/rewind/diff' || sub.startsWith('/rewind/version/'))) return 'operator';
  // Geler / dégeler / arrêter un processus PAR L'AGENT (root) : plus puissant que le compte SSH d'un opérateur.
  if (sub === '/xray/proc' && !read) return 'admin';
  return read ? 'viewer' : 'operator';
}

/**
 * Seconde barrière, posée dans les routeurs eux-mêmes : même si le middleware d'`accessGuard` était contourné
 * (variante de casse, « / » final, nouvelle route oubliée dans GLOBAL_RULES…), la route refuse. Évalué à chaque
 * requête ; `ctx.requireRole` absent → TypeError → 500 (on échoue fermé, jamais ouvert).
 */
export const roleGuard = (ctx, role) => (req, res, next) => {
  try { ctx.requireRole(req, role); } catch (err) { return next(err); }
  next();
};

/**
 * Seconde barrière GÉNÉRIQUE pour toute route d'hôte (`/hosts/:id/...`), posée dans les routeurs : même si
 * `accessGuard` était contourné, le droit sur l'hôte est revérifié avec le même niveau canonique (`hostLevel`).
 * À monter avec `r.use('/hosts/:id', hostBarrier(ctx))` AVANT les routes du routeur.
 */
export const hostBarrier = (ctx) => (req, res, next) => {
  if (!ID_RE.test(String(req.params.id))) return next();
  try {
    ctx.requireHost(req.user, req.params.id, hostLevel(req.method, String(req.url || '').split('?')[0], req.body));
  } catch (err) { return next(err); }
  next();
};

export function accessGuard(ctx) {
  ctx.requireRole = (req, role) => {
    if (!Users.atLeast(req.user?.role, role)) throw forbidden(role === 'admin' ? 'Réservé aux administrateurs' : 'Action non autorisée en lecture seule');
  };
  /** Rôle de l'utilisateur sur un hôte, ou erreur (404 si l'hôte ne lui est pas accessible). */
  ctx.requireHost = (user, hostId, level = 'viewer') => {
    const host = ctx.hosts.find(hostId);
    const role = host && ctx.users.hostRole(user, host);
    if (!role) throw new HttpError(404, 'NOT_FOUND', 'Hôte introuvable');
    if (!Users.atLeast(role, level)) throw forbidden(level === 'admin' ? 'Réservé aux administrateurs' : 'Lecture seule sur cet hôte');
    return { host, role };
  };

  return (req, res, next) => {
    const m = /^\/hosts\/([^/]+)(\/.*)?$/i.exec(req.path);
    if (m && ID_RE.test(m[1])) {
      try {
        req.hostRole = ctx.requireHost(req.user, m[1], hostLevel(req.method, m[2] || '', req.body)).role;
      } catch (err) { return next(err); }
      return next();
    }
    for (const [method, re, role] of GLOBAL_RULES) {
      if ((method === ANY || method === req.method) && re.test(req.path)) {
        try { ctx.requireRole(req, role); } catch (err) { return next(err); }
        break;
      }
    }
    next();
  };
}
