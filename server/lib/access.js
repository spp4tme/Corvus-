// Contrôle d'accès centralisé : UN middleware décide, pour chaque route, du rôle nécessaire.
// Les routes elles-mêmes n'ont donc pas à y penser (et une nouvelle route /hosts/:id/… est
// protégée d'office : lecture → « viewer », écriture → « operator »).
import { HttpError } from './validate.js';
import { Users } from './users.js';

const ID_RE = /^[a-z0-9]{8,32}$/;
const ANY = '*';

// Routes globales réservées : [méthode, motif, rôle global minimal].
const GLOBAL_RULES = [
  ['POST', /^\/hosts$/, 'admin'],
  ['POST', /^\/hosts\/test$/, 'admin'],
  [ANY, /^\/tailscale\//, 'admin'],
  [ANY, /^\/users(\/|$)/, 'admin'],
  [ANY, /^\/backups(\/|$)/, 'admin'],
  [ANY, /^\/system\/(usage|config|restart)$/, 'admin'],
  ['POST', /^\/services$/, 'admin'],
  ['DELETE', /^\/services\//, 'admin'],
  ['POST', /^\/services\/[^/]+\/open$/, 'operator'],
  ['GET', /^\/journal\/verify$/, 'admin'],
  ['POST', /^\/alerts\//, 'operator'],
  [ANY, /^\/exec(\/|$)/, 'operator'],
  [ANY, /^\/agents(\/|$)/, 'admin'],
];

const forbidden = (msg) => new HttpError(403, 'FORBIDDEN', msg);

/** Rôle nécessaire sur un hôte pour `méthode + sous-chemin`. */
export function hostLevel(method, sub, body) {
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
  return read ? 'viewer' : 'operator';
}

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
    const m = /^\/hosts\/([^/]+)(\/.*)?$/.exec(req.path);
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
