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
import { Db } from '../server/db/index.js';
import * as cl from '../server/lib/claude.js';
import { classifyAddress } from '../server/lib/netcheck.js';
import { tokenMatches, FailureLimiter, originAllowed } from '../server/lib/auth.js';
import { buildTarget } from '../server/lib/proxy.js';
import { SshPool } from '../server/lib/ssh.js';
import { TerminalManager } from '../server/lib/terminal.js';

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
  const file = path.join(dir, 'corvus.db');
  const db = new Db(file);
  test('chiffrement, persistance, rien en clair', () => {
    const v1 = new Vault(db, { token: 'cv_token_de_test_suffisamment_long_123' });
    v1.set('h1', { password: 'TrèsSecret!' });
    db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(!fs.readFileSync(file).includes(Buffer.from('TrèsSecret')));
    const v2 = new Vault(db, { token: 'cv_token_de_test_suffisamment_long_123' });
    assert.equal(v2.get('h1').password, 'TrèsSecret!');
    const blob = v2.encryptBuffer(Buffer.from('contenu'));
    assert.equal(v1.decryptBuffer(blob).toString(), 'contenu');
  });
  test('mauvais token → refus explicite', () => {
    assert.throws(() => new Vault(db, { token: 'cv_autre_token_complètement_différent' }), /déchiffrer/);
  });
  test('migration vers une passphrase maître, puis passphrase exigée', () => {
    const v3 = new Vault(db, { token: 'cv_token_de_test_suffisamment_long_123', passphrase: 'phrase maître' });
    assert.equal(v3.get('h1').password, 'TrèsSecret!');
    assert.equal(db.getMeta('vault.kdf').src, 'passphrase');
    assert.throws(() => new Vault(db, { token: 'cv_token_de_test_suffisamment_long_123' }), /CORVUS_MASTER_PASSPHRASE/);
    assert.throws(() => new Vault(db, { token: 'x', passphrase: 'mauvaise' }), /incorrecte/);
    assert.equal(new Vault(db, { token: 'x', passphrase: 'phrase maître' }).get('h1').password, 'TrèsSecret!');
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

describe('correctifs de l\'audit', () => {
  test('proxy : le chemin ne peut jamais changer d\'hôte ni sortir du préfixe', () => {
    const base = new URL('http://100.64.0.5:8080');
    assert.equal(buildTarget(base, '/a/b?x=1').href, 'http://100.64.0.5:8080/a/b?x=1');
    assert.equal(buildTarget(base, '/').pathname, '/');
    // Ces chemins étaient interprétés comme « autre hôte » par new URL().
    for (const evil of ['//127.0.0.1:7680/api/health', '///127.0.0.1/x', '/\\\\127.0.0.1/x', '\\\\127.0.0.1\\x']) {
      const t = buildTarget(base, evil);
      assert.equal(t.host, '100.64.0.5:8080', `hôte conservé pour ${evil}`);
    }
    const sub = new URL('http://100.64.0.5:3000/grafana');
    assert.equal(buildTarget(sub, '/d/abc').pathname, '/grafana/d/abc');
    assert.equal(buildTarget(sub, '//127.0.0.1/x').host, '100.64.0.5:3000');
    assert.throws(() => buildTarget(sub, '/../admin'), /sort du service/);
  });

  test('limiteur : le volume global ne bloque pas un autre appareil (pas de déni de service)', () => {
    const l = new FailureLimiter({ maxPerIp: 10, windowMs: 60_000, maxGlobal: 5 });
    for (let i = 0; i < 20; i++) l.fail(`10.0.0.${i}`);
    assert.equal(l.blockedFor('100.64.0.1'), 0, 'le propriétaire peut toujours se connecter');
    assert.ok(l.fail('10.0.0.99') >= 4000, 'mais la pénalité augmente');
  });

  test('SSH : une connexion tenue (transfert SFTP) n\'est pas fermée par le « reaper »', () => {
    const pool = new SshPool({ hosts: {}, knownHosts: {}, config: { sshIdleMs: 1000 } });
    let ended = 0;
    const conn = { hostId: 'h', client: { end: () => { ended++; } }, lastUsed: Date.now() - 60_000, channels: 0, closed: false };
    pool.conns.set('h', conn);
    const release = pool.hold('h');
    pool.reap();
    assert.equal(ended, 0, 'tenue : pas fermée');
    release();
    release(); // idempotent
    assert.equal(conn.channels, 0);
    conn.lastUsed = Date.now() - 60_000;
    pool.reap();
    assert.equal(ended, 1, 'inactive : fermée');
    pool.closeAll();
  });

  test('terminal : les notifications OSC 777 sont limitées en débit', () => {
    const got = [];
    const tm = new TerminalManager({ config: {}, onNotify: (n) => got.push(n) });
    const s = { id: 's1', hostId: 'h1', title: 'T', oscTail: '' };
    const osc = (body) => Buffer.from(`\x1b]777;notify;Titre;${body}\x07`);
    for (let i = 0; i < 500; i++) tm.scanNotify(s, osc(`n${i}`));
    assert.equal(got.length, 1, 'une seule notification dans la fenêtre');
    s.lastNotify -= 10_000;
    tm.scanNotify(s, osc('plus tard'));
    assert.equal(got.length, 2);
    assert.equal(got[1].body, 'plus tard');
  });
});

describe('contrôle vocal : parseUtterance', async () => {
  const { parseUtterance: pu } = await import('../public/js/voice.js');
  const flat = (t, o) => pu(t, o).map((a) => a.v);
  test('commandes seules', () => {
    assert.deepEqual(flat('Entrée'), ['\r']);
    assert.deepEqual(flat('Annule.'), ['\x03']);
    assert.deepEqual(flat('trois'), ['3']);
    assert.deepEqual(pu('Monte'), [{ kind: 'scroll', v: -1 }]);
    assert.deepEqual(pu("Arrête l'écoute"), [{ kind: 'stop' }]);
  });
  test("le texte n'est exécuté qu'avec « entrée »", () => {
    assert.deepEqual(flat('Liste les fichiers.'), ['liste les fichiers']);
    assert.deepEqual(flat('git status envoie'), ['git status', '\r']);
    assert.deepEqual(flat('annule la commande'), ['annule la commande']);
  });
  test('symboles et chemins', () => {
    assert.deepEqual(flat('ls tiret la'), ['ls -la']);
    assert.deepEqual(flat('cd slash var slash log'), ['cd /var/log']);
    assert.deepEqual(flat('cd tilde slash corvus'), ['cd ~/corvus']);
    assert.deepEqual(flat('cd point point slash'), ['cd ../']);
    assert.deepEqual(flat('cat a point txt'), ['cat a.txt']);
    assert.deepEqual(flat('ls pipe grep foo'), ['ls | grep foo']);
  });
  test('onglet Claude : la casse est conservée', () => {
    assert.deepEqual(flat('Corrige le bug.', { shell: false }), ['Corrige le bug.']);
    assert.deepEqual(flat('Corrige le bug.', { shell: true }), ['corrige le bug']);
  });
});

describe('audit 2 : rotation du token et limiteur', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-audit2-'));

  test('une session créée avec l\'ancien token est invalide après rotation, même réécrite par le serveur', async () => {
    const { Auth } = await import('../server/lib/auth.js');
    const db = new Db(':memory:');
    const oldAuth = new Auth({ db, token: 'cv_ancien_token_suffisamment_long_123456', sessionTtlDays: 1 });
    const sid = oldAuth.createSession({ ua: 'test', ip: '127.0.0.1' });
    assert.equal(oldAuth.validSession(sid), true);
    // Le CLI révoque, puis le serveur encore lancé crée une session avec l'ancien token.
    new Auth({ db, token: 'cv_nouveau_token_suffisamment_long_654321', sessionTtlDays: 1 }).revokeAll();
    const sid2 = oldAuth.createSession({ ua: 'test', ip: '127.0.0.1' });
    const restarted = new Auth({ db, token: 'cv_nouveau_token_suffisamment_long_654321', sessionTtlDays: 1 });
    assert.equal(restarted.validSession(sid), false);
    assert.equal(restarted.validSession(sid2), false);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM auth_sessions').n, 0);
  });

  test('le coffre refuse d\'écraser un fichier re-chiffré par ailleurs', () => {
    const db = new Db(':memory:');
    const running = new Vault(db, { token: 'cv_token_a' });
    running.set('h1', { password: 'x' });
    const cli = new Vault(db, { token: 'cv_token_a' });
    cli.rekey({ token: 'cv_token_b' });
    assert.throws(() => running.set('h2', { password: 'y' }), (e) => e.code === 'VAULT_ROTATED');
    assert.deepEqual(new Vault(db, { token: 'cv_token_b' }).get('h1'), { password: 'x' });
  });

  test('le limiteur élague aussi lors des échecs', () => {
    const l = new FailureLimiter({ maxPerIp: 3, windowMs: 50 });
    for (let i = 0; i < 3; i++) l.fail('1.2.3.4');
    assert.ok(l.blockedFor('1.2.3.4') > 0);
    const until = Date.now() + 60;
    while (Date.now() < until) { /* attendre la fenêtre */ }
    l.fail('5.6.7.8');
    assert.equal(l.byIp.has('1.2.3.4'), false);
    assert.equal(l.global.length, 1);
  });
});

describe('étape 0 : base SQLite, migration, stockage', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-db-'));

  test('migrations versionnées, idempotentes, mode WAL', () => {
    const file = path.join(tmp(), 'corvus.db');
    const db = new Db(file);
    const v = db.version;
    assert.ok(v >= 1);
    assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');
    db.close();
    const again = new Db(file);
    assert.equal(again.version, v);
    again.close();
  });

  test('transactions : annulation complète en cas d\'erreur', () => {
    const db = new Db(':memory:');
    assert.throws(() => db.tx(() => {
      db.setMeta('a', 1);
      db.tx(() => db.setMeta('b', 2));
      throw new Error('boum');
    }), /boum/);
    assert.equal(db.getMeta('a'), null);
    assert.equal(db.getMeta('b'), null);
  });

  test('migration automatique des anciens fichiers JSON (secrets, hôtes, journal chaîné)', async () => {
    const crypto = await import('node:crypto');
    const { createCorvus } = await import('../server/app.js');
    const dataDir = tmp();
    const token = 'cv_ancien_token_pour_migration_0123456789';
    fs.writeFileSync(path.join(dataDir, 'token'), token);
    // Ancien coffre (format v1) chiffré avec le token.
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(token, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 2 ** 15 * 8 * 2 });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from('corvus-secrets-v1'));
    const ct = Buffer.concat([c.update(JSON.stringify({ abcdef0123456789: { password: 'pw-legacy' } })), c.final()]);
    fs.writeFileSync(path.join(dataDir, 'secrets.enc.json'), JSON.stringify({
      v: 1, kdf: { alg: 'scrypt', src: 'token', salt: salt.toString('base64'), N: 2 ** 15, r: 8, p: 1 },
      box: { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') },
    }));
    fs.writeFileSync(path.join(dataDir, 'hosts.json'), JSON.stringify({ hosts: [{
      id: 'abcdef0123456789', name: 'Pi', hostname: '100.64.0.1', port: 22, username: 'pi', authType: 'password',
      icon: 'pi', group: 'Maison', pinned: true, tmux: true, tmuxSession: 'corvus', repos: ['~/app'], tailscale: { dnsName: 'pi.ts.net', os: 'linux' },
      createdAt: 1, updatedAt: 2,
    }] }));
    fs.writeFileSync(path.join(dataDir, 'known_hosts.json'), JSON.stringify({ hosts: { '100.64.0.1:22': { fingerprint: 'SHA256:abc', type: 'ssh-ed25519', addedAt: 3 } } }));
    fs.writeFileSync(path.join(dataDir, 'journal.jsonl'), [
      JSON.stringify({ ts: '2025-01-01T00:00:00.000Z', type: 'auth', event: 'login', ok: true, detail: 'depuis x' }),
      JSON.stringify({ ts: '2025-01-02T00:00:00.000Z', type: 'terminal', event: 'open', ok: true, hostId: 'abcdef0123456789', host: 'Pi' }),
    ].join('\n') + '\n');

    const corvus = createCorvus({ dataDir, logLevel: 'error', port: 0 });
    const { hosts, vault, journal, knownHosts, db } = corvus.ctx;
    const h = hosts.get('abcdef0123456789');
    assert.equal(h.name, 'Pi');
    assert.equal(h.pinned, true);
    assert.deepEqual(h.repos, ['~/app']);
    assert.equal(h.tailscale.dnsName, 'pi.ts.net');
    assert.equal(vault.get('abcdef0123456789').password, 'pw-legacy');
    assert.equal(knownHosts.get('100.64.0.1', 22).fingerprint, 'SHA256:abc');
    assert.equal(journal.list({}).length, 2);
    assert.equal(journal.verify().ok, true);
    assert.ok(fs.existsSync(path.join(dataDir, 'hosts.json.migrated')));
    assert.ok(!fs.existsSync(path.join(dataDir, 'hosts.json')));
    assert.ok(db.getMeta('legacy.migrated').summary.hosts === 1);
    await corvus.close();
  });

  test('stockage séparé (SSD) : la base va dans CORVUS_STORAGE ; disque absent → refus clair', async () => {
    const { createCorvus } = await import('../server/app.js');
    const dataDir = tmp();
    const storageDir = tmp();
    const corvus = createCorvus({ dataDir, storageDir, logLevel: 'error', port: 0 });
    assert.ok(fs.existsSync(path.join(storageDir, 'corvus.db')));
    assert.ok(!fs.existsSync(path.join(dataDir, 'corvus.db')));
    const st = corvus.ctx.storageMonitor.status();
    assert.equal(st.length, 2);
    assert.ok(st[0].free > 0);
    await corvus.close();
    assert.throws(() => createCorvus({ dataDir, storageDir: path.join(storageDir, 'pas-monte'), logLevel: 'error' }), /non monté/);
  });

  test('espace faible → une seule alerte tant que la situation dure', async () => {
    const { StorageMonitor } = await import('../server/lib/storage.js');
    const raised = [];
    const m = new StorageMonitor({ storage: { dir: tmp(), custom: false }, config: { minFreeMb: 1e12 }, alerts: { raise: (a) => raised.push(a) } });
    m.check();
    m.check();
    assert.equal(raised.length, 1);
    assert.equal(raised[0].kind, 'disk-space');
  });

  test('journal chaîné : toute modification est détectée', async () => {
    const { Journal } = await import('../server/lib/journal.js');
    const db = new Db(':memory:');
    const j = new Journal(db);
    for (let i = 0; i < 5; i++) j.add({ type: 'test', event: `e${i}`, detail: `d${i}` });
    assert.deepEqual(j.verify().ok, true);
    db.run("UPDATE audit SET detail = 'falsifié' WHERE seq = 3");
    const r = j.verify();
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, 3);
    db.run("UPDATE audit SET detail = 'd2' WHERE seq = 3");
    db.run('DELETE FROM audit WHERE seq = 2');
    assert.equal(j.verify().brokenAt, 3);
  });
});

