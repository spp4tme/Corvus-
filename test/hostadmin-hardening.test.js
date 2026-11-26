// Administration d'hôte : la règle sudoers générée exclut les chemins (pas d'unité écrite par l'utilisateur
// installée en root) et le service SSH ne peut être ni arrêté ni désactivé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostAdmin } from '../server/lib/hostadmin.js';

const host = { id: 'h1', name: 'x', hostname: 'x', username: 'pi', port: 22 };
const make = () => {
  const admin = new HostAdmin({ pool: {}, hosts: { get: () => host }, journal: { add() {} } });
  admin.tools = async () => ({ systemctl: '/usr/bin/systemctl', user: 'pi' });
  return admin;
};

test('sudoers : « systemctl … -- */* » (cible avec un /) est explicitement refusé', async () => {
  const { text } = await make().sudoersRule('h1');
  for (const a of ['start', 'stop', 'restart', 'reload', 'enable', 'disable']) {
    assert.match(text, new RegExp(`/usr/bin/systemctl ${a} -- \\*(,|\\n|$)`), `règle ${a}`);
    assert.ok(text.includes(`!/usr/bin/systemctl ${a} -- */*`), `exclusion ${a}`);
  }
  // Les exclusions viennent APRÈS les autorisations (sudoers : la dernière règle qui correspond l'emporte).
  assert.ok(text.indexOf('!/usr/bin/systemctl enable -- */*') > text.indexOf('/usr/bin/systemctl enable -- *,'));
});

test('arrêter ou désactiver ssh est refusé ; le redémarrer reste permis', async () => {
  const admin = make();
  admin.sudo = async () => ({ ok: true });
  for (const unit of ['ssh', 'sshd', 'ssh.service', 'sshd.service', 'ssh.socket']) {
    for (const action of ['stop', 'disable']) {
      await assert.rejects(async () => admin.serviceAction('h1', unit, action), (e) => e.code === 'LOCKOUT', `${action} ${unit}`);
    }
  }
  assert.deepEqual(await admin.serviceAction('h1', 'ssh', 'restart'), { ok: true });
  assert.deepEqual(await admin.serviceAction('h1', 'nginx', 'stop'), { ok: true });
});
