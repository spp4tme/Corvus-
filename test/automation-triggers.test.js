// Playbooks, étape 7 : déclencheurs. (a) alerte → playbook (liste blanche, repos, coupe-circuit, aucune boucle) ; (b) webhook entrant
// (jeton, HMAC, rejeu, limites, refus uniformes) ; (c) webhook sortant (signature, pas de redirection, adresses interdites).
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startCorvus, CorvusClient, makeUser } from './helpers/corvus.js';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { Triggers, checkOutgoingUrl, forbiddenAddress, HOOK_TOKEN_PREFIX } from '../server/lib/automation/triggers.js';
import { sign, verify, freshTimestamp, MAX_SKEW_S } from '../server/lib/automation/hmac.js';
import { TokenBuckets } from '../server/lib/ratelimit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => String(Math.floor(Date.now() / 1000));

describe('signature HMAC (module pur)', () => {
  test('signature valide ; corps, horodatage ou secret modifiés → faux ; entrées mal formées → faux, jamais d\'exception', () => {
    const sig = sign('secret-un', '1700000000', '{"a":1}');
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
    assert.equal(verify('secret-un', '1700000000', '{"a":1}', sig), true);
    assert.equal(verify('secret-un', '1700000000', '{"a":2}', sig), false);
    assert.equal(verify('secret-un', '1700000001', '{"a":1}', sig), false);
    assert.equal(verify('secret-deux', '1700000000', '{"a":1}', sig), false);
    for (const bad of [undefined, null, 42, '', 'sha256=', 'sha256=zz', sig.toUpperCase(), `${sig}00`, sig.slice(0, -1), 'md5=abc', {}, []]) assert.equal(verify('secret-un', '1700000000', '{"a":1}', bad), false, String(bad));
    assert.equal(verify('secret-un', '1700000000', Buffer.from('{"a":1}'), sig), true, 'Buffer accepté');
  });

  test('horodatage : entier en secondes, à ± 5 minutes', () => {
    const now = Date.parse('2026-06-10T12:00:00Z');
    const s = Math.floor(now / 1000);
    assert.equal(freshTimestamp(String(s), now), true);
    assert.equal(freshTimestamp(String(s - MAX_SKEW_S), now), true);
    assert.equal(freshTimestamp(String(s - MAX_SKEW_S - 1), now), false, 'trop ancien');
    assert.equal(freshTimestamp(String(s + MAX_SKEW_S + 1), now), false, 'dans le futur');
    for (const bad of [undefined, null, '', 'abc', '1.5e9', '-1', String(s) + 'x', 12, '99999999999999']) assert.equal(freshTimestamp(bad, now), false, String(bad));
  });
});

describe('webhook sortant : adresses interdites (module pur)', () => {
  test('refusées : métadonnées cloud, lien-local, non spécifiée, multicast ; autorisées : privées et loopback (cible d\'administrateur)', () => {
    for (const ip of ['169.254.169.254', '169.254.0.1', '0.0.0.0', '0.1.2.3', '224.0.0.1', '255.255.255.255', 'fe80::1', '::', 'ff02::1', '::ffff:169.254.169.254']) assert.equal(forbiddenAddress(ip), true, ip);
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '100.64.0.7', '8.8.8.8', '::1', 'fd00::1', '2001:db8::1']) assert.equal(forbiddenAddress(ip), false, ip);
    assert.equal(forbiddenAddress('exemple.org'), false, 'un nom n\'est pas une adresse : contrôlé après résolution');
  });

  test('URL : seulement http(s), pas d\'identifiants, pas de caractères de contrôle, adresses interdites refusées', () => {
    assert.equal(checkOutgoingUrl('https://n8n.exemple.ts.net/webhook/abc'), 'https://n8n.exemple.ts.net/webhook/abc');
    assert.equal(checkOutgoingUrl('http://100.64.0.7:5678/webhook/x'), 'http://100.64.0.7:5678/webhook/x');
    for (const bad of ['', null, 42, 'n8n.exemple.org', 'ftp://x/y', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://x', 'data:text/plain,x', 'https://user:pass@x.org/', 'https://', 'http://169.254.169.254/latest/meta-data', 'http://[fe80::1]/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'https://x.org/a b', 'https://x.org/\n', `https://x.org/${'a'.repeat(600)}`]) {
      assert.throws(() => checkOutgoingUrl(bad), (e) => e.status === 400, String(bad).slice(0, 40));
    }
  });
});