describe('étape 0.3 : blobs, rétention, sauvegarde', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'corvus-03-'));

  test('blobs : compressés, chiffrés, dédupliqués, libérés', async () => {
    const { BlobStore } = await import('../server/lib/blobs.js');
    const db = new Db(':memory:');
    const vault = new Vault(db, { token: 'cv_token_blobs_0123456789' });
    const dir = tmp();
    const blobs = new BlobStore({ db, vault, dir });
    const content = Buffer.from('ligne de log répétée\n'.repeat(2000));
    const sha = blobs.put(content, 'test');
    assert.equal(blobs.put(content, 'test'), sha);
    const onDisk = fs.readFileSync(blobs.file(sha));
    assert.ok(onDisk.length < content.length / 10, 'compressé');
    assert.ok(!onDisk.includes(Buffer.from('ligne de log')), 'chiffré');
    assert.deepEqual(blobs.get(sha), content);
    blobs.release(sha);
    assert.ok(fs.existsSync(blobs.file(sha)), 'encore une référence');
    blobs.release(sha);
    assert.ok(!fs.existsSync(blobs.file(sha)));
    assert.equal(blobs.stats().count, 0);
  });

  test('rétention : agrégation horaire puis purge des points bruts', async () => {
    const { Retention } = await import('../server/lib/retention.js');
    const db = new Db(':memory:');
    const H = 3600_000;
    const now = 100 * 24 * H;
    for (let i = 0; i < 6; i++) db.run('INSERT INTO metrics_raw (host_id, metric, ts, value) VALUES (?, ?, ?, ?)', 'h', 'cpu', now - 10 * 24 * H + i * 600_000, i * 10);
    db.run('INSERT INTO metrics_raw (host_id, metric, ts, value) VALUES (?, ?, ?, ?)', 'h', 'cpu', now - H / 2, 5);
    const ret = new Retention({ db, blobs: { release() {} }, config: { retention: { metricsRawDays: 7, metricsHourlyDays: 365, recordingsDays: 90, undoDays: 30 } } });
    const out = ret.run(now);
    assert.equal(out.metricsRaw, 6);
    // Heure en cours (now + 1 min) : pas encore agrégée.
    db.run('INSERT INTO metrics_raw (host_id, metric, ts, value) VALUES (?, ?, ?, ?)', 'h', 'cpu', now + 60_000, 7);
    ret.run(now + 120_000);
    const hourly = db.all('SELECT * FROM metrics_hourly ORDER BY hour');
    assert.equal(hourly.length, 2);
    assert.equal(hourly[1].avg, 5);
    assert.deepEqual([hourly[0].min, hourly[0].max, hourly[0].avg, hourly[0].n], [0, 50, 25, 6]);
  });

  test('sauvegarde chiffrée → restauration au redémarrage', async () => {
    const { createCorvus } = await import('../server/app.js');
    const dataDir = tmp();
    const a = createCorvus({ dataDir, logLevel: 'error' });
    a.ctx.hosts.create({ name: 'Avant', hostname: '100.64.0.9', username: 'pi', password: 'secret-restaure' });
    const sha = a.ctx.blobs.put(Buffer.from('enregistrement'), 'rec');
    const backup = await a.ctx.backups.create('mot de passe long', null);
    assert.ok(backup.size > 100);
    const file = path.join(a.ctx.storage.backupDir, backup.name);
    assert.ok(!fs.readFileSync(file).includes(Buffer.from('secret-restaure')));
    await assert.rejects(a.ctx.backups.stage(file, 'mauvais mot de passe', null), (e) => e.code === 'BAD_PASSWORD');
    // Modification après la sauvegarde : doit disparaître après restauration.
    a.ctx.hosts.create({ name: 'Après', hostname: '100.64.0.10', username: 'pi' });
    await a.ctx.backups.stage(file, 'mot de passe long', null);
    await a.close();

    const b = createCorvus({ dataDir, logLevel: 'error' });
    assert.ok(b.ctx.restoredFrom, 'restauration appliquée');
    assert.deepEqual(b.ctx.hosts.hosts.map((h) => h.name), ['Avant']);
    const id = b.ctx.hosts.hosts[0].id;
    assert.equal(b.ctx.vault.get(id).password, 'secret-restaure');
    assert.equal(b.ctx.blobs.get(sha).toString(), 'enregistrement');
    await b.close();
  });
});

