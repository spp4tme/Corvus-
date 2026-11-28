// Exécuteur de playbooks. Module PUR : il ne connaît ni la base, ni HTTP, ni SSH. Il reçoit `exec` (commande sur un hôte) et `agentCall`
// (action nommée de l'agent) en paramètres, ce qui le rend testable avec de faux hôtes et portable.
//
// Garanties :
//  - concurrence BORNÉE : par hôte (commandes simultanées d'un groupe parallèle) et globale (toutes les commandes en vol) ;
//  - délai maximal PAR commande, et délai maximal pour tout le lancement ;
//  - annulation (AbortSignal) : plus rien ne démarre, les commandes en cours reçoivent KILL ;
//  - sortie BORNÉE (octets lus ET octets conservés) et MASQUÉE (secrets) avant toute conservation ;
//  - les secrets voyagent sur l'ENTRÉE STANDARD, jamais dans la ligne de commande ;
//  - pas de reprise : un échec n'est jamais « rejoué » tout seul.
import { render, scanTemplate, secretEnv } from './params.js';
import { createMasker } from './mask.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxOutputBytes: 64 * 1024, // conservés par commande et par hôte
  execMaxBytes: 1024 * 1024, // lus à distance par commande
  globalConcurrency: 8,
  perHostConcurrency: 2,
  runTimeoutMs: 60 * 60 * 1000,
});

/** Sémaphore minimal (file FIFO). */
class Semaphore {
  constructor(n) { this.n = Math.max(1, n); this.queue = []; }
  async acquire(signal) {
    if (this.n > 0) { this.n -= 1; return; }
    await new Promise((resolve, reject) => {
      const waiter = { resolve };
      this.queue.push(waiter);
      signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) { this.queue.splice(i, 1); reject(new Error('annulé')); }
      }, { once: true });
    });
  }
  release() { const next = this.queue.shift(); if (next) next.resolve(); else this.n += 1; }
}

const isoOk = (r) => r === 'ok';

/** Texte de sortie borné (en octets UTF-8) : retourne le texte et si on a coupé. */
function bound(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1; // ne coupe pas un caractère UTF-8 en deux
  return { text: `${buf.subarray(0, end).toString('utf8')}\n… [sortie tronquée]`, cut: true };
}

/** Script distant : réception des secrets sur l'entrée standard, puis la commande. */
export function buildScript(body, secretNames, secrets) {
  if (!secretNames.length) return { script: body, stdin: undefined };
  const lines = secretNames.map((n, k) => `IFS= read -r __cv_${k} || exit 97\nexport ${secretEnv(n)}="$__cv_${k}"\nunset __cv_${k}`);
  return { script: `${lines.join('\n')}\n${body}`, stdin: `${secretNames.map((n) => secrets[n]).join('\n')}\n` };
}

/**
 * @param {object} o
 * @param {{params: object[], steps: object[], strategy: {hosts: string, maxParallel: number}}} o.def
 * @param {object} o.values valeurs des paramètres (déjà validées)
 * @param {{id: string, label: string}[]} o.hosts
 * @param {(hostId: string, script: string, opts: object) => Promise<{code: number|null, stdout: Buffer, stderr: string, truncated: boolean}>} o.exec
 * @param {(hostId: string, action: string, args: object, timeoutMs: number) => Promise<object>} [o.agentCall]
 * @param {{[name: string]: string}} [o.secrets]
 * @param {AbortSignal} [o.signal]
 * @param {(ev: object) => void} [o.onEvent]
 */
