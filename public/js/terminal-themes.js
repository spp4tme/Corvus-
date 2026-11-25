// Thèmes du terminal. xterm.js exige des couleurs littérales : elles sont regroupées ici,
// en constantes nommées ; le thème « Corvus » est lu depuis les variables de tokens.css.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const ANSI_CORVUS = {
  black: '#1b1820', red: '#ff6f86', green: '#52e3a8', yellow: '#ffc247', blue: '#8fa8ff', magenta: '#ff8fcf', cyan: '#7df9d0', white: '#d9d3e0',
  brightBlack: '#8a8294', brightRed: '#ff94a5', brightGreen: '#82efc2', brightYellow: '#ffd77f', brightBlue: '#b4c4ff', brightMagenta: '#ffb3de', brightCyan: '#a6fbe3', brightWhite: '#ffffff',
};

export const TERMINAL_THEMES = {
  corvus: {
    label: 'Corvus',
    build: () => ({
      background: cssVar('--c-bg'), foreground: cssVar('--c-text'), cursor: cssVar('--c-accent'),
      cursorAccent: cssVar('--c-bg'), selectionBackground: 'rgba(183, 148, 255, 0.35)', ...ANSI_CORVUS,
    }),
  },
  minuit: {
    label: 'Minuit',
    build: () => ({
      background: '#000000', foreground: '#cfd6e6', cursor: '#ffffff', selectionBackground: 'rgba(255,255,255,0.25)',
      black: '#000000', red: '#e05561', green: '#8cc265', yellow: '#d18f52', blue: '#4aa5f0', magenta: '#c162de', cyan: '#42b3c2', white: '#cfd6e6',
      brightBlack: '#5c6370', brightRed: '#ff616e', brightGreen: '#a5e075', brightYellow: '#f0a45d', brightBlue: '#4dc4ff', brightMagenta: '#de73ff', brightCyan: '#4cd1e0', brightWhite: '#ffffff',
    }),
  },
  ambre: {
    label: 'Ambre (rétro)',
    build: () => ({
      background: '#120c02', foreground: '#ffb646', cursor: '#ffcc66', selectionBackground: 'rgba(255,182,70,0.3)',
      black: '#120c02', red: '#ff8c3b', green: '#ffb646', yellow: '#ffd27f', blue: '#d99a3b', magenta: '#ffa45c', cyan: '#ffc773', white: '#ffcf87',
      brightBlack: '#7a5420', brightRed: '#ffa860', brightGreen: '#ffc773', brightYellow: '#ffe0a6', brightBlue: '#efb25c', brightMagenta: '#ffbd85', brightCyan: '#ffd699', brightWhite: '#fff0d4',
    }),
  },
  papier: {
    label: 'Papier (clair)',
    build: () => ({
      background: '#f7f6f2', foreground: '#2a2d34', cursor: '#3451b2', selectionBackground: 'rgba(52,81,178,0.22)',
      black: '#2a2d34', red: '#c0392b', green: '#1e7f4f', yellow: '#9a6a00', blue: '#3451b2', magenta: '#8e3aa8', cyan: '#127a87', white: '#d6d4cc',
      brightBlack: '#6b6f78', brightRed: '#e0483a', brightGreen: '#26a065', brightYellow: '#b88400', brightBlue: '#4a68d0', brightMagenta: '#a54fc2', brightCyan: '#1897a6', brightWhite: '#ffffff',
    }),
  },
};

export function terminalTheme(name) {
  return (TERMINAL_THEMES[name] || TERMINAL_THEMES.corvus).build();
}
