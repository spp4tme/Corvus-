// Drop-ins systemd de l'agent : vérifications statiques des droits dont dépendent les fonctions (constatées sur le Pi, point D).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'agent');
const conf = (name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter((l) => !l.startsWith('#'));
const value = (lines, key) => (lines.find((l) => l.startsWith(`${key}=`)) || '').slice(key.length + 1).split(/\s+/).filter(Boolean);

describe('drop-ins systemd de l\'agent', () => {
  for (const name of ['corvus-agent-preview.conf', 'corvus-agent-full.conf']) {
    test(`${name} : CAP_SETUID et CAP_SETGID sont ambiantes (sinon setpriv --reuid échoue : « setresuid failed »)`, () => {
      const lines = conf(name);
      const ambient = value(lines, 'AmbientCapabilities');
      for (const cap of ['CAP_SETUID', 'CAP_SETGID']) {
        assert.ok(ambient.includes(cap), `${cap} absent de AmbientCapabilities`);
        assert.ok(value(lines, 'CapabilityBoundingSet').includes(cap), `${cap} absent de CapabilityBoundingSet`);
      }
    });
  }
});
