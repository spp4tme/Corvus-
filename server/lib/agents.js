// Agents Corvus (étape 1) : enrôlement par jeton à usage unique et canal WebSocket authentifié
// des deux côtés par des clés Ed25519. Protocole décrit dans docs/protocole-agent.md.
//
// Principes :
//  - l'agent se connecte vers Corvus (aucun port ouvert sur l'hôte) ;
//  - chacun signe un défi aléatoire de l'autre : ni l'agent ni le serveur ne peuvent être usurpés ;
//  - le serveur n'envoie JAMAIS de commande shell : seulement des actions nommées (aucune à ce stade) ;
//  - les événements portent un numéro (`seq`) : un renvoi après coupure est sans effet (idempotent).
import crypto from 'node:crypto';
import { HttpError } from './validate.js';
import { logger } from './log.js';
import { normalizePlatform, platformLabel, agentSupport, unsupportedReason, EXPERIMENTAL_PLATFORMS } from './agent-support.js';

const log = logger('agents');
export const PROTOCOL = 1;
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const ENROLL_TTL_MS = 15 * 60_000;
const METRIC_RE = /^[A-Za-z0-9_.:/-]{1,80}$/;
const MAX_BATCH = 500;
export const MAX_VERSION_BYTES = 512 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;
/** Actions nommées que Corvus peut demander (l'agent les valide à son tour). Jamais de commande shell. */
export const ACTIONS = new Set(['file.restore', 'file.remove', 'preview.run', 'preview.apply', 'xray.live', 'proc.freeze', 'proc.thaw', 'proc.kill', 'net.status', 'net.isolate', 'net.release']);

