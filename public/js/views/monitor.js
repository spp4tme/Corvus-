// Vue Supervision : CPU, RAM, disque, réseau, uptime, load (relevé toutes les 3 s),
// processus (kill), conteneurs Docker (start/stop/restart, logs).
import { get, post } from '../api.js';
import { h, clear, replace, prefs, formatBytes, formatDuration } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import {
  button, busy, select, segmented, field, openDialog, confirmDialog, toast, toastError,
  loadingState, emptyState, errorState, badge, input,
} from '../ui/components.js';
import { hostPicker } from '../ui/hostpicker.js';
import { lineChart } from '../ui/chart.js';
import { state } from '../state.js';

const INTERVAL = 3000;
const pct = (v) => `${Math.round(v)} %`;
const rate = (v) => `${formatBytes(v)}/s`;

export default {
  mount(el) {
    let hostId = state.activeHostId;
    let tab = prefs.get('monTab', 'system');
    let timer = null;
    let inflight = null;
    let charts = null;
    const content = h('div');
    const picker = hostPicker((id) => { hostId = id; start(); });
    const tabs = segmented([
      { value: 'system', label: 'Système' }, { value: 'processes', label: 'Processus' }, { value: 'docker', label: 'Docker' },
    ], tab, (v) => { tab = v; prefs.set('monTab', v); start(); }, { label: 'Section supervision' });
    el.append(h('div', { class: 'toolbar' }, picker), h('div', { class: 'toolbar' }, tabs), content);

    const api = (p) => `/api/hosts/${hostId}/${p}`;

    function stop() {
      clearTimeout(timer);
      timer = null;
      inflight?.abort();
      inflight = null;
      charts?.forEach((c) => c.destroy());
      charts = null;
    }

    function start() {
      stop();
      if (!hostId) {
        tabs.hidden = true;
        return replace(content, emptyState({ icon: 'activity', title: 'Choisissez un hôte', text: 'Ses ressources s\'afficheront en temps réel.' }));
      }
      tabs.hidden = false;
      if (tab === 'processes') return renderProcesses();
      if (tab === 'docker') return renderDocker();
      return renderSystem();
    }

    // ---------- Système ----------
    function renderSystem() {
      const tiles = h('div', { class: 'tiles' });
      const status = h('div', { 'aria-live': 'polite' });
      const cpu = lineChart({ title: 'CPU', series: [{ key: 'cpu', label: 'CPU', color: '--c-chart-1' }], max: 100, format: pct });
      const ram = lineChart({ title: 'Mémoire', series: [{ key: 'mem', label: 'RAM', color: '--c-chart-1' }], max: 100, format: pct });
      const net = lineChart({
        title: 'Réseau', format: rate, minMax: 1024, emptyText: 'indisponible (pas de /proc/net/dev)',
        series: [{ key: 'rx', label: 'Reçu', color: '--c-chart-1' }, { key: 'tx', label: 'Envoyé', color: '--c-chart-2' }],
      });
      charts = [cpu, ram, net];
      const disks = h('div', { class: 'stack' });
      const tableBody = h('tbody');
      const table = h('details', { class: 'card card-pad values-table' },
        h('summary', null, 'Valeurs des graphiques (tableau)'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Heure', 'CPU', 'RAM', 'Reçu', 'Envoyé'].map((t) => h('th', { scope: 'col' }, t)))),
          tableBody)));
      replace(content, status, tiles, h('div', { class: 'charts' }, cpu.el, ram.el, net.el),
        h('h2', { class: 'section-title' }, 'Disques'), disks, table);
      replace(tiles, loadingState('Premier relevé…'));

      const tick = async () => {
        if (document.hidden) { timer = setTimeout(tick, INTERVAL); return; }
        inflight = new AbortController();
        try {
          const s = await get(api('monitor/stats'), { signal: inflight.signal });
          replace(status);
          renderTiles(tiles, s);
          renderDisks(disks, s.disks);
          cpu.push(s.ts, { cpu: s.cpu });
          ram.push(s.ts, { mem: s.mem?.percent ?? null });
          net.push(s.ts, { rx: s.net.rxRate, tx: s.net.txRate });
          tableBody.prepend(h('tr', null,
            h('td', null, new Date(s.ts).toLocaleTimeString('fr-FR')),
            h('td', null, s.cpu === null ? '—' : pct(s.cpu)),
            h('td', null, s.mem ? pct(s.mem.percent) : '—'),
            h('td', null, s.net.rxRate === null ? '—' : rate(s.net.rxRate)),
            h('td', null, s.net.txRate === null ? '—' : rate(s.net.txRate))));
          while (tableBody.children.length > 20) tableBody.lastChild.remove();
        } catch (err) {
          if (err.name === 'AbortError') return;
          replace(status, h('div', { class: 'test-result ko', role: 'alert' }, `${err.message} — nouvel essai dans 3 s`));
          if (!tiles.querySelector('.tile')) replace(tiles);
        }
        if (charts) timer = setTimeout(tick, INTERVAL);
      };
      tick();
    }

    function tile(label, valueText, sub, ic, level) {
      return h('div', { class: 'card tile' },
        h('div', { class: 'tile-label' }, icon(ic, { size: 16 }), label),
        h('div', { class: 'tile-value' }, valueText),
        sub ? h('div', { class: 'tile-sub' }, sub) : null,
        level ? badge(level.text, level.kind) : null);
    }

    function renderTiles(el2, s) {
      const memLevel = s.mem && s.mem.percent > 90 ? { text: 'mémoire saturée', kind: 'danger' } : null;
      const tempLevel = s.temp !== null && s.temp >= 75 ? { text: 'chaud', kind: s.temp >= 82 ? 'danger' : 'warn' } : null;
      replace(el2,
        tile('CPU', s.cpu === null ? '…' : pct(s.cpu), s.cores ? `${s.cores} cœur${s.cores > 1 ? 's' : ''}` : null, 'cpu'),
        tile('Mémoire', s.mem ? pct(s.mem.percent) : '—', s.mem ? `${formatBytes(s.mem.used)} / ${formatBytes(s.mem.total)}` : null, 'memory', memLevel),
        tile('Charge', s.load ? s.load[0].toFixed(2) : '—', s.load ? `5 min ${s.load[1].toFixed(2)} · 15 min ${s.load[2].toFixed(2)}` : null, 'activity'),
        tile('Uptime', s.uptime ? formatDuration(s.uptime) : '—', s.kernel, 'history'),
        s.swap ? tile('Swap', pct(s.swap.percent), `${formatBytes(s.swap.used)} / ${formatBytes(s.swap.total)}`, 'memory') : null,
        s.temp !== null ? tile('Température', `${s.temp.toFixed(1)} °C`, 'zone thermique 0', 'warning', tempLevel) : null);
    }

    function renderDisks(el2, disks) {
      if (!disks.length) return replace(el2, h('p', { class: 'dim' }, 'Aucun système de fichiers lisible (df indisponible ?).'));
      replace(el2, disks.map((d) => {
        const full = d.percent >= 90;
        const bar = h('div', { class: 'meter-fill' + (full ? ' is-danger' : '') });
        bar.style.width = `${Math.min(100, d.percent).toFixed(1)}%`;
        return h('div', { class: 'card card-pad meter' },
          h('div', { class: 'row' }, icon('disk', { size: 18 }), h('strong', { class: 'mono ellipsis grow' }, d.mount),
            full ? badge('presque plein', 'danger') : null, h('span', null, pct(d.percent))),
          h('div', { class: 'meter-track', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(d.percent)), 'aria-label': `Disque ${d.mount}` }, bar),
          h('div', { class: 'file-meta' }, `${formatBytes(d.used)} utilisés sur ${formatBytes(d.size)} · ${formatBytes(d.avail)} libres · ${d.fs}`));
      }));
    }

    // ---------- Processus ----------
    async function renderProcesses() {
      const filter = input({ type: 'search', placeholder: 'Filtrer (commande, utilisateur, PID)…', 'aria-label': 'Filtrer les processus', class: 'input search' });
      const list = h('div', null, loadingState('ps…'));
      const refresh = button({ label: 'Rafraîchir', icon: 'refresh', iconOnly: true });
      replace(content, h('div', { class: 'toolbar' }, filter, refresh), list);
      let data = null;
      const draw = () => {
        if (!data) return;
        const q = filter.value.trim().toLowerCase();
        const procs = data.processes.filter((p) => !q || `${p.pid} ${p.user} ${p.args}`.toLowerCase().includes(q));
        if (!procs.length) return replace(list, emptyState({ title: 'Aucun processus correspondant' }));
        replace(list, h('p', { class: 'dim' }, `${data.total} processus — ${procs.length} affichés (tri par CPU)`),
          h('ul', { class: 'list' }, procs.map((p) => h('li', null, h('div', { class: 'list-item' },
            h('div', { class: 'grow' },
              h('div', { class: 'row' }, h('strong', { class: 'mono ellipsis' }, p.command), h('span', { class: 'faint' }, `PID ${p.pid}`)),
              h('div', { class: 'file-meta ellipsis', title: p.args }, p.args),
              h('div', { class: 'file-meta' }, [p.user, p.cpu !== null ? `CPU ${p.cpu.toFixed(1)} %` : null, p.mem !== null ? `RAM ${p.mem.toFixed(1)} %` : null, p.rss ? formatBytes(p.rss) : null].filter(Boolean).join(' · '))),
            button({ label: `Arrêter le processus ${p.pid}`, icon: 'stop', iconOnly: true, variant: 'ghost', onClick: () => kill(p) }))))));
      };
      const load = async () => {
        try { data = await busy(refresh, () => get(api('monitor/processes'))); draw(); } catch (err) { replace(list, errorState(err, load)); }
      };
      filter.addEventListener('input', draw);
      refresh.addEventListener('click', load);
      await load();

      async function kill(p) {
        const sig = select([
          { value: 'TERM', label: 'TERM — arrêt propre' }, { value: 'INT', label: 'INT — interruption' },
          { value: 'HUP', label: 'HUP — recharger' }, { value: 'KILL', label: 'KILL — arrêt forcé' },
        ], { value: 'TERM' });
        const d = openDialog({
          title: `Arrêter ${p.command} (PID ${p.pid}) ?`,
          body: h('div', { class: 'stack' }, h('p', { class: 'mono dim' }, p.args), field({ label: 'Signal', control: sig })),
          actions: [
            button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close() }),
            button({ label: 'Envoyer le signal', variant: 'danger', icon: 'stop', onClick: async () => {
              try {
                await post(api('monitor/kill'), { pid: p.pid, signal: sig.value });
                toast(`${sig.value} envoyé au PID ${p.pid}`, 'ok');
                d.close();
                setTimeout(load, 500);
              } catch (err) { toastError(err); }
            } }),
          ],
        });
      }
    }

    // ---------- Docker ----------
    async function renderDocker() {
      const list = h('div', null, loadingState('docker ps…'));
      const refresh = button({ label: 'Rafraîchir', icon: 'refresh', iconOnly: true });
      replace(content, h('div', { class: 'toolbar' }, h('span', { class: 'grow dim' }, 'Conteneurs (docker ps -a)'), refresh), list);
      const load = async () => {
        try {
          const { containers } = await busy(refresh, () => get(api('docker/containers')));
          if (!containers.length) return replace(list, emptyState({ icon: 'docker', title: 'Aucun conteneur' }));
          replace(list, h('ul', { class: 'list' }, containers.map((ct) => h('li', null, containerCard(ct)))));
        } catch (err) {
          replace(list, err.code === 'DOCKER_MISSING' ? emptyState({ icon: 'docker', title: 'Docker absent', text: err.message }) : errorState(err, load));
        }
      };
      const containerCard = (ct) => {
        const running = ct.state === 'running';
        const act = (action, label, ic, variant) => {
          const b = button({ label, icon: ic, variant, onClick: async () => {
            if (action !== 'start' && !await confirmDialog({ title: `${label} ${ct.name} ?`, message: `docker ${action} ${ct.name}`, confirmLabel: label, danger: action === 'stop' })) return;
            try { await busy(b, () => post(api(`docker/${encodeURIComponent(ct.name)}/${action}`))); toast(`${ct.name} : ${action} OK`, 'ok'); load(); } catch (err) { toastError(err); }
          } });
          return b;
        };
        return h('div', { class: 'card card-pad stack' },
          h('div', { class: 'row' }, icon('docker', { size: 20 }), h('strong', { class: 'ellipsis grow' }, ct.name),
            badge(running ? 'en marche' : ct.state, running ? 'ok' : ct.state === 'restarting' ? 'warn' : undefined)),
          h('div', { class: 'file-meta ellipsis' }, `${ct.image} · ${ct.status}`),
          ct.ports ? h('div', { class: 'file-meta ellipsis mono' }, ct.ports) : null,
          h('div', { class: 'row wrap' },
            running ? act('stop', 'Arrêter', 'stop', 'danger') : act('start', 'Démarrer', 'play', 'primary'),
            act('restart', 'Redémarrer', 'restart'),
            button({ label: 'Logs', icon: 'journal', onClick: () => logs(ct) })));
      };
      refresh.addEventListener('click', load);
      load();
    }

    async function logs(ct) {
      const pre = h('pre', { class: 'diff logs' });
      const body = h('div', null, loadingState('docker logs…'));
      const reload = button({ label: 'Rafraîchir', icon: 'refresh' });
      openDialog({ title: `Logs — ${ct.name}`, body, wide: true, actions: [reload] });
      const load = async () => {
        try {
          const r = await get(`${api(`docker/${encodeURIComponent(ct.name)}/logs`)}?tail=500`);
          pre.textContent = r.logs || '(aucune sortie)';
          replace(body, pre);
          pre.scrollTop = pre.scrollHeight;
        } catch (err) { replace(body, errorState(err)); }
      };
      reload.addEventListener('click', () => busy(reload, load));
      load();
    }

    start();
    return () => { stop(); picker.destroy(); };
  },
};
