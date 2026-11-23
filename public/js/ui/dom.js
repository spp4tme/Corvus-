// Construction DOM sûre : les données ne passent QUE par textContent / attributs. Jamais d'innerHTML.

/**
 * h('button', { class: 'btn', onclick: fn, 'aria-label': 'x' }, 'texte', autreNoeud)
 * - les clés on* deviennent des écouteurs
 * - `dataset` : objet → data-*
 * - valeur false/null/undefined → attribut omis
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = !!v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

export function formatBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(ts) {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  if (d) return `${d} j ${hh} h`;
  if (hh) return `${hh} h ${mm} min`;
  return `${mm} min`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Stockage local tolérant (navigation privée, quota…). */
export const prefs = {
  get(key, def) {
    try { const v = localStorage.getItem(`corvus.${key}`); return v === null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem(`corvus.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
