// Tests unitaires : parseurs sur de vraies sorties Linux, échappement shell, validation, coffre.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePs, MonitorService } from '../server/lib/monitor.js';
import { parseStatus } from '../server/lib/git.js';
import { q, qPath, shWrap } from '../server/lib/shell.js';
import * as v from '../server/lib/validate.js';
import { Vault } from '../server/lib/vault.js';
import * as cl from '../server/lib/claude.js';
import { classifyAddress } from '../server/lib/netcheck.js';
import { tokenMatches, FailureLimiter, originAllowed } from '../server/lib/auth.js';

// Sortie réelle (Raspberry Pi 4, Raspberry Pi OS 64 bits), deux relevés à 3 s d'intervalle.
const PI_SAMPLE = (cpu, rx, tx) => `##stat
${cpu}
##meminfo
MemTotal:        3884096 kB
MemFree:          912340 kB
MemAvailable:    2617344 kB
Buffers:          120448 kB
Cached:          1489920 kB
SwapTotal:        102396 kB
SwapFree:         102396 kB
##loadavg
0.42 0.31 0.25 2/412 12345
##uptime
356218.43 1381234.11
##netdev
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  918273    9182    0    0    0     0          0         0   918273    9182    0    0    0     0       0          0
  eth0: ${rx} 912874    0    0    0     0          0      1832 ${tx} 734121    0    0    0     0       0          0
tailscale0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
##df
Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/root         30358316 12345678  16737432      43% /
devtmpfs           1800000        0   1800000       0% /dev
tmpfs              1942048     1024   1941024       1% /dev/shm
/dev/mmcblk0p1      522228    51232    471000      10% /boot/firmware
/dev/sda1        961302560 870000000  42000000      96% /mnt/nas
overlay           30358316 12345678  16737432      43% /var/lib/docker/overlay2/abc/merged
##uname
Linux raspberrypi 6.6.31+rpt-rpi-v8 aarch64
##nproc
4
##temp
51121
##end
`;

describe('supervision : parseurs Linux', () => {
  test('stats complètes et deltas CPU/réseau', async () => {
    const outputs = [
      PI_SAMPLE('cpu  10000 0 5000 85000 1000 0 100 0 0 0', 1000000, 500000),
      PI_SAMPLE('cpu  10300 0 5100 85500 1000 0 100 0 0 0', 1300000, 560000),
    ];
    let n = 0;
    const fakePool = { exec: async () => ({ code: 0, stdout: Buffer.from(outputs[n++]), stderr: '' }) };
    const m = new MonitorService({ pool: fakePool, hosts: {}, journal: {} });
    const first = await m.stats('h');
    assert.equal(first.hostname, 'raspberrypi');
    assert.equal(first.kernel, 'Linux 6.6.31+rpt-rpi-v8');
    assert.equal(first.arch, 'aarch64');
    assert.equal(first.cores, 4);
    assert.deepEqual(first.load, [0.42, 0.31, 0.25]);
    assert.equal(Math.round(first.uptime), 356218);
    assert.equal(first.temp, 51.121);
    assert.equal(first.mem.total, 3884096 * 1024);
    assert.equal(Math.round(first.mem.percent), Math.round(100 * (3884096 - 2617344) / 3884096));
    assert.equal(first.swap.used, 0);
    assert.deepEqual(first.disks.map((d) => d.mount), ['/', '/boot/firmware', '/mnt/nas'], 'pseudo-FS exclus');
    assert.ok(first.disks[2].percent > 90);
    assert.deepEqual(first.net.ifaces.map((i) => i.name), ['eth0', 'tailscale0'], 'lo exclu');
    // 2e relevé : CPU = (300+100+0) occupé / 900 total = 44,4 %
    await new Promise((r) => setTimeout(r, 20));
    const second = await m.stats('h');
    assert.ok(Math.abs(second.cpu - (400 / 900) * 100) < 0.01, `cpu ${second.cpu}`);
    assert.ok(second.net.rxRate > 0 && second.net.txRate > 0);
    assert.ok(second.net.rxRate > second.net.txRate);
  });

  test('ps -eo (procps) avec arguments contenant des espaces', () => {
    const out = [
      '    1 root      0.0  0.3 12288 systemd         /sbin/init splash',
      ' 4321 pi       12.5  4.1 165432 node           node /home/pi/corvus/server/index.js --port 7680',
      '  812 www-data  0.3  1.0 40960 nginx           nginx: worker process',
    ].join('\n');
    const p = parsePs(out);
    assert.equal(p.length, 3);
    assert.deepEqual(p[1], { pid: 4321, user: 'pi', cpu: 12.5, mem: 4.1, rss: 165432 * 1024, command: 'node', args: 'node /home/pi/corvus/server/index.js --port 7680' });
    assert.equal(p[2].args, 'nginx: worker process');
  });

  test('ps avec en-tête (busybox / repli)', () => {
    const out = 'PID   USER     TIME  COMMAND\n    1 root      0:03 /sbin/init\n  233 pi        0:00 -ash\n';
    const p = parsePs(out);
    assert.deepEqual(p.map((x) => [x.pid, x.user]), [[1, 'root'], [233, 'pi']]);
    assert.equal(p[0].args, '/sbin/init');
  });
});

