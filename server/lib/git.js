// Git distant via SSH. Chaque argument est validé puis échappé (q/qPath) ; le message de
// commit passe par stdin (`git commit -F -`), jamais dans la ligne de commande.
import { HttpError } from './validate.js';
import { q, qPath } from './shell.js';

// GIT_LITERAL_PATHSPECS : un fichier nommé `:(exclude)x` ne doit jamais être lu comme une « magie » de pathspec
// (indexer ce fichier indexerait sinon TOUS les autres).
const ENV = "export GIT_LITERAL_PATHSPECS=1 GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes';";
const SEP = '\x1f';
const REC = '\x1e';

function prefix(repo) {
  return `${ENV} cd -- ${qPath(repo)} 2>/dev/null || exit 90; ` +
    'command -v git >/dev/null 2>&1 || exit 89; ' +
    'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 91; ';
}

/** Analyse `git status --porcelain=v1 -b -z`. */
export function parseStatus(out) {
  const parts = out.split('\0');
  const res = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, initial: false, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    if (s.startsWith('## ')) {
      const line = s.slice(3);
      let m;
      if ((m = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(line))) { res.branch = m[1]; res.initial = true; continue; }
      if (line.startsWith('HEAD (no branch)')) { res.detached = true; continue; }
      m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(line);
      if (m) {
        res.branch = m[1];
        res.upstream = m[2] || null;
        const a = /ahead (\d+)/.exec(m[3] || '');
        const b = /behind (\d+)/.exec(m[3] || '');
        res.ahead = a ? Number(a[1]) : 0;
        res.behind = b ? Number(b[1]) : 0;
        res.gone = /gone/.test(m[3] || '');
      }
      continue;
    }
    const x = s[0];
    const y = s[1];
    const path = s.slice(3);
    let orig;
    if (x === 'R' || x === 'C') orig = parts[++i];
    const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    res.files.push({
      path, orig, x, y,
      untracked: x === '?',
      staged: !conflict && x !== ' ' && x !== '?' && x !== '!',
      unstaged: !conflict && y !== ' ' && y !== '?' && y !== '!',
      conflict,
    });
  }
  return res;
}

export class GitService {
  constructor({ pool, hosts, journal }) {
    Object.assign(this, { pool, hosts, journal });
  }

  log(hostId, event, detail, ok = true) {
    this.journal.add({ type: 'git', event, host: this.hosts.get(hostId), detail, ok });
  }

  async run(hostId, repo, cmd, { stdin, timeoutMs = 30_000, maxBytes = 4 * 1024 * 1024, okCodes = [0] } = {}) {
    const r = await this.pool.exec(hostId, prefix(repo) + cmd, { stdin, timeoutMs, maxBytes });
    if (r.code === 90) throw new HttpError(404, 'NOT_FOUND', `Dossier introuvable : ${repo}`);
    if (r.code === 89) throw new HttpError(400, 'GIT_MISSING', 'git n\'est pas installé sur cet hôte');
    if (r.code === 91) throw new HttpError(400, 'NOT_A_REPO', `Ce dossier n'est pas un dépôt git : ${repo}`);
    if (!okCodes.includes(r.code)) {
      const msg = (r.stderr || r.stdout.toString('utf8')).trim().split('\n').slice(-12).join('\n').slice(0, 2000);
      throw new HttpError(400, 'GIT_ERROR', msg || `git a échoué (code ${r.code})`);
    }
    return { out: r.stdout.toString('utf8'), err: r.stderr, truncated: r.truncated, code: r.code };
  }

  async status(hostId, repo) {
    const { out } = await this.run(hostId, repo, 'git status --porcelain=v1 -b -z --untracked-files=all');
    const st = parseStatus(out);
    const top = await this.run(hostId, repo, 'git rev-parse --show-toplevel; git remote');
    const [toplevel, ...remotes] = top.out.split('\n').filter(Boolean);
    return { repo, toplevel, remotes, ...st };
  }

