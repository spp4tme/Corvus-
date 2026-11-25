// Graphique en courbes temps réel (canvas, sans dépendance).
// Règles : un seul axe Y, traits 2px, grille discrète, couleurs = tokens --c-chart-N dans un
// ordre fixe, légende dès 2 séries + étiquettes directes, curseur + infobulle au survol.
import { h } from './dom.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * @param {{ title: string, series: {key: string, label: string, color: string}[], max?: number,
 *           format: (v: number) => string, capacity?: number, intervalMs?: number }} opts
 */
export function lineChart({ title, series, max, minMax = 1, format, capacity = 60, intervalMs = 3000, emptyText = '—', spanLabel, tipTime }) {
  const canvas = h('canvas', { class: 'chart-canvas', role: 'img', 'aria-label': title });
  const tip = h('div', { class: 'chart-tip', hidden: true, role: 'presentation' });
  const value = h('div', { class: 'chart-value' }, '—');
  const legend = series.length > 1
    ? h('ul', { class: 'chart-legend' }, series.map((s) => h('li', null, h('span', { class: 'chart-swatch', dataset: { color: s.color } }), s.label)))
    : null;
  const el = h('figure', { class: 'card chart' },
    h('figcaption', { class: 'chart-head' }, h('span', { class: 'chart-title' }, title), value),
    legend,
    h('div', { class: 'chart-plot' }, canvas, tip));
  if (legend) for (const sw of legend.querySelectorAll('.chart-swatch')) sw.style.background = `var(${sw.dataset.color})`;

  const data = []; // { t, values: {key: number|null} }
  let hoverIndex = null;

  function push(t, values) {
    data.push({ t, values });
    if (data.length > capacity) data.shift();
    const missing = (v) => v === null || v === undefined;
    const last = series.map((s) => (missing(values[s.key]) ? '—' : format(values[s.key])));
    value.textContent = series.every((s) => missing(values[s.key])) ? emptyText
      : series.length > 1 ? series.map((s, i) => `${s.label} ${last[i]}`).join(' · ') : last[0];
    canvas.setAttribute('aria-label', `${title} : ${value.textContent}`);
    draw();
  }

  function geometry() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(rect.width));
    const hgt = Math.max(10, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== hgt * dpr) {
      canvas.width = w * dpr;
      canvas.height = hgt * dpr;
    }
    const labelW = series.length > 1 ? 44 : 0;
    return { w, h: hgt, dpr, pad: { l: 4, r: 4 + labelW, t: 18, b: 16 } };
  }

  function yMax() {
    if (max) return max;
    let m = 0;
    for (const d of data) for (const s of series) m = Math.max(m, d.values[s.key] ?? 0);
    m = Math.max(m, minMax);
    const p = 10 ** Math.floor(Math.log10(m));
    return Math.ceil(m / p) * p;
  }

  function draw() {
    const g = geometry();
    const ctx = canvas.getContext('2d');
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);
    const top = yMax();
    const x0 = g.pad.l;
    const x1 = g.w - g.pad.r;
    const y0 = g.h - g.pad.b;
    const y1 = g.pad.t;
    const xAt = (i) => x0 + ((x1 - x0) * (i + (capacity - data.length))) / (capacity - 1);
    const yAt = (v) => y0 - ((y0 - y1) * Math.min(v, top)) / top;

    // Grille : 3 lignes, discrète ; graduations en texte « muted ».
    ctx.lineWidth = 1;
    ctx.strokeStyle = css('--c-chart-grid');
    ctx.fillStyle = css('--c-chart-axis');
    ctx.font = `11px ${css('--font-ui')}`;
    ctx.textBaseline = 'bottom';
    for (const f of [0, 0.5, 1]) {
      const y = Math.round(yAt(top * f)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      if (f > 0) ctx.fillText(format(top * f), x0 + 2, y - 2);
    }
    ctx.textBaseline = 'top';
    ctx.fillText(spanLabel || `${Math.round((capacity * intervalMs) / 60000)} min`, x0 + 2, y0 + 2);

    // Séries : traits 2px, aire légère pour une série unique.
    const labels = [];
    series.forEach((s) => {
      const color = css(s.color);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let started = false;
      let lastPt = null;
      data.forEach((d, i) => {
        const v = d.values[s.key];
        if (v === null || v === undefined) { started = false; return; }
        const x = xAt(i);
        const y = yAt(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        lastPt = { x, y, v };
      });
      ctx.stroke();
      if (series.length === 1 && lastPt) {
        ctx.lineTo(lastPt.x, y0);
        const firstIdx = data.findIndex((d) => d.values[s.key] !== null && d.values[s.key] !== undefined);
        ctx.lineTo(xAt(firstIdx), y0);
        ctx.closePath();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (series.length > 1 && lastPt) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(lastPt.x, lastPt.y, 4, 0, Math.PI * 2); ctx.fill();
        labels.push({ x: lastPt.x + 8, y: lastPt.y, text: s.label });
      }
    });

    // Étiquettes directes (texte en encre) : espacées d'au moins 13 px, sans sortir du tracé.
    if (labels.length) {
      const GAP = 13;
      labels.sort((a, b) => a.y - b.y);
      for (let i = 0; i < labels.length; i++) {
        labels[i].y = Math.max(labels[i].y, y1 + 6, i ? labels[i - 1].y + GAP : -Infinity);
      }
      const overflow = labels[labels.length - 1].y - (y0 - 6);
      if (overflow > 0) for (const l of labels) l.y -= overflow;
      ctx.fillStyle = css('--c-text-dim');
      ctx.textBaseline = 'middle';
      for (const l of labels) ctx.fillText(l.text, l.x, l.y);
    }

    // Curseur de survol
    if (hoverIndex !== null && data[hoverIndex]) {
      const x = Math.round(xAt(hoverIndex)) + 0.5;
      ctx.strokeStyle = css('--c-border-strong');
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y0); ctx.stroke();
      for (const s of series) {
        const v = data[hoverIndex].values[s.key];
        if (v === null || v === undefined) continue;
        ctx.fillStyle = css('--c-surface');
        ctx.beginPath(); ctx.arc(x, yAt(v), 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = css(s.color);
        ctx.beginPath(); ctx.arc(x, yAt(v), 4, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function onMove(e) {
    if (!data.length) return;
    const rect = canvas.getBoundingClientRect();
    const g = geometry();
    const rel = (e.clientX - rect.left - g.pad.l) / (g.w - g.pad.l - g.pad.r);
    const i = Math.round(rel * (capacity - 1)) - (capacity - data.length);
    hoverIndex = Math.max(0, Math.min(data.length - 1, i));
    const d = data[hoverIndex];
    tip.replaceChildren(
      h('div', { class: 'chart-tip-time' }, tipTime ? tipTime(d.t) : new Date(d.t).toLocaleTimeString('fr-FR')),
      ...series.map((s) => h('div', { class: 'chart-tip-row' },
        h('span', { class: 'chart-swatch', dataset: { color: s.color } }), `${s.label} `,
        h('strong', null, d.values[s.key] === null || d.values[s.key] === undefined ? '—' : format(d.values[s.key])))));
    for (const sw of tip.querySelectorAll('.chart-swatch')) sw.style.background = `var(${sw.dataset.color})`;
    tip.hidden = false;
    const x = e.clientX - rect.left;
    tip.style.left = `${Math.min(Math.max(8, x + 12), rect.width - tip.offsetWidth - 8)}px`;
    draw();
  }
  function onLeave() { hoverIndex = null; tip.hidden = true; draw(); }
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas);

  /** Remplace toute la série (historique) : l'axe X couvre exactement les points fournis. */
  function setAll(points) {
    data.length = 0;
    for (const p of points) data.push(p);
    capacity = Math.max(2, data.length);
    const last = data[data.length - 1];
    const missing = (v) => v === null || v === undefined;
    value.textContent = !last ? emptyText : series.map((s) => (missing(last.values[s.key]) ? '—' : format(last.values[s.key]))).join(' · ');
    draw();
  }

  return { el, push, setAll, draw, destroy: () => ro.disconnect(), data };
}