describe('git : statut porcelain -z', () => {
  test('branche, amont, avance/retard, renommage, conflit, non suivi', () => {
    const out = [
      '## main...origin/main [ahead 2, behind 1]',
      'M  src/app.js', ' M README.md', 'MM both.txt', 'R  new name.txt', 'old name.txt',
      'UU conflit.txt', '?? nouveau.txt', 'A  ajout.txt', ' D supprimé.txt', '',
    ].join('\0');
    const s = parseStatus(out);
    assert.equal(s.branch, 'main');
    assert.equal(s.upstream, 'origin/main');
    assert.equal(s.ahead, 2);
    assert.equal(s.behind, 1);
    const f = Object.fromEntries(s.files.map((x) => [x.path, x]));
    assert.equal(f['src/app.js'].staged, true);
    assert.equal(f['src/app.js'].unstaged, false);
    assert.equal(f['README.md'].unstaged, true);
    assert.equal(f['both.txt'].staged && f['both.txt'].unstaged, true);
    assert.equal(f['new name.txt'].orig, 'old name.txt');
    assert.equal(f['conflit.txt'].conflict, true);
    assert.equal(f['nouveau.txt'].untracked, true);
    assert.equal(f['supprimé.txt'].y, 'D');
    assert.equal(s.files.length, 8);
  });

  test('dépôt sans commit, HEAD détachée, amont disparu', () => {
    assert.equal(parseStatus('## No commits yet on main\0').initial, true);
    assert.equal(parseStatus('## HEAD (no branch)\0').detached, true);
    const g = parseStatus('## feat...origin/feat [gone]\0');
    assert.equal(g.gone, true);
    assert.equal(g.ahead, 0);
  });
});

describe('échappement shell', () => {
  const evil = ["a'b", '$(id)', '`id`', 'a;b', 'a"b\\c', "'; rm -rf / #", 'é ü 漢字', '-n', '\t\n'];
  test('q() : la valeur ressort à l\'identique dans un vrai sh', { skip: !shAvailable() }, () => {
    for (const s of evil) {
      const out = execFileSync('sh', ['-c', `printf %s ${q(s)}`], { encoding: 'utf8' });
      assert.equal(out, s);
    }
  });
  test('qPath développe ~ hors des quotes uniquement', () => {
    assert.equal(qPath('~'), '"$HOME"');
    assert.equal(qPath("~/a b/c'd"), `"$HOME"/'a b/c'\\''d'`);
    assert.equal(qPath('/srv/~x'), "'/srv/~x'");
  });
  test('NUL refusé', () => assert.throws(() => q('a\0b')));
  test('shWrap', () => assert.equal(shWrap("echo 'x'"), `sh -c 'echo '\\''x'\\'''`));
});

function shAvailable() {
  try { execFileSync('sh', ['-c', 'true']); return true; } catch { return false; }
}

describe('validation', () => {
  test('refs git', () => {
    for (const ok of ['main', 'feature/x-1', 'v1.2.3', 'origin/main', 'fix+a']) assert.equal(v.gitRef(ok), ok);
    for (const bad of ['-x', '--orphan', 'a..b', 'a b', 'a;b', 'x.lock', 'a//b', 'a/.b', 'a@{1}', '$(id)', '/a', 'a/', 'a.']) {
      assert.throws(() => v.gitRef(bad), `devrait refuser ${bad}`);
    }
  });
  test('hôtes, ports, utilisateurs, SHA, conteneurs', () => {
    assert.equal(v.hostname('pi.tailnet-abc.ts.net'), 'pi.tailnet-abc.ts.net');
    assert.equal(v.hostname('100.101.102.103'), '100.101.102.103');
    assert.equal(v.hostname('[fd7a:115c:a1e0::1]'), 'fd7a:115c:a1e0::1');
    for (const bad of ['a b', 'a;b', '$(x)', '-oProxyCommand=x']) assert.throws(() => v.hostname(bad));
    assert.throws(() => v.port(0));
    assert.throws(() => v.username('-oProxy'));
    assert.equal(v.sha('ABCDEF12'), 'abcdef12');
    assert.throws(() => v.sha('HEAD~1'));
    assert.throws(() => v.container('-v'));
    assert.throws(() => v.fileName('../x'));
    assert.throws(() => v.remotePath('a\nb'));
  });
});

