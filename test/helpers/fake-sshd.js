// Serveur SSH de test en pur JS (ssh2.Server) : exec/shell via bash, SFTP sur un dossier réel.
// Sous Windows, utilise le bash de Git for Windows (MSYS2) ; sous Linux, /bin/bash.
// Les chemins exposés sont ceux du shell (ex. /c/Users/... sous MSYS) pour que SFTP et exec concordent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const { STATUS_CODE, flagsToString } = utils.sftp;
const isWin = process.platform === 'win32';

export function findBash() {
  if (process.env.CORVUS_TEST_BASH) return { bash: process.env.CORVUS_TEST_BASH, extraPath: [] };
  if (!isWin) return { bash: '/bin/bash', extraPath: [] };
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  const candidates = [];
  for (const d of dirs) {
    if (/system32/i.test(d)) continue;
    candidates.push(path.resolve(d, '..'), path.resolve(d, '..', '..'), d);
  }
  candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git'), 'C:\\Program Files\\Git');
  for (const root of candidates) {
    const bash = path.join(root, 'usr', 'bin', 'bash.exe');
    if (fs.existsSync(bash)) {
      return { bash, extraPath: [path.join(root, 'usr', 'bin'), path.join(root, 'mingw64', 'bin')] };
    }
  }
  throw new Error('bash introuvable (installez Git for Windows ou définissez CORVUS_TEST_BASH)');
}

// --- correspondance chemins virtuels (POSIX/MSYS) <-> réels -----------------------
export function toVirtual(real) {
  if (!isWin) return real;
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(real);
  if (!m) return real.replace(/\\/g, '/');
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/+$/, '') || '/';
}
export function toReal(virt) {
  const p = path.posix.normalize(virt);
  if (!isWin) return p;
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  if (!m) return null;
  return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
}