export async function runPlaybook({ def, values, hosts, exec, agentCall, secrets = {}, limits = {}, signal, onEvent = () => {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const mask = createMasker(Object.values(secrets));
  const global = new Semaphore(lim.globalConcurrency);
  // Annulation interne : annulation externe OU délai total du lancement.
  const ctl = new AbortController();
  let reason = null;
  const onExternal = () => { reason ??= 'cancelled'; ctl.abort(); };
  if (signal) { if (signal.aborted) onExternal(); else signal.addEventListener('abort', onExternal, { once: true }); }
  const runTimer = setTimeout(() => { reason ??= 'timeout'; ctl.abort(); }, lim.runTimeoutMs);
  runTimer.unref?.();

  const result = { status: 'succeeded', hosts: [] };
  const emit = (ev) => { try { onEvent(ev); } catch { /* un observateur défaillant ne casse jamais l'exécution */ } };

  /** Une commande sur un hôte. Retourne { status, code, output, truncated, ms }. */
  async function runCommand(host, step, idx) {
    const t0 = Date.now();
    const done = (status, code, text, cut) => {
      const out = bound(mask(text || ''), lim.maxOutputBytes);
      const rec = { idx, name: step.name, status, code: code ?? null, output: out.text, truncated: !!cut || out.cut, ms: Date.now() - t0 };
      emit({ type: 'step-end', hostId: host.id, ...rec });
      return rec;
    };
    if (ctl.signal.aborted) return { idx, name: step.name, status: 'cancelled', code: null, output: '', truncated: false, ms: 0 };
    try { await global.acquire(ctl.signal); } catch { return { idx, name: step.name, status: 'cancelled', code: null, output: '', truncated: false, ms: 0 }; }
    try {
      if (ctl.signal.aborted) return { idx, name: step.name, status: 'cancelled', code: null, output: '', truncated: false, ms: 0 };
      emit({ type: 'step-start', hostId: host.id, idx, name: step.name });
      if (step.agent) {
        if (!agentCall) return done('error', null, 'Aucun agent disponible pour cet hôte');
        const r = await agentCall(host.id, step.agent.action, step.agent.args || {}, step.timeoutSec * 1000);
        return done('ok', 0, JSON.stringify(r ?? {}, null, 2));
      }
      const body = render(step.run, def.params, values);
      const names = scanTemplate(step.run, { allowedParams: def.params.map((p) => p.name) }).secrets;
      const { script, stdin } = buildScript(body, names, secrets);
      const r = await exec(host.id, script, { timeoutMs: step.timeoutSec * 1000, maxBytes: lim.execMaxBytes, stdin, signal: ctl.signal });
      const text = r.stdout.toString('utf8') + (r.stderr ? `${r.stdout.length ? '\n' : ''}[stderr]\n${r.stderr}` : '');
      return done(r.code === 0 ? 'ok' : 'failed', r.code, text, r.truncated);
    } catch (err) {
      if (ctl.signal.aborted && (err?.code === 'EXEC_ABORTED' || reason)) return done(reason === 'timeout' ? 'timeout' : 'cancelled', null, '');
      const status = err?.code === 'EXEC_TIMEOUT' ? 'timeout' : (err?.code === 'POSIX_ONLY' || err?.code === 'AGENT_ONLY' ? 'refused' : 'error');
      return done(status, null, String(err?.message || err).slice(0, 500));
    } finally {
      global.release();
    }
  }

  /** Les étapes d'UN hôte, dans l'ordre ; un groupe `parallel` lance ses commandes ensemble (concurrence par hôte bornée). */
  async function runHost(host) {
    const rec = { id: host.id, label: host.label, status: 'succeeded', steps: [] };
    result.hosts.push(rec);
    emit({ type: 'host-start', hostId: host.id, label: host.label });
    const perHost = new Semaphore(lim.perHostConcurrency);
    let idx = 0;
    let stop = false;
    for (const step of def.steps) {
      const group = step.parallel ? step.parallel : [step];
      const base = idx;
      idx += group.length;
      if (stop || ctl.signal.aborted) {
        group.forEach((s, j) => rec.steps.push({ idx: base + j, name: s.name, status: stop && !ctl.signal.aborted ? 'skipped' : 'cancelled', code: null, output: '', truncated: false, ms: 0 }));
        continue;
      }
      const outs = await Promise.all(group.map(async (s, j) => {
        await perHost.acquire().catch(() => {});
        try { return await runCommand(host, s, base + j); } finally { perHost.release(); }
      }));
      rec.steps.push(...outs);
      const failed = outs.filter((o, j) => !isoOk(o.status) && !(group[j].continueOnError === true));
      if (failed.length && step.continueOnError !== true) stop = true;
      if (outs.some((o) => !isoOk(o.status))) rec.status = rec.status === 'succeeded' ? 'failed' : rec.status;
    }
    if (ctl.signal.aborted && rec.steps.some((s) => s.status === 'cancelled')) rec.status = reason === 'timeout' ? 'timeout' : 'cancelled';
    // Un hôte dont toutes les étapes ont réussi ou ont été tolérées (continueOnError) reste « succeeded ».
    const hardFail = rec.steps.some((s, i) => !isoOk(s.status) && !['skipped', 'cancelled'].includes(s.status) && !flatContinue(def.steps, i));
    if (rec.status === 'failed' && !hardFail) rec.status = 'succeeded';
    emit({ type: 'host-end', hostId: host.id, status: rec.status });
    return rec;
  }

  try {
    if (def.strategy.hosts === 'parallel') {
      const hostSem = new Semaphore(def.strategy.maxParallel);
      await Promise.all(hosts.map(async (h) => {
        await hostSem.acquire(ctl.signal).catch(() => {});
        try {
          if (ctl.signal.aborted) { result.hosts.push({ id: h.id, label: h.label, status: 'cancelled', steps: [] }); return; }
          await runHost(h);
        } finally { hostSem.release(); }
      }));
    } else {
      // Séquentiel : on S'ARRÊTE au premier hôte en échec (déploiement « en rouleau » : on n'abîme pas tout le parc).
      let halted = false;
      for (const h of hosts) {
        if (halted || ctl.signal.aborted) { result.hosts.push({ id: h.id, label: h.label, status: halted && !ctl.signal.aborted ? 'skipped' : 'cancelled', steps: [] }); continue; }
        const r = await runHost(h);
        if (r.status !== 'succeeded') halted = true;
      }
    }
  } finally {
    clearTimeout(runTimer);
    signal?.removeEventListener('abort', onExternal);
  }
  if (reason === 'timeout') result.status = 'timeout';
  else if (reason === 'cancelled') result.status = 'cancelled';
  else if (result.hosts.some((h) => h.status === 'failed' || h.status === 'timeout')) result.status = 'failed';
  return result;
}

/** L'étape (à plat, dans l'ordre des commandes) tolère-t-elle l'échec ? */
function flatContinue(steps, flatIdx) {
  let i = 0;
  for (const s of steps) {
    const group = s.parallel ? s.parallel : [s];
    for (const g of group) {
      if (i === flatIdx) return g.continueOnError === true || s.continueOnError === true;
      i += 1;
    }
  }
  return false;
}