describe('étape 2 : robustesse et métriques', () => {
  test('diskstats : disques entiers seulement ; snmp TCP', async () => {
    const { parseDiskstats, parseSnmpTcp } = await import('../server/lib/monitor.js');
    const d = parseDiskstats([
      '   8       0 sda 1200 10 48000 300 800 20 64000 900 0 1000 1200 0 0 0 0',
      '   8       1 sda1 1100 10 44000 280 790 20 63000 880 0 990 1160 0 0 0 0',
      '   7       0 loop0 50 0 400 1 0 0 0 0 0 4 1 0 0 0 0',
      ' 179       0 mmcblk0 10 0 80 1 5 0 40 1 0 2 2 0 0 0 0',
    ]);
    assert.deepEqual(d.map((x) => x.name), ['sda', 'mmcblk0']);
    assert.equal(d[0].readBytes, 48000 * 512);
    const t = parseSnmpTcp(['Tcp: RtoAlgorithm RtoMin CurrEstab RetransSegs', 'Tcp: 1 200 12 345']);
    assert.equal(t.CurrEstab, 12);
    assert.equal(t.RetransSegs, 345);
  });

  test('métriques : aplatissement, historique regroupé par plage', async () => {
    const { MetricsCollector, flatten } = await import('../server/lib/metrics.js');
    const rows = flatten({ cpu: 12, cpuCores: [10, null], mem: { percent: 40 }, disk: { readBps: 5 }, disks: [{ mount: '/', percent: 70 }], tcp: { established: 3 } });
    assert.deepEqual(rows.map((r) => r.metric).sort(), ['cpu', 'cpu.0', 'df:/', 'disk.read', 'mem', 'tcp.estab'].sort());
    const db = new Db(':memory:');
    const m = new MetricsCollector({ db, hosts: { hosts: [] }, monitor: null });
    const now = Date.now();
    for (let i = 0; i < 20; i++) m.store('h', { ts: now - i * 30_000, cpu: i, mem: { percent: 50 } });
    const hist = m.history('h', ['cpu', 'mem'], '1h', now);
    assert.ok(hist.points.length >= 10 && hist.points.length <= 20);
    assert.equal(hist.points.at(-1).values.mem, 50);
    assert.deepEqual(m.history('h', ['cpu'], '24h', now).points.length <= 3, true);
  });

  test('état des hôtes : injoignable depuis…, alerte après le seuil, re-test espacé', async () => {
    const { HostStatus } = await import('../server/lib/hoststatus.js');
    const db = new Db(':memory:');
    db.run("INSERT INTO hosts (id, name, hostname, username, auth_type, created_at, updated_at) VALUES ('h1', 'Pi', '100.64.0.1', 'pi', 'password', 0, 0)");
    const raised = [];
    let up = false;
    const hs = new HostStatus({
      db, hosts: { hosts: [{ id: 'h1', name: 'Pi', hostname: 'x', port: 22 }], find: () => ({ name: 'Pi' }) },
      pool: { status: () => ({ connected: false }) }, alerts: { raise: (a) => raised.push(a) },
      downAlertMin: 0, probe: async () => (up ? { ok: true, latencyMs: 3 } : { ok: false, error: 'ECONNREFUSED' }),
    });
    const s1 = await hs.check({ id: 'h1', hostname: 'x', port: 22 });
    assert.equal(s1.state, 'down');
    assert.equal(raised[0].kind, 'host-down');
    const firstDelay = hs.nextAt.get('h1') - Date.now();
    await hs.check({ id: 'h1', hostname: 'x', port: 22 });
    assert.ok(hs.nextAt.get('h1') - Date.now() > firstDelay, 'nouvelle tentative plus espacée');
    assert.equal(hs.get('h1').since, s1.since, '« depuis » conservé tant que l\'état ne change pas');
    up = true;
    const s3 = await hs.check({ id: 'h1', hostname: 'x', port: 22 });
    assert.equal(s3.state, 'up');
    assert.equal(s3.latencyMs, 3);
  });
});