function attrsFrom(st) {
  return {
    mode: st.mode,
    uid: 0, gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function longname(name, st) {
  const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : '-';
  return `${type}rw-r--r-- 1 tester tester ${st.size} Jan 1 00:00 ${name}`;
}

/**
 * Démarre un sshd de test.
 * @returns {Promise<{port, root, rootVirtual, user, password, clientKey, hostKey, close, sessions}>}
 */
export async function startFakeSshd({ port = 0, hostKey, root } = {}) {
  const { bash, extraPath } = findBash();
  const hk = hostKey || utils.generateKeyPairSync('ed25519').private;
  const workdir = root || fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-sshd-'));
  const clientKey = utils.generateKeyPairSync('ed25519', { passphrase: 'phrase-test', cipher: 'aes256-ctr' });
  const allowedPub = utils.parseKey(clientKey.public);
  const user = 'tester';
  const password = 'motdepasse-test';
  const env = {
    ...process.env,
    PATH: [...extraPath, process.env.PATH].join(isWin ? ';' : ':'),
    HOME: workdir,
    SHELL: isWin ? '/usr/bin/bash' : '/bin/bash',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    CHERE_INVOKING: '1',
  };
  const children = new Set();
  const stats = { execs: [], shells: 0, sftp: 0 };

  const clients = new Set();
  const server = new Server({ hostKeys: [hk] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.username !== user) return ctx.reject();
      if (ctx.method === 'password' && ctx.password === password) return ctx.accept();
      if (ctx.method === 'publickey') {
        const same = ctx.key.algo === allowedPub.type && ctx.key.data.equals(allowedPub.getPublicSSH());
        if (!same) return ctx.reject();
        if (ctx.signature && allowedPub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
        return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let pty = false;
        session.on('pty', (a) => { pty = true; if (a) a(); });
        session.on('window-change', (a) => a && a());
        session.on('env', (a) => a && a());
        const run = (args, stream) => {
          const child = spawn(bash, args, { cwd: workdir, env, windowsHide: true });
          children.add(child);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          stream.on('data', (d) => {
            if (!pty) return child.stdin.write(d);
            // Émulation minimale d'une discipline de ligne PTY : CR→LF et écho.
            const s = d.toString('utf8').replace(/\r/g, '\n');
            stream.write(s.replace(/\n/g, '\r\n'));
            child.stdin.write(s);
          });
          stream.on('end', () => child.stdin.end());
          stream.on('close', () => { if (child.exitCode === null) child.kill(); });
          child.on('error', (e) => { stream.stderr.write(String(e)); stream.exit(127); stream.end(); });
          child.on('close', (code) => {
            children.delete(child);
            try { stream.exit(code ?? 1); stream.end(); } catch { /* fermé */ }
          });
        };
        session.on('exec', (a, _r, info) => {
          stats.execs.push(info.command);
          run(['-c', info.command], a());
        });
        session.on('shell', (a) => {
          stats.shells++;
          run(['-s'], a());
        });
        session.on('sftp', (a) => {
          stats.sftp++;
          serveSftp(a(), workdir);
        });
      });
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    root: workdir,
    rootVirtual: toVirtual(workdir),
    user, password, clientKey,
    hostKey: hk,
    stats,
    bash, env,
    async close() {
      for (const c of children) c.kill();
      for (const c of clients) c.end();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

function serveSftp(sftp, workdir) {
  const handles = new Map();
  let next = 0;
  const newHandle = (obj) => {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(next++);
    handles.set(h.toString('hex'), obj);
    return h;
  };
  const getH = (h) => handles.get(h.toString('hex'));
  const real = (p) => {
    const r = toReal(p === '.' || p === '' ? toVirtual(workdir) : p);
    if (!r) throw Object.assign(new Error('chemin invalide'), { code: 'ENOENT' });
    return r;
  };
  const fail = (id, err) => sftp.status(id,
    err?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE
      : err?.code === 'EACCES' || err?.code === 'EPERM' ? STATUS_CODE.PERMISSION_DENIED
        : STATUS_CODE.FAILURE, err?.message);
  const guard = (fn) => (id, ...args) => { try { fn(id, ...args); } catch (err) { fail(id, err); } };

  sftp.on('OPEN', guard((id, filename, flags) => {
    const mode = flagsToString(flags) || 'r';
    const fd = fs.openSync(real(filename), mode.replace('x', 'x'));
    sftp.handle(id, newHandle({ fd }));
  }));
  sftp.on('READ', guard((id, handle, offset, length) => {
    const h = getH(handle);
    if (!h?.fd && h?.fd !== 0) return sftp.status(id, STATUS_CODE.FAILURE);
    const buf = Buffer.alloc(length);
    const n = fs.readSync(h.fd, buf, 0, length, offset);
    if (n === 0) return sftp.status(id, STATUS_CODE.EOF);
    sftp.data(id, buf.subarray(0, n));
  }));
  sftp.on('WRITE', guard((id, handle, offset, data) => {
    const h = getH(handle);
    fs.writeSync(h.fd, data, 0, data.length, offset);
    sftp.status(id, STATUS_CODE.OK);
  }));
  sftp.on('FSTAT', guard((id, handle) => sftp.attrs(id, attrsFrom(fs.fstatSync(getH(handle).fd)))));
  sftp.on('FSETSTAT', guard((id) => sftp.status(id, STATUS_CODE.OK)));
  sftp.on('SETSTAT', guard((id) => sftp.status(id, STATUS_CODE.OK)));
  sftp.on('CLOSE', guard((id, handle) => {
    const key = handle.toString('hex');
    const h = handles.get(key);
    if (h && typeof h.fd === 'number') fs.closeSync(h.fd);
    handles.delete(key);
    sftp.status(id, STATUS_CODE.OK);
  }));
  sftp.on('OPENDIR', guard((id, p) => {
    const dir = real(p);
    if (!fs.statSync(dir).isDirectory()) throw Object.assign(new Error('pas un dossier'), { code: 'ENOTDIR' });
    sftp.handle(id, newHandle({ dir, done: false }));
  }));
  sftp.on('READDIR', guard((id, handle) => {
    const h = getH(handle);
    if (!h || h.done) return sftp.status(id, STATUS_CODE.EOF);
    h.done = true;
    const names = fs.readdirSync(h.dir).map((name) => {
      const st = fs.lstatSync(path.join(h.dir, name));
      return { filename: name, longname: longname(name, st), attrs: attrsFrom(st) };
    });
    sftp.name(id, names);
  }));
  sftp.on('STAT', guard((id, p) => sftp.attrs(id, attrsFrom(fs.statSync(real(p))))));
  sftp.on('LSTAT', guard((id, p) => sftp.attrs(id, attrsFrom(fs.lstatSync(real(p))))));
  sftp.on('REALPATH', guard((id, p) => {
    const v = p === '.' || p === '' ? toVirtual(workdir) : path.posix.normalize(p);
    sftp.name(id, [{ filename: v, longname: v, attrs: {} }]);
  }));
  sftp.on('MKDIR', guard((id, p) => { fs.mkdirSync(real(p)); sftp.status(id, STATUS_CODE.OK); }));
  sftp.on('RMDIR', guard((id, p) => { fs.rmdirSync(real(p)); sftp.status(id, STATUS_CODE.OK); }));
  sftp.on('REMOVE', guard((id, p) => { fs.unlinkSync(real(p)); sftp.status(id, STATUS_CODE.OK); }));
  sftp.on('RENAME', guard((id, a, b) => {
    if (fs.existsSync(real(b))) throw new Error('la destination existe');
    fs.renameSync(real(a), real(b));
    sftp.status(id, STATUS_CODE.OK);
  }));
  sftp.on('error', () => {});
}

export function randomName(prefix = 'x') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}
