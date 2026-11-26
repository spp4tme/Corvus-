// Jeu d'icônes Corvus (original, trait 24×24) construit via le DOM SVG — jamais d'innerHTML.
const NS = 'http://www.w3.org/2000/svg';

const circle = (cx, cy, r) => ['circle', { cx, cy, r }];
const p = (d) => ['path', { d }];

const DEFS = {
  // types d'hôtes
  server: [p('M4 4h16v6H4zM4 14h16v6H4z'), p('M8 7h.01M8 17h.01')],
  desktop: [p('M3 4h18v12H3zM8 20h8M12 16v4')],
  laptop: [p('M5 5h14v10H5zM2 19h20')],
  pi: [p('M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4')],
  cloud: [p('M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.4 4.3 4.3 0 0 0 7 18z')],
  database: [p('M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3')],
  router: [p('M3 14h18v6H3zM7 17h.01M11 17h.01M8.5 10.5a5 5 0 0 1 7 0M5.5 7.5a9.5 9.5 0 0 1 13 0')],
  nas: [p('M6 3h12v18H6zM9 7h6M9 11h6M12 17h.01')],
  container: [p('M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8')],
  globe: [circle(12, 12, 9), p('M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z')],
  phone: [p('M8 2h8v20H8zM11 18h2')],
  shield: [p('M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z')],
  // navigation
  terminal: [p('M4 5h16v14H4zM7 9l3 3-3 3M12 15h5')],
  folder: [p('M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z')],
  file: [p('M6 2h8l4 4v16H6zM14 2v4h4')],
  git: [circle(6, 18, 2.5), circle(6, 6, 2.5), circle(18, 8, 2.5), p('M6 8.5v7M18 10.5c0 4-12 2-12 5')],
  activity: [p('M3 12h4l3-8 4 16 3-8h4')],
  more: [circle(5, 12, 1.2), circle(12, 12, 1.2), circle(19, 12, 1.2)],
  journal: [p('M5 3h14v18H5zM9 7h6M9 11h6M9 15h4')],
  settings: [p('M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12'), circle(16, 6, 2), circle(10, 12, 2), circle(18, 18, 2)],
  link: [p('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1')],
  // actions
  plus: [p('M12 5v14M5 12h14')],
  close: [p('M6 6l12 12M18 6L6 18')],
  pin: [p('M9 3h6l-1 6 4 4H6l4-4zM12 13v8')],
  edit: [p('M4 20h4L19 9l-4-4L4 16zM14 6l4 4')],
  trash: [p('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3')],
  plug: [p('M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5')],
  refresh: [p('M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7')],
  search: [circle(11, 11, 7), p('M20 20l-4-4')],
  upload: [p('M12 16V4M7 9l5-5 5 5M4 20h16')],
  download: [p('M12 4v12M7 11l5 5 5-5M4 20h16')],
  folderPlus: [p('M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM12 10v6M9 13h6')],
  chevronRight: [p('M9 6l6 6-6 6')],
  chevronLeft: [p('M15 6l-6 6 6 6')],
  chevronDown: [p('M6 9l6 6 6-6')],
  sparkle: [p('M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z')],
  expand: [p('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5')],
  collapse: [p('M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5')],
  arrowUp: [p('M12 19V5M5 12l7-7 7 7')],
  arrowDown: [p('M12 5v14M5 12l7 7 7-7')],
  arrowLeft: [p('M19 12H5M12 5l-7 7 7 7')],
  arrowRight: [p('M5 12h14M12 5l7 7-7 7')],
  clipboard: [p('M8 3h8v4H8zM6 5H4v16h16V5h-2')],
  mic: [p('M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3')],
  logout: [p('M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10')],
  warning: [p('M12 3l10 18H2zM12 10v4M12 17h.01')],
  check: [p('M5 12l5 5 9-11')],
  keyboard: [p('M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10')],
  eye: [p('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z'), circle(12, 12, 3)],
  save: [p('M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7')],
  stop: [p('M6 6h12v12H6z')],
  play: [p('M7 4l13 8-13 8z')],
  restart: [p('M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5')],
  bell: [p('M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4')],
  key: [circle(8, 15, 4), p('M11 12l9-9M17 6l3 3M15 8l2 2')],
  lock: [p('M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4')],
  copy: [p('M8 8h12v12H8zM4 16V4h12')],
  external: [p('M14 4h6v6M20 4l-9 9M18 14v6H4V6h6')],
  image: [p('M3 5h18v14H3z'), circle(9, 10, 2), p('M3 17l5-4 4 3 3-2 6 4')],
  commit: [circle(12, 12, 3.5), p('M2 12h6.5M15.5 12H22')],
  branch: [circle(6, 5, 2.5), circle(6, 19, 2.5), circle(18, 7, 2.5), p('M6 7.5v9M18 9.5c0 5-12 3-12 7')],
  history: [p('M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 3')],
  cpu: [p('M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4')],
  memory: [p('M3 7h18v10H3zM7 17v3M12 17v3M17 17v3M7 10v4M11 10v4M15 10v4')],
  disk: [circle(12, 12, 9), circle(12, 12, 2.5)],
  network: [p('M7 4v12M4 13l3 3 3-3M17 20V8M14 11l3-3 3 3')],
  docker: [p('M3 13h18c-.5 4-4 7-9 7s-8-3-9-7zM6 13v-3h3v3M9 10V7h3v3M12 13v-3h3v3M9 13v-3')],
};

/**
 * @param {string} name
 * @param {{size?: number, label?: string}} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size, label } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  else svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of DEFS[name] || DEFS.server) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

/** Logo Corvus : le corbeau détaillé de public/icons/logo.svg (généré par scripts/make-logo.mjs). */
export function logo() {
  const img = document.createElement('img');
  img.src = '/icons/logo.svg';
  img.alt = '';
  img.width = 64; img.height = 64;
  img.decoding = 'async';
  img.setAttribute('aria-hidden', 'true');
  return img;
}

export const HOST_ICONS = ['server', 'desktop', 'laptop', 'pi', 'cloud', 'database', 'router', 'nas', 'container', 'globe', 'phone', 'shield'];