describe('étapes 4 et 5.1 : règles, suggestions, administration', () => {
  test('commandes risquées : niveaux, raisons, fichiers à sauvegarder', async () => {
    const { analyze } = await import('../server/lib/risk.js');
    assert.equal(analyze('ls -la /etc').level, 'safe');
    const rm = analyze('rm -rf build "mon dossier"');
    assert.equal(rm.level, 'danger');
    assert.deepEqual(rm.files, ['build', 'mon dossier']);
    assert.equal(rm.undoable, true);
    assert.equal(analyze('rm -rf /').reasons.some((r) => /extrêmement large/.test(r)), true);
    const sed = analyze("sed -i 's/a/b/' conf.ini");
    assert.deepEqual(sed.files, ['conf.ini']);
    assert.equal(sed.undoable, true);
    const redir = analyze('echo bonjour > notes.txt 2>&1');
    assert.deepEqual(redir.files, ['notes.txt']);
    assert.equal(redir.level, 'caution');
    const sub = analyze('rm $(cat liste)');
    assert.equal(sub.undoable, false, 'substitution : jamais de promesse d\'annulation');
    assert.equal(sub.preview, true);
    const sudo = analyze('sudo rm /etc/motd');
    assert.equal(sudo.undoable, false);
    assert.equal(sudo.level, 'danger');
    assert.ok(analyze('systemctl stop nginx').notUndoable.includes('services (systemd)'));
    assert.equal(analyze('curl https://x.sh | sh').level, 'danger');
    assert.equal(analyze('git push --force').level, 'danger');
    assert.equal(analyze('chmod -R 777 .').undoable, false);
    assert.equal(analyze('mv a.txt b.txt').files.length, 2);
  });

  test('chemins pour le shell distant : jokers actifs, reste cité', async () => {
    const { globWord } = await import('../server/lib/undo.js');
    assert.equal(globWord('~/a b/*.txt'), `"$HOME"'/a b/'*'.txt'`);
    assert.equal(globWord("l'x"), `'l'\\''x'`);
    assert.equal(globWord('f[0-9]'), `'f'[0-9]`);
  });

  test('suggestions : fréquence × récence, n-grammes, séquences répétées, historique shell', async () => {
    const { rankHistory, nextCommands, repeatedSequences, parseShellHistory } = await import('../server/lib/predict.js');
    const now = Date.now();
    const h = (cmds) => cmds.map((command, i) => ({ command, ts: now - (cmds.length - i) * 1000 }));
    const hist = h(['git status', 'git add -A', 'git commit', 'ls', 'git status', 'git add -A', 'git commit', 'cd ~', 'git status', 'git add -A', 'git commit', 'git status']);
    assert.equal(rankHistory(hist, 'git ')[0].command, 'git status');
    assert.equal(nextCommands(hist, ['git status'])[0].command, 'git add -A');
    assert.equal(nextCommands(hist, ['git status', 'git add -A'])[0].command, 'git commit');
    const seq = repeatedSequences(hist);
    assert.deepEqual(seq[0].commands, ['git status', 'git add -A', 'git commit']);
    assert.equal(seq[0].count, 3);
    const parsed = parseShellHistory(': 1700000000:0;ls -la\n#1700000100\ncd /tmp\nsans date\n');
    assert.deepEqual(parsed.map((x) => x.command), ['ls -la', 'cd /tmp', 'sans date']);
    assert.equal(parsed[0].ts, 1700000000000);
  });

  test('administration : services, journal, ufw, utilisateurs, mises à jour', async () => {
    const a = await import('../server/lib/hostadmin.js');
    const units = a.parseUnits('nginx.service loaded active running A high performance web server\n● bad.service loaded failed failed Bad\n##files\nnginx.service enabled enabled\nbad.service enabled enabled\nold.service disabled enabled\n');
    assert.equal(units[0].name, 'bad.service', 'services en échec en premier');
    assert.equal(units.find((u) => u.name === 'nginx.service').enabled, 'enabled');
    assert.ok(units.some((u) => u.name === 'old.service' && u.load === 'not-loaded'));
    const j = a.parseJournal('{"__REALTIME_TIMESTAMP":"1700000000000000","PRIORITY":"3","SYSLOG_IDENTIFIER":"sshd","MESSAGE":"Failed password","__CURSOR":"s=1;i=2"}\n');
    assert.equal(j.entries[0].priority, 3);
    assert.equal(j.cursor, 's=1;i=2');
    const u = a.parseUfw('Status: active\n\n     To                         Action      From\n     --                         ------      ----\n[ 1] 22/tcp                     ALLOW IN    Anywhere\n');
    assert.equal(u.active, true);
    assert.equal(u.rules[0].num, 1);
    const users = a.parsePasswd('root:x:0:0:root:/root:/bin/bash\npi:x:1000:1000:Pi,,,:/home/pi:/bin/bash\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\n', 'sudo:x:27:pi\npi:x:1000:\n');
    assert.equal(users.find((x) => x.name === 'pi').admin, true);
    assert.equal(users.find((x) => x.name === 'www-data').login, false);
    const up = a.parseUpdates('apt', 'Listing...\nopenssl/stable-security 3.0.15-1 arm64 [upgradable from: 3.0.14-1]\n');
    assert.deepEqual([up[0].name, up[0].version, up[0].from, up[0].security], ['openssl', '3.0.15-1', '3.0.14-1', true]);
    assert.equal(a.unitName('nginx'), 'nginx.service');
    assert.throws(() => a.unitName('--help'));
    assert.throws(() => a.unitName('a;b'));
  });
});
