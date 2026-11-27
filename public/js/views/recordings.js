// Vue Enregistrements : liste des sessions de terminal enregistrées et lecteur « vidéo »
// (lecture / pause, vitesse, saut des pauses, barre de progression, recherche de texte).
import { get } from '../api.js';
import { h, replace, formatDate, formatDuration, formatBytes } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { button, openDialog, loadingState, emptyState, errorState, badge, input, select } from '../ui/components.js';
import { terminalTheme } from '../terminal-themes.js';
import { termSettings } from './terminal.js';

/** asciicast v2 → { header, events: [[t, type, data]] } */
export function parseCast(text) {
  const lines = text.split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  const events = [];
  for (const l of lines.slice(1)) {
    try { events.push(JSON.parse(l)); } catch { /* ligne tronquée */ }
  }
  return { header, events };
}

/** Temps « compressés » : chaque pause est limitée à `maxIdle` secondes. */
export function compressTimes(events, maxIdle) {
  let shift = 0;
  let prev = 0;
  return events.map((e) => {
    const gap = e[0] - prev;
    if (maxIdle && gap > maxIdle) shift += gap - maxIdle;
    prev = e[0];
    return e[0] - shift;
  });
}

function player(rec, cast, startAt = null) {
  const host = h('div', { class: 'player-term' });
  const term = new window.Terminal({
    cols: cast.header.width, rows: cast.header.height, disableStdin: true, cursorBlink: false,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    fontSize: Math.min(termSettings.fontSize, 13), theme: terminalTheme(termSettings.theme), scrollback: 2000,
  });
  let skipPauses = true;
  let speed = 1;
  let times = compressTimes(cast.events, 2);
  let idx = 0;
  let clock = 0; // position (s) dans la timeline compressée
  let playing = false;
  let last = 0;
  let raf = null;
  const total = () => (times.length ? times[times.length - 1] : 0);

  const slider = h('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Position', class: 'player-seek' });
  const timeEl = h('span', { class: 'mono dim' });
  const playBtn = button({ label: 'Lecture', icon: 'play', variant: 'primary' });
  const fmt = (s) => { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
  const ui = () => {
    slider.value = String(total() ? Math.round((1000 * clock) / total()) : 0);
    timeEl.textContent = `${fmt(clock)} / ${fmt(total())}`;
    replace(playBtn, icon(playing ? 'stop' : 'play'), playing ? 'Pause' : 'Lecture');
  };

  const apply = (e) => {
    if (e[1] === 'o') term.write(e[2]);
    else if (e[1] === 'r') {
      const [c, r] = String(e[2]).split('x').map(Number);
      if (c > 0 && r > 0) term.resize(c, r);
    }
  };
  /** Saut : on rejoue tout depuis le début jusqu'à la position voulue (rapide, sans attendre). */
  const seek = (target) => {
    term.reset();
    term.resize(cast.header.width, cast.header.height);
    let buf = '';
    idx = 0;
    while (idx < cast.events.length && times[idx] <= target) {
      const e = cast.events[idx];
      if (e[1] === 'o') buf += e[2]; else { if (buf) { term.write(buf); buf = ''; } apply(e); }
      idx++;
    }
    if (buf) term.write(buf);
    clock = target;
    ui();
  };
  const frame = (now) => {
    if (!playing) return;
    clock += ((now - last) / 1000) * speed;
    last = now;
    while (idx < cast.events.length && times[idx] <= clock) apply(cast.events[idx++]);
    if (idx >= cast.events.length) { playing = false; clock = total(); }
    ui();
    if (playing) raf = requestAnimationFrame(frame);
  };
  const play = () => {
    if (idx >= cast.events.length) seek(0);
    playing = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
    ui();
  };
  const pause = () => { playing = false; cancelAnimationFrame(raf); ui(); };
  playBtn.addEventListener('click', () => (playing ? pause() : play()));
  slider.addEventListener('input', () => { pause(); seek((Number(slider.value) / 1000) * total()); });

  const speedSel = select([0.5, 1, 2, 4, 8].map((x) => ({ value: String(x), label: `×${x}` })), { value: '1', 'aria-label': 'Vitesse' });
  speedSel.addEventListener('change', () => { speed = Number(speedSel.value); });
  const skip = h('input', { type: 'checkbox', checked: true });
  skip.addEventListener('change', () => {
    skipPauses = skip.checked;
    const ratio = total() ? clock / total() : 0;
    times = compressTimes(cast.events, skipPauses ? 2 : 0);
    seek(ratio * total());
  });

  // Recherche faite par le serveur (déchiffrement à la volée, séquences d'échappement retirées, journalisée) :
  // renvoie les instants où le texte apparaît ; un clic saute à cet instant.
  const q = input({ type: 'search', placeholder: 'Rechercher dans la sortie…', 'aria-label': 'Rechercher dans la sortie', class: 'input search', maxlength: '200' });
  const hits = h('div', { class: 'row wrap' });
  const jump = (rawT) => {
    const i = cast.events.findIndex((e) => e[0] >= rawT - 1e-6);
    pause();
    seek(times[i < 0 ? times.length - 1 : i] ?? 0);
  };
  q.addEventListener('change', async () => {
    const needle = q.value.trim();
    if (!needle) return replace(hits);
    replace(hits, h('span', { class: 'dim' }, 'Recherche…'));
    try {
      const r = await get(`/api/recordings/${rec.id}/search?${new URLSearchParams({ q: needle, limit: '30' })}`);
      replace(hits, r.matches.length ? r.matches.map((m) => button({ label: fmt(m.t), title: m.snippet, variant: 'ghost', onClick: () => jump(m.t) }))
        : h('span', { class: 'dim' }, 'Aucune occurrence'),
      r.total > r.matches.length ? h('span', { class: 'dim' }, `… ${r.total}${r.capped ? '+' : ''} occurrences`) : null,
      r.timedOut ? h('span', { class: 'dim' }, ' (recherche interrompue : enregistrement très long)') : null);
    } catch (err) { replace(hits, h('span', { class: 'dim' }, err.message)); }
  });
  const exportLink = h('a', { class: 'btn btn-ghost', href: `/api/recordings/${rec.id}/export`, download: '', rel: 'noopener' }, icon('download', { size: 16 }), ' Exporter (.cast)');

  const el = h('div', { class: 'stack' },
    h('p', { class: 'dim' }, `${rec.host} · ${rec.user || '?'} · ${formatDate(rec.startedAt)} · ${formatDuration((rec.durationMs || 0) / 1000)}`),
    host,
    h('div', { class: 'row wrap' }, playBtn, slider, timeEl),
    h('div', { class: 'row wrap' }, h('label', { class: 'check' }, skip, h('span', null, 'Sauter les pauses (> 2 s)')), speedSel),
    q, hits, h('div', { class: 'row wrap' }, exportLink));
  setTimeout(() => { term.open(host); seek(startAt == null ? 0 : (times[Math.max(0, cast.events.findIndex((e) => e[0] >= startAt - 1e-6))] ?? 0)); }, 0);
  return { el, dispose: () => { pause(); term.dispose(); } };
}

