// Logger minimaliste, lisible, sans dépendance. Ne jamais y passer de secret.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function fmt(level, scope, msg, extra) {
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) {
    if (extra instanceof Error) line += ` — ${extra.message}`;
    else if (typeof extra === 'object') line += ' ' + JSON.stringify(extra);
    else line += ' ' + String(extra);
  }
  return line;
}

export function logger(scope) {
  const out = (level) => (msg, extra) => {
    if (LEVELS[level] < threshold) return;
    const line = fmt(level, scope, msg, extra);
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error') };
}