describe('coffre chiffré', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-vault-'));
  const file = path.join(dir, 'secrets.enc.json');
  test('chiffrement, persistance, rien en clair', () => {
    const v1 = new Vault(file, { token: 'cv_token_de_test_suffisamment_long_123' });
    v1.set('h1', { password: 'TrèsSecret!' });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('TrèsSecret'));
    const v2 = new Vault(file, { token: 'cv_token_de_test_suffisamment_long_123' });
    assert.equal(v2.get('h1').password, 'TrèsSecret!');
  });
  test('mauvais token → refus explicite', () => {
    assert.throws(() => new Vault(file, { token: 'cv_autre_token_complètement_différent' }), /déchiffrer/);
  });
  test('migration vers une passphrase maître, puis passphrase exigée', () => {
    const v3 = new Vault(file, { token: 'cv_token_de_test_suffisamment_long_123', passphrase: 'phrase maître' });
    assert.equal(v3.get('h1').password, 'TrèsSecret!');
    assert.match(fs.readFileSync(file, 'utf8'), /"src": "passphrase"/);
    assert.throws(() => new Vault(file, { token: 'cv_token_de_test_suffisamment_long_123' }), /CORVUS_MASTER_PASSPHRASE/);
    assert.throws(() => new Vault(file, { token: 'x', passphrase: 'mauvaise' }), /incorrecte/);
    assert.equal(new Vault(file, { token: 'x', passphrase: 'phrase maître' }).get('h1').password, 'TrèsSecret!');
  });
});

describe('réseau et auth', () => {
  test('classification des adresses de bind', () => {
    assert.equal(classifyAddress('127.0.0.1'), 'loopback');
    assert.equal(classifyAddress('100.88.1.2'), 'tailscale');
    assert.equal(classifyAddress('fd7a:115c:a1e0::5'), 'tailscale');
    assert.equal(classifyAddress('192.168.1.10'), 'private');
    assert.equal(classifyAddress('0.0.0.0'), 'any');
    assert.equal(classifyAddress('8.8.8.8'), 'public');
    assert.equal(classifyAddress('2001:4860::1'), 'public');
  });
  test('comparaison de token', () => {
    assert.equal(tokenMatches('abc', 'abc'), true);
    assert.equal(tokenMatches('abd', 'abc'), false);
    assert.equal(tokenMatches(undefined, 'abc'), false);
    assert.equal(tokenMatches('', 'abc'), false);
  });
  test('limiteur : pénalité croissante puis blocage', () => {
    const l = new FailureLimiter({ maxPerIp: 3, windowMs: 60_000, maxGlobal: 100 });
    assert.equal(l.blockedFor('1.2.3.4'), 0);
    const delays = [l.fail('1.2.3.4'), l.fail('1.2.3.4'), l.fail('1.2.3.4')];
    assert.ok(delays[0] < delays[1] && delays[1] < delays[2]);
    assert.ok(l.blockedFor('1.2.3.4') > 0);
    assert.equal(l.blockedFor('5.6.7.8'), 0);
  });
  test('origine : identique, via tailscale serve (X-Forwarded-Host), étrangère', () => {
    const req = (headers) => ({ headers });
    const opts = { allowedOrigins: [], trustForwarded: true };
    assert.equal(originAllowed('http://127.0.0.1:7680', req({ host: '127.0.0.1:7680' }), opts), true);
    assert.equal(originAllowed('https://pi.tail1234.ts.net', req({ host: '127.0.0.1:7680', 'x-forwarded-host': 'pi.tail1234.ts.net' }), opts), true);
    assert.equal(originAllowed('https://evil.ts.net', req({ host: '127.0.0.1:7680', 'x-forwarded-host': 'pi.tail1234.ts.net' }), opts), false);
    assert.equal(originAllowed('null', req({ host: 'x' }), opts), false);
  });
});