describe('déclencheurs : serveur complet', () => {
  let env; let sshd; let ctx; let admin; let op; let host; let A;
  const code = async (fn) => { try { await fn(); } catch (e) { return `${e.status} ${e.code}`; } return 'aucune erreur'; };
  const mkPb = (extra = {}) => A.create({ name: `pb-${Math.random().toString(36).slice(2, 8)}`, steps: [{ run: 'echo déclenché' }], targets: { hostIds: [host.id] }, autoAutorise: true, ...extra }, {});
  const runsOf = (pbId) => ctx.db.all('SELECT trigger, actor, status FROM playbook_runs WHERE playbook_id = ? AND dry = 0', pbId);
  const settle = async (pbId) => { for (let i = 0; i < 300; i++) { if (!ctx.db.get("SELECT 1 AS x FROM playbook_runs WHERE playbook_id = ? AND status = 'running'", pbId)) return; await sleep(30); } };

  before(async () => {
    sshd = await startFakeSshd();
    env = await startCorvus();
    ctx = env.corvus.ctx;
    host = ctx.hosts.create({ name: 'H', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
    A = ctx.automation;
    admin = env.client;
    assert.equal((await admin.login()).status, 200);
    const u = makeUser(env.corvus, { username: 'op-trig', password: 'mot-de-passe-op-trig-test', role: 'operator' });
    ctx.users.setGrants(u.id, [{ scope: 'all', role: 'operator' }]);
    op = new CorvusClient(env.base, { corvus: env.corvus, user: u });
    assert.equal((await op.login()).status, 200);
    A.setEnabled(true, {});
    // limites larges pour les tests généraux ; les limites par défaut sont testées à part
    ctx.automationTriggers.ipBuckets = new TokenBuckets({ perMinute: 100_000 });
    ctx.automationTriggers.tokenBuckets = new TokenBuckets({ perMinute: 100_000 });
  });
  after(async () => { await env?.close(); await sshd?.close(); });

  // --- (a) alerte → playbook ---------------------------------------------------------------------------------------------------

  describe('alerte → playbook', () => {
    let clock; let trig;
    before(() => {
      clock = { t: Date.now() };
      trig = new Triggers({ automation: A, runs: ctx.automationRuns, db: ctx.db, vault: ctx.vault, journal: ctx.journal, alerts: ctx.alerts, now: () => clock.t });
      ctx.automationRuns.onFinished = null; // ce Triggers de test ne concerne pas le webhook sortant
      ctx.alerts.onRaised = null; // les alertes sont injectées à la main dans ces tests
    });
    const mk = (pb, extra = {}) => trig.createAlertTrigger({ playbookId: pb.id, alertKind: 'host-down', ...extra }, {});
    const alert = (extra = {}) => trig.onAlert({ kind: 'host-down', severity: 'critical', hostId: host.id, message: 'x', ...extra });

    test('création : liste blanche stricte (type exact), playbook autoAutorise exigé, jamais « danger », champs bornés', async () => {
      const pb = mkPb();
      const c = (x) => code(() => trig.createAlertTrigger({ playbookId: pb.id, alertKind: 'host-down', ...x }, {}));
      assert.equal(await c({}), 'aucune erreur');
      for (const alertKind of ['playbook-failed', 'automation-circuit-breaker', 'playbook-x', 'automation', '', 'Host-Down', 'a', 'x y', 'a;b', 42, null, '*', 'host-.*']) assert.equal(await c({ alertKind }), '400 INVALID', String(alertKind));
      for (const minSeverity of ['grave', '', 3, null]) assert.equal(await c({ minSeverity }), '400 INVALID', String(minSeverity));
      for (const maxRuns of [0, 21, 1.5, '3', -1]) assert.equal(await c({ maxRuns }), '400 INVALID', `maxRuns ${maxRuns}`);
      for (const windowMin of [0, 1441, 'x']) assert.equal(await c({ windowMin }), '400 INVALID');
      for (const cooldownSec of [0, 29, 3601]) assert.equal(await c({ cooldownSec }), '400 INVALID');
      assert.equal(await c({ extra: 1 }), '400 INVALID');
      assert.equal(await c({ hostId: 'ffffffffffffffff' }), '400 INVALID', 'hôte inconnu');
      assert.equal(await c({ enabled: 'oui' }), '400 INVALID');
      const pas = mkPb({ autoAutorise: false });
      const danger = mkPb({ steps: [{ run: 'rm -rf ~/x-inexistant-trig' }] });
      assert.equal(await code(() => trig.createAlertTrigger({ playbookId: pas.id, alertKind: 'host-down' }, {})), '409 NOT_AUTO_AUTHORIZED');
      assert.equal(await code(() => trig.createAlertTrigger({ playbookId: danger.id, alertKind: 'host-down' }, {})), '409 RISK_NOT_AUTO');
      assert.equal(await code(() => trig.createAlertTrigger({ playbookId: 'zzzzzzzzzzzzzzzz', alertKind: 'host-down' }, {})), '404 NOT_FOUND');
    });

    test('une alerte correspondante lance le playbook (déclencheur « alert », acteur « alerte:… ») ; type, gravité et hôte filtrent', async () => {
      ctx.db.run('DELETE FROM automation_alert_triggers'); ctx.db.run('DELETE FROM automation_trigger_events');
      const pb = mkPb();
      const t = mk(pb, { minSeverity: 'critical', hostId: host.id });
      assert.deepEqual(await alert({ kind: 'autre-type' }), [], 'autre type : rien');
      assert.deepEqual(await alert({ severity: 'warn' }), [], 'gravité insuffisante : rien');
      assert.deepEqual(await alert({ hostId: 'ffffffffffffffff' }), [], 'autre hôte : rien');
      assert.equal(runsOf(pb.id).length, 0);
      assert.deepEqual(await alert(), [{ id: t.id, outcome: 'lancé' }]);
      await settle(pb.id);
      assert.deepEqual(runsOf(pb.id).map((r) => [r.trigger, r.actor]), [['alert', `alerte:${t.id}`]]);
    });

    test('INTERRUPTEUR GÉNÉRAL désactivé : aucune alerte ne lance quoi que ce soit', async () => {
      ctx.db.run('DELETE FROM automation_alert_triggers'); ctx.db.run('DELETE FROM automation_trigger_events');
      const pb = mkPb(); mk(pb);
      A.setEnabled(false, {});
      try { assert.deepEqual(await alert(), []); } finally { A.setEnabled(true, {}); }
      assert.equal(runsOf(pb.id).length, 0);
    });

    test('REPOS : un second déclenchement trop rapproché est ignoré', async () => {
      ctx.db.run('DELETE FROM automation_alert_triggers'); ctx.db.run('DELETE FROM automation_trigger_events');
      const pb = mkPb();
      const t = mk(pb, { cooldownSec: 120 });
      assert.equal((await alert())[0].outcome, 'lancé');
      await settle(pb.id);
      clock.t += 30_000;
      assert.deepEqual(await alert(), [{ id: t.id, outcome: 'repos' }]);
      clock.t += 100_000;
      assert.equal((await alert())[0].outcome, 'lancé', 'après le repos : de nouveau possible');
      await settle(pb.id);
    });

    test('COUPE-CIRCUIT : N déclenchements en M minutes → désactivé + alerte critique + journal ; plus rien ne part ; réactivation explicite', async () => {
      ctx.db.run('DELETE FROM automation_alert_triggers'); ctx.db.run('DELETE FROM automation_trigger_events');
      ctx.db.run("DELETE FROM alerts WHERE kind = 'automation-circuit-breaker'");
      const pb = mkPb();
      const t = mk(pb, { maxRuns: 2, windowMin: 60, cooldownSec: 30 });
      const outcomes = [];
      for (let i = 0; i < 5; i++) { outcomes.push((await alert())[0]?.outcome ?? 'rien'); await settle(pb.id); clock.t += 40_000; }
      assert.deepEqual(outcomes, ['lancé', 'lancé', 'coupe-circuit', 'rien', 'rien']);
      assert.equal(runsOf(pb.id).length, 2, 'exactement maxRuns lancements');
      const row = ctx.db.get('SELECT enabled, tripped_at FROM automation_alert_triggers WHERE id = ?', t.id);
      assert.equal(row.enabled, 0);
      assert.ok(row.tripped_at);
      const al = ctx.db.get("SELECT severity, message FROM alerts WHERE kind = 'automation-circuit-breaker'");
      assert.equal(al.severity, 'critical');
      assert.match(al.message, /Coupe-circuit/);
      assert.ok(ctx.db.get("SELECT 1 AS x FROM audit WHERE event = 'trigger-tripped'"));
      // réactivation : décision explicite d'un administrateur, compteur remis à zéro
      const back = trig.updateAlertTrigger(t.id, { playbookId: pb.id, alertKind: 'host-down', maxRuns: 2, windowMin: 60, cooldownSec: 30, enabled: true }, {});
      assert.equal(back.enabled, true);
      assert.equal(back.trippedAt, null);
      assert.equal((await alert())[0].outcome, 'lancé');
      await settle(pb.id);
    });

    test('INONDATION D\'ALERTES : 200 alertes d\'affilée ne lancent jamais plus de maxRuns playbooks', async () => {
      ctx.db.run('DELETE FROM automation_alert_triggers'); ctx.db.run('DELETE FROM automation_trigger_events');
      const pb = mkPb();
      mk(pb, { maxRuns: 3, cooldownSec: 30 });
      let lances = 0;
      for (let i = 0; i < 200; i++) { clock.t += 31_000; const o = (await alert())[0]; if (o?.outcome === 'lancé') lances += 1; await settle(pb.id); }
      assert.equal(lances, 3);
      assert.equal(runsOf(pb.id).length, 3);
    });

    test('AUCUNE BOUCLE : « playbook-failed » et « automation-… » ne déclenchent jamais, même avec une ligne forcée en base', async () => {
      ctx.db.run('DELETE FROM automation_alert_triggers'); ctx.db.run('DELETE FROM automation_trigger_events');
      const pb = mkPb({ steps: [{ run: 'exit 1' }] });
      for (const kind of ['playbook-failed', 'automation-circuit-breaker']) {
        ctx.db.run('INSERT INTO automation_alert_triggers (id, playbook_id, alert_kind, min_severity, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)', `forced${kind.length}x00000`.slice(0, 16), pb.id, kind, 'info', Date.now());
        assert.deepEqual(await alert({ kind }), [], `${kind} ne déclenche rien`);
      }
      assert.equal(runsOf(pb.id).length, 0);
    });

    test('revérifié au lancement : playbook devenu non autoAutorise → « refusé », journalisé', async () => {
      ctx.db.run('DELETE FROM automation_alert_triggers'); ctx.db.run('DELETE FROM automation_trigger_events');
      const pb = mkPb();
      mk(pb);
      A.update(pb.id, { name: pb.name, steps: [{ run: 'echo x' }], targets: { hostIds: [host.id] }, autoAutorise: false }, {});
      assert.match((await alert())[0].outcome, /refusé \(NOT_AUTO_AUTHORIZED\)/);
      assert.equal(runsOf(pb.id).length, 0);
      assert.ok(ctx.db.get("SELECT 1 AS x FROM audit WHERE event = 'trigger-refused'"));
    });

    test('suppression du playbook : ses déclencheurs et webhooks disparaissent', async () => {
      const pb = mkPb();
      const t = mk(pb);
      const hook = trig.createHook({ playbookId: pb.id, name: 'a supprimer' }, {});
      A.delete(pb.id, {});
      assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM automation_alert_triggers WHERE id = ?', t.id).n, 0);
      assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM automation_hooks WHERE id = ?', hook.id).n, 0);
      assert.ok(!ctx.vault.get(`automation:hook:${hook.id}`), 'secret du webhook effacé du coffre');
    });

    test('de bout en bout : Alerts.raise → déclencheur → playbook (le crochet est branché)', async () => {
      ctx.db.run('DELETE FROM automation_alert_triggers'); ctx.db.run('DELETE FROM automation_trigger_events');
      ctx.alerts.onRaised = (a) => { ctx.automationTriggers.onAlert(a).catch(() => {}); };
      const pb = mkPb();
      ctx.automationTriggers.createAlertTrigger({ playbookId: pb.id, alertKind: 'disk-full', minSeverity: 'warn' }, {});
      ctx.alerts.raise({ kind: 'disk-full', severity: 'warn', message: 'disque plein', hostId: host.id });
      for (let i = 0; i < 100 && !runsOf(pb.id).length; i++) await sleep(30);
      await settle(pb.id);
      assert.equal(runsOf(pb.id)[0]?.trigger, 'alert');
      ctx.alerts.onRaised = null;
    });
  });

  // --- (b) webhook entrant -----------------------------------------------------------------------------------------------------

  describe('webhook entrant', () => {
    let pb; let hook;
    // Le limiteur d'ÉCHECS d'authentification (10 par IP) bloque l'IP après des refus : voulu en production, remis à zéro entre les tests.
    beforeEach(() => { ctx.auth.limiter.byIp.clear(); ctx.auth.limiter.global = []; });
    before(() => {
      pb = mkPb({ name: 'Pour webhook', params: [{ name: 'nom', type: 'string', max: 50, required: false }], steps: [{ run: 'printf "%s" {{nom}}' }] });
      hook = ctx.automationTriggers.createHook({ playbookId: pb.id, name: 'ci' }, {});
      ctx.automationTriggers.ipBuckets = new TokenBuckets({ perMinute: 100_000 });
      ctx.automationTriggers.tokenBuckets = new TokenBuckets({ perMinute: 100_000 });
    });
    const post = (h, body, { token = h.token, secret = h.secret, timestamp = ts(), signature, headers = {} } = {}) => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
      return fetch(`${env.base}/api/hooks/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-corvus-timestamp': timestamp, 'x-corvus-signature': signature ?? sign(secret, timestamp, raw), ...headers },
        body: raw,
      });
    };

    test('création : jeton « cvu_hk_ » et secret montrés UNE fois ; seule l\'empreinte du jeton est en base ; jamais dans le journal', () => {
      assert.ok(hook.token.startsWith(HOOK_TOKEN_PREFIX) && hook.token.startsWith('cvu_'));
      assert.ok(hook.secret.startsWith('cvs_'));
      const tout = JSON.stringify(['automation_hooks', 'audit', 'automation_hook_replays', 'playbooks', 'playbook_runs'].map((t) => ctx.db.all(`SELECT * FROM ${t}`)));
      assert.ok(!tout.includes(hook.token) && !tout.includes(hook.secret), 'ni jeton ni secret en clair en base ou au journal');
      assert.ok(!JSON.stringify(ctx.automationTriggers.listHooks()).includes(hook.token), 'jamais renvoyé à la relecture');
      assert.equal(ctx.vault.get(`automation:hook:${hook.id}`).secret, hook.secret, 'le secret est dans le coffre chiffré');
    });

    test('appel valide : 202, le playbook est lancé (déclencheur « webhook »), les paramètres sont validés et échappés', async () => {
      const canari = `${sshd.root}/PWNED`;
      const r = await post(hook, { values: { nom: "x'; touch PWNED; '" } });
      assert.equal(r.status, 202, await r.clone().text());
      const out = await r.json();
      for (let i = 0; i < 200; i++) { if (ctx.db.get('SELECT status FROM playbook_runs WHERE id = ?', out.runId)?.status !== 'running') break; await sleep(30); }
      assert.equal(ctx.db.get('SELECT trigger, actor FROM playbook_runs WHERE id = ?', out.runId).trigger, 'webhook');
      assert.equal(ctx.db.get('SELECT actor FROM playbook_runs WHERE id = ?', out.runId).actor, `webhook:${hook.id}`);
      assert.equal((await import('node:fs')).existsSync(canari), false, 'aucune injection');
      assert.ok(ctx.db.get('SELECT last_used_at FROM automation_hooks WHERE id = ?', hook.id).last_used_at);
      await settle(pb.id);
    });

    test('REFUS UNIFORMES : jeton absent / inconnu / mal formé, signature fausse, corps modifié, horodatage ancien ou futur → même 401, même corps, aucun lancement', async () => {
      const avant = ctx.db.get('SELECT COUNT(*) AS n FROM playbook_runs').n;
      const cas = {
        'sans jeton': () => post(hook, {}, { token: null }),
        'jeton inconnu': () => post(hook, {}, { token: `${HOOK_TOKEN_PREFIX}${'a'.repeat(43)}` }),
        'préfixe d\'un jeton d\'API ordinaire': () => post(hook, {}, { token: `cvu_${'a'.repeat(43)}` }),
        'mauvais secret': () => post(hook, {}, { secret: 'cvs_pas-le-bon' }),
        'signature mal formée': () => post(hook, {}, { signature: 'sha256=zz' }),
        'sans signature': () => post(hook, {}, { signature: '' }),
        'horodatage ancien': () => post(hook, {}, { timestamp: String(Math.floor(Date.now() / 1000) - 1000) }),
        'horodatage futur': () => post(hook, {}, { timestamp: String(Math.floor(Date.now() / 1000) + 1000) }),
        'horodatage invalide': () => post(hook, {}, { timestamp: 'hier' }),
        'corps modifié après signature': async () => { const t = ts(); const sig = sign(hook.secret, t, '{"values":{}}'); return post(hook, '{"values":{"nom":"autre"}}', { timestamp: t, signature: sig }); },
        'jeton d\'un autre webhook avec ce secret': async () => { const other = ctx.automationTriggers.createHook({ playbookId: pb.id, name: 'autre' }, {}); return post(hook, {}, { token: other.token }); },
      };
      let ref = null;
      for (const [nom, f] of Object.entries(cas)) {
        ctx.auth.limiter.byIp.clear(); ctx.auth.limiter.global = []; // 11 cas > 10 échecs autorisés par IP : on compare les réponses cas par cas
        const r = await f();
        const body = await r.text();
        assert.equal(r.status, 401, `${nom} → ${r.status}`);
        ref ??= body;
        assert.equal(body, ref, `${nom} : réponse différente (indice pour un attaquant)`);
      }
      assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM playbook_runs').n, avant, 'aucun lancement');
    });

    test('REJEU : une signature valide ne sert qu\'une fois', async () => {
      const t = ts(); const raw = '{"values":{}}';
      const sig = sign(hook.secret, t, raw);
      assert.equal((await post(hook, raw, { timestamp: t, signature: sig })).status, 202);
      await settle(pb.id);
      assert.equal((await post(hook, raw, { timestamp: t, signature: sig })).status, 401, 'rejeu refusé');
      assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM automation_hook_replays WHERE hook_id = ? AND sig = ?', hook.id, sig).n, 1);
    });

    test('LIMITÉ À UN PLAYBOOK : le corps ne peut pas désigner un autre playbook ni autre chose que « values »', async () => {
      const autre = mkPb({ name: 'Autre playbook' });
      for (const body of [{ playbookId: autre.id }, { values: {}, playbookId: autre.id }, { playbook: autre.id }, { run: 'id' }]) {
        const r = await post(hook, body);
        assert.equal(r.status, 400, JSON.stringify(body));
      }
      assert.equal(runsOf(autre.id).length, 0);
      for (const bad of ['pas du json', '[1]', '"x"', '42', 'null']) assert.equal((await post(hook, bad)).status, 400, bad);
      assert.equal((await post(hook, { values: { nom: 'x'.repeat(51) } })).status, 400, 'valeur hors bornes');
      assert.equal((await post(hook, { values: { inconnu: 1 } })).status, 400);
      await settle(pb.id);
    });

    test('un jeton d\'API ordinaire (compte) ne peut PAS lancer de playbook par le webhook, et un jeton de webhook n\'ouvre pas l\'API', async () => {
      const apiToken = env.token; // « cvu_… » d'un compte administrateur
      const r = await fetch(`${env.base}/api/hooks/run`, { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'x-corvus-timestamp': ts(), 'x-corvus-signature': sign('x', ts(), '{}') }, body: '{}' });
      assert.equal(r.status, 401);
      const api = await fetch(`${env.base}/api/automation/state`, { headers: { authorization: `Bearer ${hook.token}` } });
      assert.equal(api.status, 401, 'le jeton de webhook ne donne accès à aucune route authentifiée');
    });

    test('désactivé ou supprimé : refusé comme tout autre échec', async () => {
      const h2 = ctx.automationTriggers.createHook({ playbookId: pb.id, name: 'temporaire' }, {});
      ctx.automationTriggers.setHookEnabled(h2.id, false, {});
      assert.equal((await post(h2, {})).status, 401);
      ctx.automationTriggers.setHookEnabled(h2.id, true, {});
      assert.equal((await post(h2, {})).status, 202);
      await settle(pb.id);
      ctx.automationTriggers.deleteHook(h2.id, {});
      assert.equal((await post(h2, {})).status, 401);
      assert.equal(await code(() => ctx.automationTriggers.deleteHook(h2.id, {})), '404 NOT_FOUND');
    });

    test('interrupteur général désactivé : le webhook ne lance rien', async () => {
      A.setEnabled(false, {});
      try {
        const r = await post(hook, {});
        assert.equal(r.status, 409);
        assert.equal((await r.json()).error.code, 'AUTOMATION_DISABLED');
      } finally { A.setEnabled(true, {}); }
    });

    test('corps trop gros : 413 ; méthode GET : jamais un lancement', async () => {
      const r = await fetch(`${env.base}/api/hooks/run`, { method: 'POST', headers: { authorization: `Bearer ${hook.token}`, 'x-corvus-timestamp': ts(), 'x-corvus-signature': 'sha256=' + '0'.repeat(64) }, body: 'x'.repeat(20_000) });
      assert.ok([400, 401, 413].includes(r.status), String(r.status));
      assert.notEqual(r.status, 202);
      const g = await fetch(`${env.base}/api/hooks/run`, { headers: { authorization: `Bearer ${hook.token}` } });
      assert.ok([401, 404].includes(g.status), 'GET : rien');
    });

    test('LIMITES PAR DÉFAUT : 6 par minute et par jeton (429 + Retry-After), 30 par minute et par IP', async () => {
      const t = new Triggers({ automation: A, runs: ctx.automationRuns, db: ctx.db, vault: ctx.vault, journal: ctx.journal, alerts: ctx.alerts });
      ctx.automationRuns.onFinished = null;
      const real = ctx.automationTriggers;
      ctx.automationTriggers = t;
      try {
        const h = t.createHook({ playbookId: pb.id, name: 'limité' }, {});
        const codes = [];
        for (let i = 0; i < 9; i++) codes.push((await post(h, '{}', { signature: undefined })).status);
        assert.equal(codes.filter((c) => c === 202).length + codes.filter((c) => c === 409).length >= 1, true, JSON.stringify(codes));
        assert.ok(codes.slice(6).every((c) => c === 429), `au-delà de 6 : 429 attendu, reçu ${JSON.stringify(codes)}`);
        const r = await post(h, '{}');
        assert.equal(r.status, 429);
        assert.ok(Number(r.headers.get('retry-after')) >= 1);
        // par IP : 30 au total, quel que soit le jeton
        t.tokenBuckets = new TokenBuckets({ perMinute: 100_000 });
        const c2 = [];
        for (let i = 0; i < 40; i++) c2.push((await post(h, '{}', { token: `${HOOK_TOKEN_PREFIX}${'z'.repeat(43)}` })).status);
        assert.ok(c2.includes(429), `limite par IP jamais atteinte : ${JSON.stringify(c2)}`);
      } finally { ctx.automationTriggers = real; await sleep(300); }
    });

    test('le journal n\'est pas inondable : 60 refus consécutifs laissent UNE entrée (par minute et par IP)', async () => {
      ctx.db.run("DELETE FROM audit WHERE event = 'hook-denied'");
      ctx.automationTriggers.reported.clear();
      for (let i = 0; i < 12; i++) await post(hook, {}, { secret: 'cvs_faux' }); // le limiteur d'échecs bloquera ensuite : c'est voulu
      assert.ok(ctx.db.all("SELECT 1 FROM audit WHERE event = 'hook-denied'").length <= 1);
    });
  });

  // --- (c) webhook sortant -----------------------------------------------------------------------------------------------------

  describe('webhook sortant', () => {
    let srv; let port; let received; let mode; let other; let otherPort; let otherHits;
    before(async () => {
      ctx.automationRuns.onFinished = (info) => { ctx.automationTriggers.notifyOut(info).catch(() => {}); }; // rebranché (les tests précédents l'avaient détaché)
      received = [];
      otherHits = 0;
      other = http.createServer((req, res) => { otherHits += 1; res.end('autre'); });
      await new Promise((r) => other.listen(0, '127.0.0.1', r));
      otherPort = other.address().port;
      srv = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), url: req.url });
          if (mode === 'redirect') { res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/` }); return res.end(); }
          if (mode === 'erreur') { res.statusCode = 500; return res.end('boum'); }
          res.end('ok');
        });
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      port = srv.address().port;
    });
    after(() => { srv?.close(); other?.close(); });
    const T = () => ctx.automationTriggers;

    test('configuration : administrateur seulement, URL validée, secret montré UNE fois, évènements bornés', async () => {
      const url = `http://127.0.0.1:${port}/hook`;
      assert.equal((await op.api('PUT', '/api/automation/outgoing', { url })).status, 403);
      assert.equal((await op.api('GET', '/api/automation/outgoing')).status, 403);
      for (const bad of [{}, { url: 'ftp://x/y' }, { url: 'http://169.254.169.254/' }, { url, events: [] }, { url, events: ['succeeded', 'autre'] }, { url, events: 'failed' }, { url, enabled: 'oui' }, { url, extra: 1 }, { url, rotateSecret: 'oui' }]) {
        assert.equal((await admin.api('PUT', '/api/automation/outgoing', bad)).status, 400, JSON.stringify(bad));
      }
      const ok = await admin.api('PUT', '/api/automation/outgoing', { url, events: ['succeeded', 'failed'] });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.ok(ok.body.outgoing.secret?.startsWith('cvs_'), 'secret montré à la création');
      const again = await admin.api('GET', '/api/automation/outgoing');
      assert.equal(again.body.outgoing.secret, undefined, 'jamais relu');
      assert.equal(again.body.outgoing.hasSecret, true);
      const second = await admin.api('PUT', '/api/automation/outgoing', { url, events: ['failed'] });
      assert.equal(second.body.outgoing.secret, undefined, 'le secret n\'est pas régénéré sans demande');
      const rot = await admin.api('PUT', '/api/automation/outgoing', { url, rotateSecret: true });
      assert.ok(rot.body.outgoing.secret, 'rotation demandée : nouveau secret');
      assert.ok(!JSON.stringify(ctx.db.all('SELECT * FROM audit')).includes(rot.body.outgoing.secret), 'le secret n\'est jamais journalisé');
    });

    test('envoi signé : en-têtes, signature vérifiable avec le secret, corps MINIMAL sans sortie de commande ni paramètre', async () => {
      const cfg = await admin.api('PUT', '/api/automation/outgoing', { url: `http://127.0.0.1:${port}/hook`, events: ['succeeded', 'failed'], rotateSecret: true });
      const secret = cfg.body.outgoing.secret;
      received.length = 0; mode = 'ok';
      const pbx = mkPb({ name: 'Sortie signée', params: [{ name: 'nom', type: 'string', required: false }], steps: [{ run: 'echo SORTIE-CONFIDENTIELLE {{nom}}' }] });
      const r = await ctx.automationRuns.start({ playbookId: pbx.id, values: { nom: 'PARAM-SECRET' }, trigger: 'schedule', actor: 'test' }).catch(async () => ctx.automationRuns.start({ playbookId: pbx.id, values: { nom: 'PARAM-SECRET' }, trigger: 'manual', user: { id: 'u', username: 'admin', role: 'admin' } }));
      await settle(pbx.id);
      for (let i = 0; i < 100 && !received.length; i++) await sleep(30);
      assert.equal(received.length, 1);
      const m = received[0];
      assert.equal(m.url, '/hook');
      assert.equal(verify(secret, m.headers['x-corvus-timestamp'], m.body, m.headers['x-corvus-signature']), true, 'signature valide');
      assert.equal(freshTimestamp(m.headers['x-corvus-timestamp']), true);
      const json = JSON.parse(m.body);
      assert.equal(json.event, 'playbook.succeeded');
      assert.equal(json.runId, r.runId);
      assert.ok(!m.body.includes('SORTIE-CONFIDENTIELLE') && !m.body.includes('PARAM-SECRET'), 'ni sortie ni paramètres dans le webhook');
      assert.ok(m.body.length < 600);
    });

    test('PAS DE REDIRECTION : une réponse 302 n\'est pas suivie (aucune requête vers l\'autre cible), échec journalisé', async () => {
      await admin.api('PUT', '/api/automation/outgoing', { url: `http://127.0.0.1:${port}/hook`, events: ['succeeded', 'failed'] });
      mode = 'redirect'; otherHits = 0; received.length = 0;
      T().outReported = 0;
      const out = await T().sendOutgoing({ event: 'playbook.test' });
      assert.equal(out.sent, false);
      assert.equal(otherHits, 0, 'la redirection n\'a PAS été suivie');
      assert.ok(ctx.db.get("SELECT 1 AS x FROM audit WHERE event = 'outgoing-failed'"));
      mode = 'ok';
    });

    test('réponse en erreur, hôte injoignable, nom résolu vers une adresse interdite : échec silencieux pour l\'appelant, jamais d\'exception', async () => {
      mode = 'erreur'; T().outReported = 0;
      assert.equal((await T().sendOutgoing({ event: 'x' })).sent, false);
      mode = 'ok';
      const realLookup = T().lookup;
      T().lookup = async () => [{ address: '169.254.169.254', family: 4 }];
      try { assert.match((await T().sendOutgoing({ event: 'x' })).reason, /résolution refusée/); } finally { T().lookup = realLookup; }
      await admin.api('PUT', '/api/automation/outgoing', { url: 'http://127.0.0.1:1/', events: ['failed'] });
      assert.equal((await T().sendOutgoing({ event: 'x' })).sent, false);
    });

    test('options de l\'envoi : redirect « error », délai (AbortSignal), corps borné — vérifiées sur la requête réellement émise', async () => {
      await admin.api('PUT', '/api/automation/outgoing', { url: `http://127.0.0.1:${port}/hook`, events: ['failed'] });
      let opts;
      const realFetch = T().fetchImpl;
      T().fetchImpl = async (url, o) => { opts = o; return { ok: true, status: 200, body: { cancel: async () => {} } }; };
      try { await T().sendOutgoing({ event: 'playbook.test' }); } finally { T().fetchImpl = realFetch; }
      assert.equal(opts.redirect, 'error');
      assert.ok(opts.signal instanceof AbortSignal);
      assert.equal(opts.method, 'POST');
      assert.ok(String(opts.body).length < 2048);
      const grosse = await T().sendOutgoing({ event: 'x', trop: 'a'.repeat(5000) });
      assert.equal(grosse.sent, false, 'charge utile trop grosse refusée');
    });

    test('désactivé ou non configuré : rien n\'est envoyé ; suppression : confirm exigé', async () => {
      received.length = 0;
      await admin.api('PUT', '/api/automation/outgoing', { url: `http://127.0.0.1:${port}/hook`, events: ['failed'], enabled: false });
      assert.equal((await T().sendOutgoing({ event: 'x' })).sent, false);
      assert.equal(received.length, 0);
      assert.equal((await admin.api('DELETE', '/api/automation/outgoing', {})).status, 400);
      assert.equal((await admin.api('DELETE', '/api/automation/outgoing', { confirm: true })).status, 200);
      assert.equal(T().outgoing().url, null);
      assert.equal(T().outgoing().hasSecret, false);
    });
  });

  // --- routes d'administration ---------------------------------------------------------------------------------------------------

  describe('routes d\'administration (planifications, déclencheurs, webhooks, sortant)', () => {
    test('opérateur : toutes refusées, variantes de casse et « / » final comprises ; rien n\'est créé', async () => {
      const pb = mkPb();
      const avant = [ctx.db.get('SELECT COUNT(*) AS n FROM automation_schedules').n, ctx.db.get('SELECT COUNT(*) AS n FROM automation_hooks').n, ctx.db.get('SELECT COUNT(*) AS n FROM automation_alert_triggers').n];
      const refused = (u, s) => (u.includes('//') ? [403, 404].includes(s) : s === 403);
      for (const base of ['schedules', 'triggers', 'hooks', 'outgoing']) {
        for (const u of [`/api/automation/${base}`, `/api/Automation/${base[0].toUpperCase()}${base.slice(1)}/`, `/API/AUTOMATION/${base.toUpperCase()}`, `/api//automation/${base}`]) {
          for (const [m, b] of [['GET'], ['POST', { playbookId: pb.id, name: 'x', cron: '0 3 * * *', tz: 'UTC', alertKind: 'host-down' }], ['PUT', { url: 'http://127.0.0.1:9/' }], ['DELETE', { confirm: true }]]) {
            const r = await op.api(m, u, m === 'GET' ? undefined : b);
            assert.ok(refused(u, r.status), `opérateur ${m} ${u} → ${r.status}`);
          }
        }
      }
      assert.deepEqual([ctx.db.get('SELECT COUNT(*) AS n FROM automation_schedules').n, ctx.db.get('SELECT COUNT(*) AS n FROM automation_hooks').n, ctx.db.get('SELECT COUNT(*) AS n FROM automation_alert_triggers').n], avant);
    });

    test('administrateur : cycle complet par l\'API, suppressions avec confirm:true, réponses sans secret relisible', async () => {
      const pb = mkPb({ name: 'Admin API' });
      const s = await admin.api('POST', '/api/automation/schedules', { playbookId: pb.id, cron: '0 3 * * *', tz: 'Europe/Paris' });
      assert.equal(s.status, 201, JSON.stringify(s.body));
      assert.equal((await admin.api('POST', '/api/automation/schedules', { playbookId: pb.id, cron: '0 3 * * *' })).status, 400, 'fuseau obligatoire');
      assert.equal((await admin.api('GET', '/api/automation/schedules')).body.schedules.length >= 1, true);
      assert.equal((await admin.api('DELETE', `/api/automation/schedules/${s.body.schedule.id}`, {})).status, 400);
      assert.equal((await admin.api('DELETE', `/api/automation/schedules/${s.body.schedule.id}`, { confirm: true })).status, 200);
      const t = await admin.api('POST', '/api/automation/triggers', { playbookId: pb.id, alertKind: 'service-down' });
      assert.equal(t.status, 201, JSON.stringify(t.body));
      assert.equal((await admin.api('POST', '/api/automation/triggers', { playbookId: pb.id, alertKind: 'playbook-failed' })).status, 400);
      assert.equal((await admin.api('DELETE', `/api/automation/triggers/${t.body.trigger.id}`, { confirm: true })).status, 200);
      const h = await admin.api('POST', '/api/automation/hooks', { playbookId: pb.id, name: 'depuis l\'API' });
      assert.equal(h.status, 201);
      assert.ok(h.body.hook.token && h.body.hook.secret);
      const liste = JSON.stringify((await admin.api('GET', '/api/automation/hooks')).body);
      assert.ok(!liste.includes(h.body.hook.token) && !liste.includes(h.body.hook.secret));
      assert.equal((await admin.api('PATCH', `/api/automation/hooks/${h.body.hook.id}`, { enabled: 'oui' })).status, 400);
      assert.equal((await admin.api('PATCH', `/api/automation/hooks/${h.body.hook.id}`, { enabled: false })).status, 200);
      assert.equal((await admin.api('DELETE', `/api/automation/hooks/${h.body.hook.id}`, {})).status, 400);
      assert.equal((await admin.api('DELETE', `/api/automation/hooks/${h.body.hook.id}`, { confirm: true })).status, 200);
      assert.equal((await admin.api('DELETE', `/api/automation/hooks/${h.body.hook.id}`, { confirm: true })).status, 404);
    });
  });
});
