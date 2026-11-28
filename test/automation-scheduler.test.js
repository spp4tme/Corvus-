// Playbooks, étape 6 : planificateur (cron + fuseau + fenêtre), sans rattrapage, avec l'interrupteur général.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCorvus } from './helpers/corvus.js';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { Scheduler, GRACE_MS } from '../server/lib/automation/scheduler.js';
import { extraRoutes } from '../server/routes/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.parse('2026-06-10T12:00:00Z');

describe('planificateur', () => {
  let env; let sshd; let ctx; let host; let sched; let clock; let A;
  const code = async (fn) => { try { await fn(); } catch (e) { return `${e.status} ${e.code}`; } return 'aucune erreur'; };
  const mkPb = (extra = {}) => A.create({ name: `pb-${Math.random().toString(36).slice(2, 8)}`, steps: [{ run: 'echo planifié' }], targets: { hostIds: [host.id] }, autoAutorise: true, ...extra }, {});
  const history = (pbId) => ctx.db.all("SELECT trigger, actor, status FROM playbook_runs WHERE playbook_id = ? AND dry = 0", pbId);
  const wait = async (pbId) => { for (let i = 0; i < 200; i++) { if (!ctx.db.get("SELECT 1 AS x FROM playbook_runs WHERE playbook_id = ? AND status = 'running'", pbId)) return; await sleep(30); } };

  before(async () => {
    sshd = await startFakeSshd();
    env = await startCorvus();
    ctx = env.corvus.ctx;
    extraRoutes(ctx); // crée ctx.automationRuns
    host = ctx.hosts.create({ name: 'H', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password });
    A = ctx.automation;
    clock = { t: T0 };
    sched = new Scheduler({ automation: A, runs: ctx.automationRuns, db: ctx.db, journal: ctx.journal, now: () => clock.t });
    ctx.automationRuns.now = () => clock.t;
  });
  after(async () => { await env?.close(); await sshd?.close(); });
  beforeEach(() => { ctx.db.run('DELETE FROM automation_schedules'); clock.t = T0; }); // chaque test part d'une base de planifications vide

  test('création : fuseau OBLIGATOIRE (aucune valeur par défaut), expression et fenêtre validées, playbook autoAutorise exigé', async () => {
    const pb = mkPb();
    const ok = sched.create({ playbookId: pb.id, cron: '0 3 * * *', tz: 'Europe/Paris' });
    assert.equal(ok.enabled, true);
    assert.ok(ok.nextAt > T0, 'prochaine échéance calculée');
    const c = (x) => code(() => sched.create({ playbookId: pb.id, cron: '0 3 * * *', tz: 'Europe/Paris', ...x }));
    assert.equal(await code(() => sched.create({ playbookId: pb.id, cron: '0 3 * * *' })), '400 INVALID_SCHEDULE', 'sans fuseau : refusé');
    for (const tz of ['', 'Paris', 'Europe/Nulle', 'a;b', 42, null]) assert.equal(await c({ tz }), '400 INVALID_SCHEDULE', String(tz));
    for (const cron of ['', '* * * *', '60 * * * *', '@reboot', '* * * * * *', 'x'.repeat(200), 42, null]) assert.equal(await c({ cron }), '400 INVALID_SCHEDULE', String(cron));
    for (const window of [{ from: 'x', to: 'y' }, { from: '02:00', to: '02:00' }, 'nuit', [], { from: '02:00', to: '04:00', extra: 1 }]) assert.equal(await c({ window }), '400 INVALID_SCHEDULE', JSON.stringify(window));
    assert.equal(await c({ extra: 1 }), '400 INVALID_SCHEDULE', 'champ inconnu');
    assert.equal(await c({ enabled: 'oui' }), '400 INVALID_SCHEDULE');
    assert.equal(await code(() => sched.create({ ...{ cron: '0 3 * * *', tz: 'UTC' }, playbookId: 'zzzzzzzzzzzzzzzz' })), '404 NOT_FOUND');
    assert.equal(await code(() => sched.create({ cron: '0 3 * * *', tz: 'UTC', playbookId: '../x' })), '400 INVALID_SCHEDULE');
  });

  test('FRÉQUENCE : pas plus d\'un déclenchement toutes les 5 minutes', async () => {
    const pb = mkPb();
    for (const cron of ['* * * * *', '*/2 * * * *', '0,3 * * * *', '*/4 * * * *']) {
      assert.equal(await code(() => sched.create({ playbookId: pb.id, cron, tz: 'UTC' })), '400 INVALID_SCHEDULE', cron);
    }
    assert.equal(sched.create({ playbookId: pb.id, cron: '*/5 * * * *', tz: 'UTC' }).enabled, true);
  });

  test('AUTO-AUTORISATION : refusée pour un playbook qui ne l\'a pas, ou « danger »', async () => {
    const pas = mkPb({ autoAutorise: false });
    const danger = mkPb({ steps: [{ run: 'rm -rf ~/inexistant-planif' }] });
    assert.equal(await code(() => sched.create({ playbookId: pas.id, cron: '0 3 * * *', tz: 'UTC' })), '409 NOT_AUTO_AUTHORIZED');
    assert.equal(await code(() => sched.create({ playbookId: danger.id, cron: '0 3 * * *', tz: 'UTC' })), '409 RISK_NOT_AUTO');
  });

  test('échéance arrivée : le playbook est lancé (déclencheur « schedule », acteur « planning:… »), la suivante est calculée', async () => {
    A.setEnabled(true, {});
    const pb = mkPb();
    clock.t = T0;
    const s = sched.create({ playbookId: pb.id, cron: '0 14 * * *', tz: 'UTC' }); // prochain : 14:00Z
    clock.t = Date.parse('2026-06-10T14:00:20Z'); // 20 s de retard
    const out = await sched.tick();
    assert.deepEqual(out, [{ id: s.id, outcome: 'lancé' }]);
    await wait(pb.id);
    const runs = history(pb.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, 'schedule');
    assert.equal(runs[0].actor, `planning:${s.id}`);
    const after = sched.get(s.id);
    assert.equal(after.nextAt, Date.parse('2026-06-11T14:00:00Z'), 'prochaine échéance = lendemain');
    assert.equal(after.lastStatus, 'lancé');
    assert.deepEqual(await sched.tick(), [], 'rien à refaire tant que l\'échéance suivante n\'est pas arrivée');
  });

  test('JAMAIS DE RATTRAPAGE : après 3 jours de panne, aucune exécution, une seule décision « manqué », échéance replacée dans le futur', async () => {
    A.setEnabled(true, {});
    const pb = mkPb();
    clock.t = T0;
    const s = sched.create({ playbookId: pb.id, cron: '0 */6 * * *', tz: 'UTC' }); // toutes les 6 h
    clock.t = T0 + 3 * 86_400_000; // 3 jours plus tard : 12 occurrences manquées
    const out = await sched.tick();
    assert.deepEqual(out, [{ id: s.id, outcome: 'manqué' }]);
    assert.equal(history(pb.id).length, 0, 'AUCUN lancement de rattrapage');
    const after = sched.get(s.id);
    assert.ok(after.nextAt > clock.t && after.nextAt - clock.t <= 6 * 3600_000, 'prochaine échéance dans le futur');
    assert.equal(ctx.db.all("SELECT 1 FROM audit WHERE event = 'schedule-missed'").length >= 1, true);
    assert.deepEqual(await sched.tick(), []);
  });

  test('tolérance de retard : lancé si en retard de moins de 2 minutes, manqué au-delà', async () => {
    A.setEnabled(true, {});
    const pb = mkPb();
    clock.t = T0;
    const s = sched.create({ playbookId: pb.id, cron: '0 18 * * *', tz: 'UTC' });
    clock.t = Date.parse('2026-06-10T18:00:00Z') + GRACE_MS - 1000;
    assert.equal((await sched.tick())[0].outcome, 'lancé');
    await wait(pb.id);
    const s2 = sched.create({ playbookId: pb.id, cron: '0 20 * * *', tz: 'UTC' });
    clock.t = Date.parse('2026-06-10T20:00:00Z') + GRACE_MS + 1000;
    assert.equal((await sched.tick()).find((o) => o.id === s2.id).outcome, 'manqué');
    assert.ok(s.id);
  });

  test('INTERRUPTEUR GÉNÉRAL désactivé : rien ne part, et rien n\'est rejoué quand on le réactive', async () => {
    const pb = mkPb();
    clock.t = T0;
    const s = sched.create({ playbookId: pb.id, cron: '0 15 * * *', tz: 'UTC' });
    A.setEnabled(false, {});
    clock.t = Date.parse('2026-06-10T15:00:05Z');
    assert.deepEqual(await sched.tick(), [{ id: s.id, outcome: 'désactivé' }]);
    assert.equal(history(pb.id).length, 0);
    A.setEnabled(true, {});
    clock.t = Date.parse('2026-06-10T15:30:00Z');
    assert.deepEqual(await sched.tick(), [], 'pas de rejeu de l\'échéance passée pendant l\'arrêt');
    assert.equal(history(pb.id).length, 0);
  });

  test('FENÊTRE DE MAINTENANCE : hors fenêtre, rien ne part', async () => {
    A.setEnabled(true, {});
    const pb = mkPb();
    clock.t = T0;
    // tous les jours à 14:00Z, mais seulement entre 02:00 et 04:00 (UTC) : jamais
    const s = sched.create({ playbookId: pb.id, cron: '0 14 * * *', tz: 'UTC', window: { from: '02:00', to: '04:00' } });
    clock.t = Date.parse('2026-06-10T14:00:10Z');
    assert.deepEqual(await sched.tick(), [{ id: s.id, outcome: 'hors fenêtre' }]);
    assert.equal(history(pb.id).length, 0);
    // dans la fenêtre : part
    const s2 = sched.create({ playbookId: pb.id, cron: '30 14 * * *', tz: 'UTC', window: { from: '14:00', to: '15:00' } });
    clock.t = Date.parse('2026-06-10T14:30:10Z');
    assert.equal((await sched.tick()).find((o) => o.id === s2.id).outcome, 'lancé');
    await wait(pb.id);
  });

  test('CHEVAUCHEMENT : un playbook déjà en cours n\'est pas relancé par-dessus', async () => {
    A.setEnabled(true, {});
    const pb = mkPb({ steps: [{ run: 'sleep 3' }] });
    clock.t = T0;
    const s = sched.create({ playbookId: pb.id, cron: '*/5 * * * *', tz: 'UTC' });
    await ctx.automationRuns.start({ playbookId: pb.id, trigger: 'schedule', actor: 'test' });
    clock.t = s.nextAt + 1000;
    assert.deepEqual(await sched.tick(), [{ id: s.id, outcome: 'déjà en cours' }]);
    assert.equal(history(pb.id).length, 1, 'un seul lancement');
    ctx.automationRuns.stopAll({});
    await wait(pb.id);
  });

  test('revérifié à chaque lancement : playbook devenu non autoAutorise, ou hôte devenu Windows → refusé', async () => {
    A.setEnabled(true, {});
    const pb = mkPb();
    clock.t = T0;
    const s = sched.create({ playbookId: pb.id, cron: '0 16 * * *', tz: 'UTC' });
    A.update(pb.id, { name: pb.name, steps: [{ run: 'echo planifié' }], targets: { hostIds: [host.id] }, autoAutorise: false });
    clock.t = Date.parse('2026-06-10T16:00:05Z');
    assert.equal((await sched.tick())[0].outcome, 'refusé (NOT_AUTO_AUTHORIZED)');
    assert.equal(history(pb.id).length, 0);
    // hôte Windows
    const pb2 = mkPb();
    clock.t = T0;
    const s2 = sched.create({ playbookId: pb2.id, cron: '0 17 * * *', tz: 'UTC' });
    ctx.hosts.update(host.id, { os: 'windows' });
    try {
      clock.t = Date.parse('2026-06-10T17:00:05Z');
      assert.equal((await sched.tick()).find((o) => o.id === s2.id).outcome, 'refusé (POSIX_ONLY)');
    } finally { ctx.hosts.update(host.id, { os: 'auto' }); }
    assert.ok(s.id);
  });

  test('l\'échéance avance AVANT le lancement : un échec ne peut pas faire boucler', async () => {
    A.setEnabled(true, {});
    const pb = mkPb();
    clock.t = T0;
    const s = sched.create({ playbookId: pb.id, cron: '0 19 * * *', tz: 'UTC' });
    const saved = ctx.automationRuns.start;
    ctx.automationRuns.start = async () => { throw new Error('boum'); };
    try {
      clock.t = Date.parse('2026-06-10T19:00:05Z');
      assert.equal((await sched.tick())[0].outcome, 'refusé (erreur)');
      assert.deepEqual(await sched.tick(), [], 'pas de nouvelle tentative');
      assert.ok(sched.get(s.id).nextAt > clock.t);
    } finally { ctx.automationRuns.start = saved; }
  });

  test('suppression d\'un playbook : ses planifications disparaissent ; suppression d\'une planification journalisée', async () => {
    const pb = mkPb();
    const s = sched.create({ playbookId: pb.id, cron: '0 5 * * *', tz: 'UTC' });
    A.delete(pb.id, {});
    assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM automation_schedules WHERE id = ?', s.id).n, 0);
    const pb2 = mkPb();
    const s2 = sched.create({ playbookId: pb2.id, cron: '0 5 * * *', tz: 'UTC' });
    sched.delete(s2.id, {});
    assert.equal(await code(() => sched.get(s2.id)), '404 NOT_FOUND');
    assert.ok(ctx.db.get("SELECT 1 AS x FROM audit WHERE event = 'schedule-delete'"));
  });

  test('désactivée ou expression devenue sans échéance : la planification s\'éteint, elle ne boucle pas', async () => {
    A.setEnabled(true, {});
    const pb = mkPb();
    clock.t = T0;
    const s = sched.create({ playbookId: pb.id, cron: '0 5 * * *', tz: 'UTC', enabled: false });
    clock.t = T0 + 86_400_000 * 2;
    assert.deepEqual(await sched.tick(), [], 'une planification désactivée ne part jamais');
    assert.equal(sched.get(s.id).enabled, false);
  });
});