  async branches(hostId, repo) {
    const fmt = ['%(refname)', '%(refname:short)', '%(objectname:short)', '%(upstream:short)', '%(HEAD)', '%(committerdate:unix)', '%(contents:subject)'].join('%1f');
    const { out } = await this.run(hostId, repo, `git for-each-ref --sort=-committerdate --format=${q(fmt)} refs/heads refs/remotes`);
    const local = [];
    const remote = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [ref, name, sha, upstream, head, date, subject] = line.split(SEP);
      if (ref.endsWith('/HEAD')) continue;
      const b = { name, sha, upstream: upstream || null, current: head === '*', date: Number(date) || null, subject };
      (ref.startsWith('refs/heads/') ? local : remote).push(b);
    }
    return { local, remote };
  }

  async checkout(hostId, repo, branch, { remote = false, create = false } = {}) {
    let cmd;
    if (create) cmd = `git checkout -q -b ${q(branch)} --`;
    else if (remote) cmd = `git checkout -q --track ${q(branch)} --`;
    else cmd = `git checkout -q ${q(branch)} --`;
    try {
      await this.run(hostId, repo, `${cmd} 2>&1`);
    } catch (err) {
      this.log(hostId, 'checkout', `${repo} ${branch}`, false);
      throw err;
    }
    this.log(hostId, create ? 'branch' : 'checkout', `${repo} → ${branch}`);
    return this.status(hostId, repo);
  }

  async history(hostId, repo, { ref, skip = 0, limit = 40 } = {}) {
    const fmt = ['%H', '%h', '%an', '%ae', '%at', '%D', '%s'].join('%x1f') + '%x1e';
    const { out, err, code } = await this.run(hostId, repo,
      `git log -n ${limit} --skip ${skip} --format=${q(fmt)} ${ref ? q(ref) : ''} --`, { okCodes: [0, 128] });
    if (code === 128) {
      if (/does not have any commits|bad default revision/.test(err)) return { commits: [], more: false };
      throw new HttpError(400, 'GIT_ERROR', err.trim().slice(0, 500) || 'git log a échoué');
    }
    const commits = out.split(REC).map((s) => s.replace(/^\n/, '')).filter(Boolean).map((rec) => {
      const [sha, short, author, email, at, refs, subject] = rec.split(SEP);
      return { sha, short, author, email, date: Number(at), refs: refs ? refs.split(', ').filter(Boolean) : [], subject };
    });
    return { commits, more: commits.length === limit };
  }

  async show(hostId, repo, sha) {
    const { out, truncated } = await this.run(hostId, repo, `git show --no-color --stat --patch --format=fuller ${q(sha)} --`, { maxBytes: 1024 * 1024 });
    return { sha, text: out, truncated };
  }

  async diff(hostId, repo, path, { staged = false, untracked = false } = {}) {
    const cmd = untracked
      ? `git diff --no-color --no-index -- /dev/null ${q(path)}`
      : `git diff --no-color ${staged ? '--cached' : ''} -- ${q(path)}`;
    const { out, truncated } = await this.run(hostId, repo, cmd, { maxBytes: 1024 * 1024, okCodes: [0, 1] });
    return { path, text: out, truncated };
  }

  async stage(hostId, repo, paths) {
    await this.run(hostId, repo, `git add -A -- ${paths.map(q).join(' ')}`);
    return this.status(hostId, repo);
  }

  async stageAll(hostId, repo) {
    await this.run(hostId, repo, 'git add -A');
    return this.status(hostId, repo);
  }

  async unstage(hostId, repo, paths) {
    const list = paths.map(q).join(' ');
    await this.run(hostId, repo,
      `if git rev-parse -q --verify HEAD >/dev/null; then git reset -q HEAD -- ${list}; else git rm -q --cached -r -- ${list}; fi`);
    return this.status(hostId, repo);
  }

  async commit(hostId, repo, message) {
    try {
      await this.run(hostId, repo, 'git commit -q -F - 2>&1', { stdin: message });
    } catch (err) {
      this.log(hostId, 'commit', repo, false);
      if (/Please tell me who you are|user\.email/.test(err.message)) {
        throw new HttpError(400, 'GIT_IDENTITY', 'Identité git manquante sur l\'hôte : configurez user.name et user.email (git config --global …) depuis le terminal.');
      }
      throw err;
    }
    const { out } = await this.run(hostId, repo, 'git log -1 --format=%h%x1f%s');
    const [short, subject] = out.trim().split(SEP);
    this.log(hostId, 'commit', `${repo} ${short} ${subject}`);
    return { short, subject, status: await this.status(hostId, repo) };
  }

  async remoteOp(hostId, repo, op) {
    const cmds = { pull: 'git pull --ff-only 2>&1', push: 'git push 2>&1', fetch: 'git fetch --prune 2>&1' };
    try {
      const { out } = await this.run(hostId, repo, cmds[op], { timeoutMs: 120_000 });
      this.log(hostId, op, repo);
      return { output: out.trim().slice(-4000), status: await this.status(hostId, repo) };
    } catch (err) {
      this.log(hostId, op, `${repo} : ${err.message.split('\n')[0]}`, false);
      if (op === 'pull' && /Not possible to fast-forward|diverg/i.test(err.message)) {
        throw new HttpError(409, 'NOT_FAST_FORWARD', 'Pull impossible en fast-forward : les branches ont divergé. Résolvez depuis le terminal (rebase ou merge).');
      }
      if (op === 'push' && /no upstream/i.test(err.message)) {
        throw new HttpError(400, 'NO_UPSTREAM', 'Aucune branche amont : lancez « git push -u origin <branche> » depuis le terminal la première fois.');
      }
      throw err;
    }
  }

  /** Recherche de dépôts sous le dossier personnel (profondeur bornée). */
  async discover(hostId) {
    const r = await this.pool.exec(hostId,
      'cd "$HOME" 2>/dev/null || exit 0; find . -maxdepth 4 -type d -name .git -prune 2>/dev/null | head -n 60; printf "##HOME %s\\n" "$HOME"',
      { timeoutMs: 20_000 });
    const lines = r.stdout.toString('utf8').split('\n').filter(Boolean);
    const homeLine = lines.find((l) => l.startsWith('##HOME '));
    const home = homeLine ? homeLine.slice(7) : '~';
    return {
      repos: lines.filter((l) => l.startsWith('./')).map((l) => {
        const rel = l.slice(2).replace(/\/?\.git$/, '');
        return rel ? `~/${rel}` : '~';
      }),
      home,
    };
  }
}