/** Capacités annoncées par l'agent : objet JSON de taille bornée (le reste est ignoré). */
function capsJson(x) {
  const text = JSON.stringify(x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  return text.length <= 4096 ? text : '{}';
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64 = (buf) => Buffer.from(buf).toString('base64');

/** Clé publique brute (32 octets, base64) → objet clé Node. */
export function publicKeyFromRaw(rawB64) {
  const raw = Buffer.from(String(rawB64), 'base64');
  if (raw.length !== 32) throw new HttpError(400, 'BAD_KEY', 'Clé publique Ed25519 invalide (32 octets attendus)');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
}

/** Texte signé : contexte + rôle + défi, pour qu'une signature ne serve jamais à autre chose. */
export const signedText = (role, challengeB64) => Buffer.from(`corvus-agent-v${PROTOCOL}|${role}|${challengeB64}`);

export class AgentService {
  constructor({ db, vault, journal, hosts, alerts, blobs, offlineAfterSec = 120 }) {
    Object.assign(this, { db, vault, journal, hosts, alerts, blobs, offlineAfterSec });
    this.timer = null;
    this.pendingRequests = new Map(); // id → { resolve, reject, timer, agentId }
    this.connections = new Map(); // agentId → ws
    this.#loadServerKey();
  }

  #loadServerKey() {
    let stored = this.vault.get('agent:server-key');
    if (!stored?.pkcs8) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      stored = { pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
      this.vault.set('agent:server-key', stored);
    }
    this.privateKey = crypto.createPrivateKey({ key: Buffer.from(stored.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
    const spki = crypto.createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' });
    this.publicKeyB64 = b64(spki.subarray(spki.length - 32));
  }

  // --- Enrôlement ---------------------------------------------------------
  /** Jeton à usage unique, valable 15 minutes, lié à un hôte. Retourné une seule fois (seul son hash est conservé). */
  createEnrollment(hostId) {
    const host = this.hosts.find(hostId);
    if (!host) throw new HttpError(404, 'HOST_NOT_FOUND', 'Hôte inconnu');
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ENROLL_TTL_MS;
    this.db.run('DELETE FROM agent_enrollments WHERE expires_at < ? OR used_at IS NOT NULL', Date.now() - 86_400_000);
    this.db.run('INSERT INTO agent_enrollments (token_hash, host_id, expires_at) VALUES (?, ?, ?)', sha256(token), host.id, expiresAt);
    this.journal.add({ type: 'agent', event: 'enroll-token', host, detail: 'jeton d\'enrôlement créé (15 min)' });
    return { token, expiresAt, host: { id: host.id, name: host.name } };
  }

  /** Consomme le jeton (une seule fois, de façon atomique) et enregistre la clé publique de l'agent. */
  enroll({ token, publicKey, version, hostname, capabilities, platform }) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new HttpError(400, 'BAD_TOKEN', 'Jeton invalide');
    publicKeyFromRaw(publicKey); // valide le format
    const agentId = crypto.randomBytes(12).toString('hex');
    const res = this.db.tx(() => {
      const row = this.db.get('SELECT host_id, expires_at, used_at FROM agent_enrollments WHERE token_hash = ?', sha256(token));
      if (!row || row.used_at || row.expires_at < Date.now()) return null;
      this.db.run('UPDATE agent_enrollments SET used_at = ? WHERE token_hash = ?', Date.now(), sha256(token));
      this.db.run(
        'INSERT INTO agents (id, host_id, public_key, version, capabilities, enrolled_at, platform) VALUES (?, ?, ?, ?, ?, ?, ?)',
        agentId, row.host_id, String(publicKey), String(version || '').slice(0, 40), capsJson(capabilities), Date.now(), normalizePlatform(platform),
      );
      return row;
    });
    if (!res) throw new HttpError(403, 'ENROLL_REFUSED', 'Jeton inconnu, expiré ou déjà utilisé');
    const host = this.hosts.find(res.host_id);
    this.journal.add({ type: 'agent', event: 'enrolled', host, user: null, detail: `agent ${agentId} (${String(hostname || '?').slice(0, 60)}) enrôlé` });
    return { agentId, serverPublicKey: this.publicKeyB64, hostId: res.host_id, protocol: PROTOCOL };
  }

  /** Plateforme + fonctions disponibles, calculées depuis ce que l'agent annonce (informatif : voir agent-support.js). */
  #describe(a) {
    const capabilities = safeJson(a.capabilities);
    const platform = normalizePlatform(a.platform);
    return {
      capabilities, platform, platformLabel: platformLabel(platform), experimental: EXPERIMENTAL_PLATFORMS.has(platform),
      support: agentSupport(platform, capabilities),
    };
  }

  list() {
    return this.db.all('SELECT id, host_id AS hostId, version, capabilities, platform, enrolled_at AS enrolledAt, last_seen_at AS lastSeenAt FROM agents ORDER BY enrolled_at')
      .map(({ platform, capabilities, ...a }) => ({ ...a, ...this.#describe({ platform, capabilities }), online: this.connections.has(a.id) }));
  }

  /** Résumé pour la carte d'hôte (null = pas d'agent). */
  forHost(hostId) {
    const a = this.db.get('SELECT id, version, capabilities, platform, last_seen_at AS lastSeenAt FROM agents WHERE host_id = ? ORDER BY enrolled_at DESC LIMIT 1', hostId);
    return a ? { id: a.id, version: a.version, online: this.connections.has(a.id), lastSeenAt: a.lastSeenAt, ...this.#describe(a) } : null;
  }

  /** Alerte quand un agent enrôlé reste déconnecté plus de `offlineAfterSec` (dédoublonnée par `Alerts`). */
  checkOffline() {
    const limit = Date.now() - this.offlineAfterSec * 1000;
    for (const a of this.db.all('SELECT id, host_id, last_seen_at FROM agents WHERE last_seen_at IS NOT NULL AND last_seen_at < ?', limit)) {
      if (this.connections.has(a.id)) continue;
      const host = this.hosts.find(a.host_id);
      const min = Math.round((Date.now() - a.last_seen_at) / 60_000);
      this.alerts?.raise({ kind: 'agent.offline', severity: 'warn', hostId: a.host_id || undefined, message: `Agent de ${host?.name || 'un hôte'} hors ligne depuis ${min} min` });
    }
  }

  start(everySec = 30) { if (!this.timer) { this.timer = setInterval(() => this.checkOffline(), everySec * 1000); this.timer.unref(); } }
  stop() { clearInterval(this.timer); this.timer = null; }

  revoke(id) {
    const row = this.db.get('SELECT id, host_id FROM agents WHERE id = ?', id);
    if (!row) throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent inconnu');
    this.db.run('DELETE FROM agents WHERE id = ?', id);
    this.connections.get(id)?.close(4003, 'révoqué');
    this.journal.add({ type: 'agent', event: 'revoked', host: this.hosts.find(row.host_id), detail: `agent ${id} révoqué` });
  }

  // --- Canal WebSocket ----------------------------------------------------
  /** Gestionnaire de `/agent` (route WebSocket publique : l'authentification est le défi signé). */
  handle(ws, url, req) {
    const send = (type, body = {}, id) => ws.send(JSON.stringify({ v: PROTOCOL, id: id || crypto.randomUUID(), type, ts: Date.now(), body }));
    const fail = (code, msg) => { try { send('error', { code, message: msg }); } catch { /* fermé */ } ws.close(4001, msg.slice(0, 100)); };
    const challenge = b64(crypto.randomBytes(32));
    let agent = null;
    let helloTimer = setTimeout(() => fail('TIMEOUT', 'authentification trop lente'), 10_000);

    send('hello', { challenge, protocol: PROTOCOL });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return fail('BAD_JSON', 'JSON invalide'); }
      if (!msg || msg.v !== PROTOCOL || typeof msg.type !== 'string') return fail('BAD_ENVELOPE', 'enveloppe invalide');
      try {
        if (!agent) return this.#authenticate(msg, challenge, ws, send, fail, (a) => { agent = a; clearTimeout(helloTimer); helloTimer = null; });
        this.#dispatch(agent, msg, send);
      } catch (err) {
        log.warn(`agent ${agent?.id || '?'} : ${err.message}`);
        fail('PROTOCOL', 'message refusé');
      }
    });
    ws.on('close', () => {
      if (helloTimer) clearTimeout(helloTimer);
      if (agent && this.connections.get(agent.id) === ws) {
        this.connections.delete(agent.id);
        this.journal.add({ type: 'agent', event: 'disconnected', host: this.hosts.find(agent.host_id), user: null, ip: req.socket.remoteAddress, detail: `agent ${agent.id} déconnecté` });
      }
    });
  }

  #authenticate(msg, challenge, ws, send, fail, accept) {
    if (msg.type !== 'auth') return fail('NOT_AUTHENTICATED', 'auth attendu');
    const { agentId, signature, challenge: agentChallenge } = msg.body || {};
    const row = typeof agentId === 'string' ? this.db.get('SELECT * FROM agents WHERE id = ?', agentId) : null;
    // Même réponse qu'une signature fausse : on ne révèle pas quels agents existent.
    if (!row || typeof signature !== 'string' || typeof agentChallenge !== 'string' || agentChallenge.length > 100) return fail('AUTH', 'authentification refusée');
    let ok = false;
    try {
      ok = crypto.verify(null, signedText('agent', challenge), publicKeyFromRaw(row.public_key), Buffer.from(signature, 'base64'));
    } catch { ok = false; }
    if (!ok) {
      this.journal.add({ type: 'agent', event: 'auth-failed', host: this.hosts.find(row.host_id), ok: false, detail: `signature invalide pour l'agent ${row.id}` });
      return fail('AUTH', 'authentification refusée');
    }
    // Une seule connexion par agent : la nouvelle remplace l'ancienne (reprise après coupure réseau).
    this.connections.get(row.id)?.close(4002, 'remplacé');
    this.connections.set(row.id, ws);
    this.db.run('UPDATE agents SET last_seen_at = ? WHERE id = ?', Date.now(), row.id);
    accept(row);
    const last = this.db.get('SELECT MAX(agent_seq) AS m FROM agent_events WHERE agent_id = ?', row.id)?.m || 0;
    send('auth_ok', {
      signature: b64(crypto.sign(null, signedText('server', agentChallenge), this.privateKey)),
      lastSeq: last, // l'agent peut purger son tampon jusqu'ici
    });
    this.journal.add({ type: 'agent', event: 'connected', host: this.hosts.find(row.host_id), user: null, detail: `agent ${row.id} connecté` });
  }

  #dispatch(agent, msg, send) {
    const body = msg.body || {};
    switch (msg.type) {
      case 'ping': send('pong', {}, msg.id); break;
      case 'hello_agent': { // version et capacités annoncées après l'authentification
        this.db.run('UPDATE agents SET version = ?, capabilities = ?, platform = ? WHERE id = ?', String(body.version || '').slice(0, 40), capsJson(body.capabilities), normalizePlatform(body.platform), agent.id);
        break;
      }
      case 'events': {
        const items = Array.isArray(body.items) ? body.items.slice(0, MAX_BATCH) : [];
        let upTo = 0;
        this.db.tx(() => {
          for (const e of items) {
            if (!Number.isSafeInteger(e?.seq) || e.seq < 1 || typeof e.type !== 'string' || e.type.length > 60) continue;
            const text = JSON.stringify(e.body ?? {});
            if (text.length > 64_000) continue;
            // UNIQUE (agent_id, agent_seq) : un renvoi après coupure est ignoré sans erreur.
            const ins = this.db.run('INSERT OR IGNORE INTO agent_events (agent_id, host_id, agent_seq, ts, type, body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              agent.id, agent.host_id, e.seq, Number.isFinite(e.ts) ? e.ts : Date.now(), e.type, text, Date.now());
            // Nouveauté seulement : un renvoi après coupure ne doit pas compter deux fois dans l'empreinte du normal.
            if (ins.changes > 0 && this.behavior) {
              try { this.behavior.ingest(agent.host_id, { type: e.type, body: e.body ?? {}, ts: Number.isFinite(e.ts) ? e.ts : Date.now() }); } catch (err) { log.warn(`empreinte : ${err.message}`); }
            }
            upTo = Math.max(upTo, e.seq);
          }
        });
        send('ack', { upTo });
        break;
      }
      case 'version': { // contenu d'un fichier surveillé (copie chiffrée côté serveur)
        const { sha256, data } = body;
        if (!agent.host_id || !SHA_RE.test(String(sha256)) || typeof data !== 'string') throw new Error('version invalide');
        const buf = Buffer.from(data, 'base64');
        if (buf.length > MAX_VERSION_BYTES) throw new Error('version trop grosse');
        if (crypto.createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error('empreinte de version fausse');
        const known = this.db.get('SELECT 1 AS x FROM agent_versions WHERE host_id = ? AND sha256 = ?', agent.host_id, sha256);
        if (!known) {
          this.blobs.put(buf, 'version');
          this.db.run('INSERT OR IGNORE INTO agent_versions (host_id, sha256, size, received_at) VALUES (?, ?, ?, ?)', agent.host_id, sha256, buf.length, Date.now());
        }
        break;
      }
      case 'action_result': {
        const p = this.pendingRequests.get(body.reqId);
        if (p && p.agentId === agent.id) {
          clearTimeout(p.timer);
          this.pendingRequests.delete(body.reqId);
          if (body.ok) p.resolve(body.data ?? {}); else p.reject(new HttpError(422, 'AGENT_REFUSED', `L'agent a refusé : ${String(body.error || 'erreur').slice(0, 200)}`));
        }
        break;
      }
      case 'metrics': {
        if (!agent.host_id) break;
        const ts = Number.isFinite(body.ts) ? body.ts : Date.now();
        const entries = Object.entries(body.values || {}).slice(0, 200);
        this.db.tx(() => {
          for (const [metric, value] of entries) {
            if (!METRIC_RE.test(metric) || typeof value !== 'number' || !Number.isFinite(value)) continue;
            this.db.run('INSERT OR REPLACE INTO metrics_raw (host_id, metric, ts, value) VALUES (?, ?, ?, ?)', agent.host_id, metric, ts, value);
          }
        });
        break;
      }
      default: throw new Error(`type inconnu : ${msg.type}`);
    }
    this.db.run('UPDATE agents SET last_seen_at = ? WHERE id = ?', Date.now(), agent.id);
  }

  /** Envoie une action NOMMÉE à l'agent d'un hôte et attend son résultat (le serveur n'envoie jamais de commande shell). */
  async request(hostId, name, args, timeoutMs = 20_000) {
    if (!ACTIONS.has(name)) throw new HttpError(400, 'BAD_ACTION', 'Action inconnue');
    const row = this.db.get('SELECT id, capabilities, platform FROM agents WHERE host_id = ? ORDER BY enrolled_at DESC LIMIT 1', hostId);
    const ws = row && this.connections.get(row.id);
    if (!ws) throw new HttpError(409, 'AGENT_OFFLINE', 'Aucun agent connecté sur cet hôte');
    // Fonction que cet agent n'annonce pas : refus clair, au lieu d'envoyer l'action et d'échouer chez l'agent.
    // (Confort, pas sécurité : l'agent revalide tout, et ceci ne donne jamais un droit de plus.)
    const why = unsupportedReason(normalizePlatform(row.platform), safeJson(row.capabilities), name);
    if (why) throw new HttpError(409, 'UNSUPPORTED', why);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingRequests.delete(id); reject(new HttpError(504, 'AGENT_TIMEOUT', 'L\'agent n\'a pas répondu')); }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer, agentId: row.id });
      try {
        ws.send(JSON.stringify({ v: PROTOCOL, id, type: 'action', ts: Date.now(), body: { name, args } }));
      } catch {
        // Canal fermé entre-temps : échec immédiat, sans laisser une requête en attente jusqu'au délai.
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new HttpError(409, 'AGENT_OFFLINE', 'Aucun agent connecté sur cet hôte'));
      }
    });
  }

  closeAll() {
    for (const p of this.pendingRequests.values()) { clearTimeout(p.timer); p.reject(new HttpError(503, 'CLOSING', 'Arrêt')); }
    this.pendingRequests.clear();
    for (const ws of this.connections.values()) ws.terminate();
    this.connections.clear();
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
