// Playbooks, étape 3 : exécuteur. Module pur (faux `exec`) puis de bout en bout avec le faux sshd et le vrai SshPool.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runPlaybook, buildScript, DEFAULT_LIMITS } from '../server/lib/automation/runner.js';
import { validatePlaybook } from '../server/lib/automation/model.js';
import { HttpError } from '../server/lib/validate.js';
import { startFakeSshd } from './helpers/fake-sshd.js';
import { startCorvus } from './helpers/corvus.js';

const H = (n) => ({ id: `host${String(n).padStart(8, '0')}`, label: `h${n}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const make = (steps, extra = {}) => validatePlaybook({ name: 'T', steps, targets: { hostIds: ['aabbccdd11223344'] }, ...extra }).definition;
const ok = (stdout = '', code = 0, stderr = '') => ({ code, stdout: Buffer.from(stdout), stderr, truncated: false });

describe('exécuteur pur', () => {
  test('succès : étapes dans l\'ordre, statut, code, sortie, événements', async () => {
    const seen = [];
    const events = [];
    const r = await runPlaybook({
      def: make([{ name: 'a', run: 'echo un' }, { name: 'b', run: 'echo deux' }]), values: {}, hosts: [H(1)],
      exec: async (_h, script) => { seen.push(script); return ok(`sortie de ${script}`); }, onEvent: (e) => events.push(e.type),
    });
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(seen, ['echo un', 'echo deux']);
    assert.deepEqual(r.hosts[0].steps.map((s) => [s.idx, s.status, s.code]), [[0, 'ok', 0], [1, 'ok', 0]]);
    assert.match(r.hosts[0].steps[0].output, /sortie de echo un/);
    assert.deepEqual(events, ['host-start', 'step-start', 'step-end', 'step-start', 'step-end', 'host-end']);
  });

  test('échec : la suite est SAUTÉE (pas exécutée) ; continueOnError la laisse partir', async () => {
    const ran = [];
    const exec = async (_h, s) => { ran.push(s); return ok('', s.includes('KO') ? 3 : 0); };
    const r = await runPlaybook({ def: make([{ run: 'KO 1' }, { run: 'après' }]), values: {}, hosts: [H(1)], exec });
    assert.equal(r.status, 'failed');
    assert.deepEqual(ran, ['KO 1']);
    assert.deepEqual(r.hosts[0].steps.map((s) => s.status), ['failed', 'skipped']);
    ran.length = 0;
    const r2 = await runPlaybook({ def: make([{ run: 'KO 1', continueOnError: true }, { run: 'après' }]), values: {}, hosts: [H(1)], exec });
    assert.deepEqual(ran, ['KO 1', 'après']);
    assert.equal(r2.status, 'succeeded', 'un échec toléré ne fait pas échouer le lancement');
  });

  test('DÉLAI : une commande trop longue est marquée « timeout », la suite est sautée', async () => {
    const exec = async () => { throw new HttpError(504, 'EXEC_TIMEOUT', 'trop long'); };
    const r = await runPlaybook({ def: make([{ run: 'sleep 999', timeoutSec: 1 }, { run: 'x' }]), values: {}, hosts: [H(1)], exec });
    assert.deepEqual(r.hosts[0].steps.map((s) => s.status), ['timeout', 'skipped']);
    assert.equal(r.status, 'failed');
  });

  test('le délai demandé est bien transmis à exec, en millisecondes', async () => {
    let got;
    await runPlaybook({ def: make([{ run: 'x', timeoutSec: 12 }]), values: {}, hosts: [H(1)], exec: async (_h, _s, o) => { got = o; return ok(); } });
    assert.equal(got.timeoutMs, 12_000);
    assert.equal(got.maxBytes, DEFAULT_LIMITS.execMaxBytes);
  });

  test('hôte refusé (Windows / agent seul) : « refused », aucune autre commande', async () => {
    const exec = async () => { throw new HttpError(409, 'POSIX_ONLY', 'Windows'); };
    const r = await runPlaybook({ def: make([{ run: 'a' }, { run: 'b' }]), values: {}, hosts: [H(1)], exec });
    assert.deepEqual(r.hosts[0].steps.map((s) => s.status), ['refused', 'skipped']);
  });

  test('erreur inattendue d\'exec : « error », message court, jamais de plantage', async () => {
    const r = await runPlaybook({ def: make([{ run: 'a' }]), values: {}, hosts: [H(1)], exec: async () => { throw new Error('x'.repeat(5000)); } });
    assert.equal(r.hosts[0].steps[0].status, 'error');
    assert.ok(r.hosts[0].steps[0].output.length <= 600);
  });

  test('SORTIE GÉANTE : bornée, coupée proprement, indiquée', async () => {
    const big = 'é'.repeat(500_000);
    const r = await runPlaybook({ def: make([{ run: 'big' }]), values: {}, hosts: [H(1)], exec: async () => ({ code: 0, stdout: Buffer.from(big), stderr: '', truncated: false }), limits: { maxOutputBytes: 1000 } });
    const s = r.hosts[0].steps[0];
    assert.equal(s.truncated, true);
    assert.ok(Buffer.byteLength(s.output) < 1100);
    assert.match(s.output, /tronquée/);
    assert.ok(!s.output.includes('�'), 'aucun caractère UTF-8 coupé en deux');
    const r2 = await runPlaybook({ def: make([{ run: 'x' }]), values: {}, hosts: [H(1)], exec: async () => ({ code: 0, stdout: Buffer.from('ok'), stderr: '', truncated: true }) });
    assert.equal(r2.hosts[0].steps[0].truncated, true, 'troncature signalée par exec elle-même');
  });

  test('stderr conservé après stdout', async () => {
    const r = await runPlaybook({ def: make([{ run: 'x' }]), values: {}, hosts: [H(1)], exec: async () => ok('sortie', 1, 'erreur!') });
    assert.match(r.hosts[0].steps[0].output, /sortie\n\[stderr\]\nerreur!/);
  });

  test('SECRETS : jamais dans la ligne de commande, masqués dans la sortie, même dans stderr', async () => {
    const secret = 'jeton-tres-secret-9876';
    let script; let stdin;
    const r = await runPlaybook({
      def: make([{ run: 'curl -H {{secret.API_TOKEN}} https://x' }]), values: {}, hosts: [H(1)], secrets: { API_TOKEN: secret },
      exec: async (_h, s, o) => { script = s; stdin = o.stdin; return ok(`reçu ${secret}`, 0, `et ${Buffer.from(secret).toString('base64')}`); },
    });
    assert.ok(!script.includes(secret), 'le secret ne doit pas figurer dans le script envoyé');
    assert.match(script, /CORVUS_SECRET_API_TOKEN/);
    assert.equal(stdin, `${secret}\n`);
    const out = r.hosts[0].steps[0].output;
    assert.ok(!out.includes(secret) && !out.includes(Buffer.from(secret).toString('base64')), out);
    assert.match(out, /\*\*\*/);
  });

  test('secret non utilisé : rien sur l\'entrée standard ; plusieurs secrets dans l\'ordre alphabétique', () => {
    assert.deepEqual(buildScript('ls', [], {}), { script: 'ls', stdin: undefined });
    const b = buildScript('echo', ['A_ONE', 'B_TWO'], { A_ONE: 'un-secret', B_TWO: 'deux-secret' });
    assert.equal(b.stdin, 'un-secret\ndeux-secret\n');
    assert.match(b.script, /read -r __cv_0[\s\S]*read -r __cv_1[\s\S]*\necho$/);
  });

  test('étape d\'agent : appel nommé, résultat JSON borné ; sans agent : erreur claire', async () => {
    const calls = [];
    const r = await runPlaybook({ def: make([{ agent: { action: 'xray.live', args: { a: 1 } } }]), values: {}, hosts: [H(1)], exec: async () => ok(), agentCall: async (...a) => { calls.push(a.slice(0, 3)); return { ok: true }; } });
    assert.deepEqual(calls, [[H(1).id, 'xray.live', { a: 1 }]]);
    assert.equal(r.hosts[0].steps[0].status, 'ok');
    const r2 = await runPlaybook({ def: make([{ agent: { action: 'xray.live' } }]), values: {}, hosts: [H(1)], exec: async () => ok() });
    assert.equal(r2.hosts[0].steps[0].status, 'error');
  });

  test('CONCURRENCE BORNÉE : jamais plus de N commandes en vol (globale, par hôte)', async () => {
    let inflight = 0; let peak = 0;
    const exec = async () => { inflight += 1; peak = Math.max(peak, inflight); await sleep(25); inflight -= 1; return ok(); };
    const group = Array.from({ length: 8 }, (_, i) => ({ run: `c${i}` }));
    await runPlaybook({ def: make([{ parallel: group }]), values: {}, hosts: [H(1)], exec, limits: { perHostConcurrency: 2, globalConcurrency: 8 } });
    assert.equal(peak, 2, 'plafond par hôte');
    peak = 0;
    const hosts = Array.from({ length: 6 }, (_, i) => H(i + 1));
    await runPlaybook({ def: make([{ run: 'x' }], { strategy: { hosts: 'parallel', maxParallel: 10 } }), values: {}, hosts, exec, limits: { globalConcurrency: 3 } });
    assert.equal(peak, 3, 'plafond global');
    peak = 0;
    await runPlaybook({ def: make([{ run: 'x' }], { strategy: { hosts: 'parallel', maxParallel: 2 } }), values: {}, hosts, exec, limits: { globalConcurrency: 50 } });
    assert.equal(peak, 2, 'au plus maxParallel hôtes à la fois');
  });

  test('stratégie séquentielle : on S\'ARRÊTE au premier hôte en échec ; parallèle : tous sont tentés', async () => {
    const ran = [];
    const exec = async (h) => { ran.push(h); return ok('', h === H(2).id ? 1 : 0); };
    const hosts = [H(1), H(2), H(3)];
    const r = await runPlaybook({ def: make([{ run: 'x' }]), values: {}, hosts, exec });
    assert.deepEqual(ran, [H(1).id, H(2).id]);
    assert.deepEqual(r.hosts.map((h) => h.status), ['succeeded', 'failed', 'skipped']);
    ran.length = 0;
    const r2 = await runPlaybook({ def: make([{ run: 'x' }], { strategy: { hosts: 'parallel', maxParallel: 3 } }), values: {}, hosts, exec });
    assert.equal(ran.length, 3);
    assert.equal(r2.status, 'failed');
  });

  test('ANNULATION : plus rien ne démarre, la commande en cours reçoit le signal, statut « cancelled »', async () => {
    const ac = new AbortController();
    const started = [];
    const exec = async (h, _s, o) => {
      started.push(h);
      await new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(new HttpError(499, 'EXEC_ABORTED', 'annulée')), { once: true }));
    };
    const p = runPlaybook({ def: make([{ run: 'long' }, { run: 'suite' }]), values: {}, hosts: [H(1), H(2)], exec, signal: ac.signal });
    await sleep(40);
    ac.abort();
    const r = await p;
    assert.equal(r.status, 'cancelled');
    assert.deepEqual(started, [H(1).id], 'le second hôte n\'a jamais démarré');
    assert.deepEqual(r.hosts[0].steps.map((s) => s.status), ['cancelled', 'cancelled']);
    assert.equal(r.hosts[1].status, 'cancelled');
  });

  test('annulation avant le départ', async () => {
    const ac = new AbortController(); ac.abort();
    let called = false;
    const r = await runPlaybook({ def: make([{ run: 'x' }]), values: {}, hosts: [H(1)], exec: async () => { called = true; return ok(); }, signal: ac.signal });
    assert.equal(called, false);
    assert.equal(r.status, 'cancelled');
  });

  test('DÉLAI TOTAL du lancement : tout est interrompu, statut « timeout »', async () => {
    const exec = async (_h, _s, o) => new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(new HttpError(499, 'EXEC_ABORTED', 'x')), { once: true }));
    const r = await runPlaybook({ def: make([{ run: 'long' }]), values: {}, hosts: [H(1)], exec, limits: { runTimeoutMs: 60 } });
    assert.equal(r.status, 'timeout');
    assert.equal(r.hosts[0].steps[0].status, 'timeout');
  });

  test('un observateur d\'événements qui plante ne casse rien', async () => {
    const r = await runPlaybook({ def: make([{ run: 'x' }]), values: {}, hosts: [H(1)], exec: async () => ok(), onEvent: () => { throw new Error('boum'); } });
    assert.equal(r.status, 'succeeded');
  });

  test('les paramètres sont injectés ÉCHAPPÉS dans la commande envoyée', async () => {
    let script;
    const def = validatePlaybook({ name: 'P', params: [{ name: 'f', type: 'string' }], steps: [{ run: 'ls {{f}}' }], targets: { hostIds: ['aabbccdd11223344'] } }).definition;
    await runPlaybook({ def, values: { f: "a'; rm -rf /; '" }, hosts: [H(1)], exec: async (_h, s) => { script = s; return ok(); } });
    assert.equal(script, "ls 'a'\\''; rm -rf /; '\\'''");
  });
});

describe('exécuteur de bout en bout (faux sshd + vrai SshPool)', () => {
  let env; let sshd; let hostId;
  before(async () => {
    sshd = await startFakeSshd();
    env = await startCorvus();
    hostId = env.corvus.ctx.hosts.create({ name: 'Linux', hostname: '127.0.0.1', port: sshd.port, username: sshd.user, authType: 'password', password: sshd.password }).id;
  });
  after(async () => { await env?.close(); await sshd?.close(); });

  const exec = (id, script, o) => env.corvus.ctx.pool.exec(id, script, o);
  const pb = (steps) => validatePlaybook({ name: 'E2E', steps, targets: { hostIds: [hostId] } }).definition;

  test('commande réelle : code de sortie et sortie', async () => {
    const r = await runPlaybook({ def: pb([{ run: 'echo bonjour' }, { run: 'exit 3' }]), values: {}, hosts: [{ id: hostId, label: 'Linux' }], exec });
    assert.deepEqual(r.hosts[0].steps.map((s) => [s.status, s.code]), [['ok', 0], ['failed', 3]]);
    assert.match(r.hosts[0].steps[0].output, /bonjour/);
  });

  test('secret : transmis par l\'entrée standard, utilisable par la commande, masqué dans la sortie', async () => {
    const secret = 'mot-de-passe-e2e-4242';
    const r = await runPlaybook({
      def: pb([{ run: 'printf "valeur=%s longueur=%s\\n" {{secret.DB_PASS}} "${#CORVUS_SECRET_DB_PASS}"' }]), values: {}, hosts: [{ id: hostId, label: 'Linux' }],
      exec, secrets: { DB_PASS: secret },
    });
    const s = r.hosts[0].steps[0];
    assert.equal(s.status, 'ok', s.output);
    assert.ok(!s.output.includes(secret), 'la sortie ne doit jamais contenir le secret');
    assert.match(s.output, /valeur=\*\*\* longueur=21/, 'la commande a bien reçu le secret (21 caractères), puis il est masqué');
    assert.ok(!JSON.stringify(sshd.stats.execs).includes(secret), 'le secret n\'a JAMAIS été dans une ligne de commande envoyée à l\'hôte');
  });

  test('délai réel : une commande qui dépasse son délai est interrompue', async () => {
    const t0 = Date.now();
    const r = await runPlaybook({ def: pb([{ run: 'sleep 20', timeoutSec: 1 }]), values: {}, hosts: [{ id: hostId, label: 'Linux' }], exec });
    assert.equal(r.hosts[0].steps[0].status, 'timeout');
    assert.ok(Date.now() - t0 < 8000);
  });

  test('annulation réelle : la commande distante est interrompue', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runPlaybook({ def: pb([{ run: 'sleep 20' }]), values: {}, hosts: [{ id: hostId, label: 'Linux' }], exec, signal: ac.signal });
    await sleep(600);
    ac.abort();
    const r = await p;
    assert.equal(r.status, 'cancelled');
    assert.ok(Date.now() - t0 < 8000, 'rendue en moins de 8 s (et non 20)');
  });

  test('sortie géante réelle : lue bornée, jamais en entier en mémoire', async () => {
    const r = await runPlaybook({ def: pb([{ run: 'head -c 3000000 /dev/zero | tr "\\0" "a"' }]), values: {}, hosts: [{ id: hostId, label: 'Linux' }], exec, limits: { execMaxBytes: 100_000, maxOutputBytes: 2000 } });
    const s = r.hosts[0].steps[0];
    assert.equal(s.truncated, true);
    assert.ok(Buffer.byteLength(s.output) < 2200);
  });

  test('hôte Windows (réglage de l\'administrateur) : REFUSÉ à l\'exécution même si le playbook existait avant', async () => {
    env.corvus.ctx.hosts.update(hostId, { os: 'windows' });
    try {
      const r = await runPlaybook({ def: pb([{ run: 'echo x' }]), values: {}, hosts: [{ id: hostId, label: 'Linux' }], exec });
      assert.equal(r.hosts[0].steps[0].status, 'refused');
    } finally { env.corvus.ctx.hosts.update(hostId, { os: 'auto' }); }
  });
});