export default {
  mount(el) {
    const list = h('div', null, loadingState());
    el.append(h('p', { class: 'dim' }, 'Sessions de terminal enregistrées (sortie uniquement, jamais les frappes). Conservation : 90 jours par défaut.'), list);
    async function open(rec, startAt = null) {
      const body = h('div', null, loadingState('Chargement…'));
      let p = null;
      openDialog({ title: rec.title || 'Enregistrement', body, wide: true, onClose: () => p?.dispose() });
      try {
        const res = await fetch(`/api/recordings/${rec.id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message || `Erreur ${res.status}`);
        p = player(rec, parseCast(await res.text()), startAt);
        replace(body, p.el);
      } catch (err) { replace(body, errorState(err)); }
    }
    const found = h('div', { class: 'stack' });
    const all = input({ type: 'search', placeholder: 'Rechercher dans toutes les sessions visibles…', 'aria-label': 'Rechercher dans toutes les sessions', class: 'input search', maxlength: '200' });
    all.addEventListener('change', async () => {
      const needle = all.value.trim();
      if (!needle) return replace(found);
      replace(found, loadingState('Recherche…'));
      try {
        const r = await get(`/api/recordings/search?${new URLSearchParams({ q: needle })}`);
        replace(found, r.results.length ? h('ul', { class: 'list' }, r.results.map((x) => h('li', null, h('div', { class: 'list-item' },
          h('span', { class: 'grow' }, h('span', { class: 'file-name ellipsis' }, x.host), h('span', { class: 'file-meta' }, `${x.user || '?'} · ${formatDate(x.startedAt)} · ${x.total}${x.capped ? '+' : ''} occurrence(s)`),
            h('div', { class: 'row wrap' }, x.matches.map((m) => button({ label: `${Math.floor(m.t / 60)}:${String(Math.floor(m.t % 60)).padStart(2, '0')} — ${m.snippet.slice(Math.max(0, m.start - 12), m.start + 28)}`, variant: 'ghost', onClick: () => open(x, m.t) }))))))))
          : h('p', { class: 'dim' }, `Aucun résultat dans ${r.scanned} session(s).`),
        r.next ? h('p', { class: 'dim' }, `Recherche limitée à ${r.scanned} sessions récentes ; affinez la requête pour remonter plus loin.`) : null);
      } catch (err) { replace(found, errorState(err)); }
    });
    el.prepend(all, found);
    get('/api/recordings').then(({ recordings }) => {
      if (!recordings.length) return replace(list, emptyState({ icon: 'history', title: 'Aucun enregistrement', text: 'Les sessions de terminal fermées apparaîtront ici.' }));
      replace(list, h('ul', { class: 'list' }, recordings.map((r) => h('li', null, h('button', { type: 'button', class: 'list-item clickable list-button', onclick: () => open(r) },
        icon('play', { size: 20 }),
        h('span', { class: 'grow' }, h('span', { class: 'file-name ellipsis' }, r.host), h('span', { class: 'file-meta' }, `${r.user || '?'} · ${formatDate(r.startedAt)} · ${formatDuration((r.durationMs || 0) / 1000)} · ${formatBytes(r.bytes)}`)),
        badge(r.title || ''))))));
    }).catch((err) => replace(list, errorState(err)));
  },
};