describe('Claude Code', () => {
  test('commande : mots simples acceptés, tout le reste refusé', () => {
    assert.equal(v.claudeCmd(undefined), 'claude');
    assert.equal(v.claudeCmd('  '), 'claude');
    assert.equal(v.claudeCmd('claude   --continue'), 'claude --continue');
    assert.equal(v.claudeCmd('claude --model claude-opus-4-1 -c'), 'claude --model claude-opus-4-1 -c');
    for (const bad of ['rm -rf /', 'claude; id', 'claude && id', 'claude | cat', 'claude $(id)', 'claude `id`', 'claude > /tmp/x',
      'claude "a b"', "claude 'x'", 'claude --x=$HOME', '/usr/bin/claude', 'CLAUDE', 'claude ' + '--a '.repeat(13)]) {
      assert.throws(() => v.claudeCmd(bad), { code: 'BAD_REQUEST' }, bad);
    }
    assert.equal(v.claudeDangerous('claude --dangerously-skip-permissions'), true);
    assert.equal(v.claudeDangerous('claude --continue'), false);
  });

  test('dossier : chemin libre sans caractère de contrôle', () => {
    assert.equal(v.claudeDir(''), '');
    assert.equal(v.claudeDir(' ~/projets/a b '), '~/projets/a b');
    assert.throws(() => v.claudeDir('/tmp/a\nb'), { code: 'BAD_REQUEST' });
    assert.throws(() => v.claudeDir('/tmp/a\tb'), { code: 'BAD_REQUEST' });
  });

  test('nom de session : forme corvus-claude-<hôte>-<n> uniquement', () => {
    assert.equal(v.claudeSession('corvus-claude-pi-3'), 'corvus-claude-pi-3');
    for (const bad of ['', 'x', 'corvus-claude-pi', 'corvus-claude-Pi-1', 'corvus-claude-pi-1; id', 'corvus-claude-a b-1', 'corvus-claude--1x']) {
      assert.throws(() => v.claudeSession(bad), { code: 'BAD_REQUEST' }, bad);
    }
  });

  test('numérotation : plus petit numéro libre, alias normalisé', () => {
    const host = { id: 'abcdef0123456789', name: 'Pi du salon é' };
    assert.equal(cl.hostSlug(host), 'pi-du-salon-e');
    assert.equal(cl.hostSlug({ id: 'abcdef0123456789', name: '!!!' }), 'habcdef');
    assert.equal(cl.nextSessionName(host, []), 'corvus-claude-pi-du-salon-e-1');
    assert.equal(cl.nextSessionName(host, ['corvus-claude-pi-du-salon-e-1', 'corvus-claude-pi-du-salon-e-3']), 'corvus-claude-pi-du-salon-e-2');
    assert.ok(cl.sessionName({ id: 'x'.repeat(16), name: 'a'.repeat(80) }, 12).length <= 'corvus-claude-'.length + 20 + 5);
  });

  test('script de lancement : tmux -A, dossier et commande échappés', () => {
    const script = cl.launchScript({ session: 'corvus-claude-pi-1', dir: "~/mon projet d'essai", cmd: 'claude --continue' });
    assert.ok(script.startsWith("sh -c '"));
    assert.ok(script.includes('new-session -A -s'));
    assert.ok(script.includes('has-session'));
    // le dossier passe par qPath : ~ développé hors quotes, apostrophe neutralisée
    assert.ok(script.includes('"$HOME"/'));
    assert.ok(!script.includes("d'essai"), 'apostrophe non échappée');
    // sans dossier : pas d'option -c
    assert.ok(script.includes(' -c "$HOME"/'));
    assert.ok(!cl.launchScript({ session: 'corvus-claude-pi-1', dir: '', cmd: 'claude' }).includes('"$HOME"/'));
    // une session invalide ne produit jamais de script
    assert.throws(() => cl.launchScript({ session: 'x; id', dir: '', cmd: 'claude' }), { code: 'BAD_REQUEST' });
    assert.throws(() => cl.launchScript({ session: 'corvus-claude-pi-1', dir: '', cmd: 'claude; id' }), { code: 'BAD_REQUEST' });
  });

  test('script généré : syntaxe shell valide, même avec des guillemets dans le dossier', () => {
    const script = cl.launchScript({ session: 'corvus-claude-pi-1', dir: '/tmp/a"b\'c $x', cmd: 'claude --continue' });
    execFileSync('bash', ['-n', '-c', script]);
    const m = /^sh -c ('(?:[^']|'\\'')*')$/s.exec(script);
    assert.ok(m, 'enveloppe sh -c unique');
  });

  test('diagnostic : analyse de la sortie (sessions Claude seulement)', () => {
    const out = [
      '##tmux', 'yes', '##claude', '/home/u/.local/bin/claude', '##version', '2.0.1 (Claude Code)', '##dir', 'yes', '##sessions',
      'corvus-claude-pi-1|1700000000|1|1700000500|/home/u/proj', 'corvus-claude-pi-2|1700000100|0|1700000200|/home/u/a|b', 'autre|1|0|1|/', '##end',
    ].join('\n');
    const st = cl.parseStatus(out);
    assert.equal(st.tmux, true);
    assert.deepEqual(st.claude, { installed: true, path: '/home/u/.local/bin/claude', version: '2.0.1 (Claude Code)' });
    assert.equal(st.dirOk, true);
    assert.equal(st.sessions.length, 2);
    assert.equal(st.sessions[0].attached, 1);
    assert.equal(st.sessions[1].cwd, '/home/u/a|b');
    const none = cl.parseStatus('##tmux\nno\n##claude\n##sessions\n##end');
    assert.equal(none.tmux, false);
    assert.equal(none.claude.installed, false);
    assert.equal(none.dirOk, null);
    assert.deepEqual(none.sessions, []);
  });
});
