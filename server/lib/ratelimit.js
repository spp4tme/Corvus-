// Limiteur de débit des requêtes authentifiées : un seau à jetons PAR COMPTE et un PAR IP, en JavaScript pur.
//
// Pourquoi : un jeton d'API volé ou un script emballé peut saturer le serveur (SSH, SFTP, base SQLite, sauvegardes
// chiffrées). Le plafond est généreux (usage normal de l'interface : très loin du seuil) ; il borne seulement l'abus.
//
// Principe : chaque clé (compte ou IP) a un seau de `capacité` jetons, rechargé de `capacité` par minute. Une requête
// consomme UN jeton dans CHAQUE seau qui la concerne ; si l'un est vide, la requête est refusée (429) et AUCUN jeton
// n'est débité (un seau déjà vide ne vide pas l'autre). Mémoire bornée : au plus `maxKeys` seaux, les plus anciens
// inactifs sont élagués.

const MINUTE = 60_000;

export class TokenBuckets {
  /**
   * @param {{perMinute: number, maxKeys?: number, now?: () => number}} o
   */
  constructor({ perMinute, maxKeys = 10_000, now = Date.now }) {
    if (!Number.isFinite(perMinute) || perMinute < 1) throw new RangeError('perMinute doit être >= 1');
    this.capacity = Math.floor(perMinute);
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map(); // clé → { tokens, at }
  }

  #refilled(key, t) {
    const b = this.buckets.get(key);
    if (!b) return { tokens: this.capacity, at: t };
    const tokens = Math.min(this.capacity, b.tokens + ((t - b.at) * this.capacity) / MINUTE);
    return { tokens, at: t };
  }

  /** ms avant qu'un jeton soit disponible pour `key` (0 = disponible maintenant). Ne débite rien. */
  waitFor(key, t = this.now()) {
    const { tokens } = this.#refilled(key, t);
    if (tokens >= 1) return 0;
    return Math.ceil(((1 - tokens) * MINUTE) / this.capacity);
  }

  /** Débite un jeton sur `key` (à n'appeler qu'après avoir vérifié `waitFor`). */
  spend(key, t = this.now()) {
    const b = this.#refilled(key, t);
    b.tokens -= 1;
    this.buckets.delete(key); // ré-insertion : l'ordre de la Map suit la dernière activité
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) this.#prune(t);
  }

  #prune(t) {
    // 1) seaux de nouveau pleins = clients inactifs : on les oublie sans rien perdre.
    for (const [key] of this.buckets) {
      if (this.buckets.size <= this.maxKeys) return;
      if (this.#refilled(key, t).tokens >= this.capacity) this.buckets.delete(key);
    }
    // 2) toujours trop : on retire les plus anciennement actifs (début de la Map).
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) return;
      this.buckets.delete(key);
    }
  }
}

/**
 * Limiteur de requêtes : portée « globale » (toutes les routes authentifiées) et portée « stricte » (routes
 * coûteuses ou sensibles, ex. sauvegardes), chacune par compte ET par IP.
 */
export class RequestLimiter {
  /**
   * @param {{accountPerMin: number, ipPerMin: number, strictPerMin: number, now?: () => number}} o
   */
  constructor({ accountPerMin, ipPerMin, strictPerMin, now = Date.now }) {
    this.now = now;
    this.account = new TokenBuckets({ perMinute: accountPerMin, now });
    this.ip = new TokenBuckets({ perMinute: ipPerMin, now });
    this.strictAccount = new TokenBuckets({ perMinute: strictPerMin, now });
    this.strictIp = new TokenBuckets({ perMinute: strictPerMin, now });
    this.lastReport = new Map(); // « portée:clé » → ts du dernier signalement (le journal n'est pas inondable)
  }

  /**
   * @param {{accountId?: string|null, ip?: string|null, strict?: boolean}} who
   * @returns {{ok: true} | {ok: false, retryAfterMs: number, scope: 'account'|'ip', strict: boolean}}
   */
  check({ accountId, ip, strict = false }) {
    const t = this.now();
    const lines = [];
    if (accountId) lines.push({ scope: 'account', strict: false, buckets: this.account, key: `a:${accountId}` });
    if (ip) lines.push({ scope: 'ip', strict: false, buckets: this.ip, key: `i:${ip}` });
    if (strict) {
      if (accountId) lines.push({ scope: 'account', strict: true, buckets: this.strictAccount, key: `a:${accountId}` });
      if (ip) lines.push({ scope: 'ip', strict: true, buckets: this.strictIp, key: `i:${ip}` });
    }
    // Vérifier TOUT avant de débiter quoi que ce soit.
    let worst = null;
    for (const l of lines) {
      const wait = l.buckets.waitFor(l.key, t);
      if (wait > 0 && (!worst || wait > worst.wait)) worst = { ...l, wait };
    }
    if (worst) return { ok: false, retryAfterMs: worst.wait, scope: worst.scope, strict: worst.strict };
    for (const l of lines) l.buckets.spend(l.key, t);
    return { ok: true };
  }

  /** Vrai au plus une fois par minute et par (portée, clé) : sert à ne journaliser qu'un dépassement à la fois. */
  shouldReport(scope, strict, key) {
    const t = this.now();
    const id = `${strict ? 's' : 'g'}:${scope}:${key}`;
    const last = this.lastReport.get(id);
    if (last !== undefined && t - last < MINUTE) return false;
    this.lastReport.delete(id);
    this.lastReport.set(id, t);
    if (this.lastReport.size > 10_000) {
      for (const [k, ts] of this.lastReport) { if (t - ts >= MINUTE) this.lastReport.delete(k); else break; }
      while (this.lastReport.size > 10_000) this.lastReport.delete(this.lastReport.keys().next().value);
    }
    return true;
  }
}

/** Les routes sensibles/coûteuses : sauvegardes (création chiffrée, téléchargement, restauration). */
const STRICT_PATHS = [
  /^\/backups(\/|$)/i,
  // Lancer un playbook et l'arrêt d'urgence : coûteux (connexions SSH, exécutions) — même plafond strict que les sauvegardes.
  /^\/automation\/(playbooks\/[^/]+\/run|stop)\/?$/i,
];

/** Forme canonique du chemin avant décision : « // » repliés, comme le fait le routage. */
export function isStrictPath(reqPath) {
  const p = String(reqPath || '').replace(/\/{2,}/g, '/');
  return STRICT_PATHS.some((re) => re.test(p));
}
