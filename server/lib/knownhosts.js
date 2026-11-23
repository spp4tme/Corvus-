// Vérification des host keys SSH en mode TOFU (Trust On First Use).
import crypto from 'node:crypto';
import path from 'node:path';
import { JsonStore } from './store.js';

export function fingerprint(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

export function keyType(keyBuf) {
  try {
    const len = keyBuf.readUInt32BE(0);
    return keyBuf.subarray(4, 4 + len).toString('ascii');
  } catch {
    return 'inconnu';
  }
}

export class KnownHosts {
  constructor(dataDir) {
    this.store = new JsonStore(path.join(dataDir, 'known_hosts.json'), { hosts: {} });
  }
  static key(hostname, port) {
    return `${hostname}:${port}`;
  }
  get(hostname, port) {
    return this.store.data.hosts[KnownHosts.key(hostname, port)] || null;
  }
  /**
   * @returns {{status: 'known'|'new'|'mismatch', fingerprint, type, expected?}}
   */
  check(hostname, port, keyBuf) {
    const fp = fingerprint(keyBuf);
    const type = keyType(keyBuf);
    const known = this.get(hostname, port);
    if (!known) return { status: 'new', fingerprint: fp, type };
    if (known.fingerprint === fp) return { status: 'known', fingerprint: fp, type };
    return { status: 'mismatch', fingerprint: fp, type, expected: known.fingerprint, expectedType: known.type };
  }
  remember(hostname, port, fp, type) {
    this.store.data.hosts[KnownHosts.key(hostname, port)] = { fingerprint: fp, type, addedAt: Date.now() };
    this.store.save();
  }
  forget(hostname, port) {
    delete this.store.data.hosts[KnownHosts.key(hostname, port)];
    this.store.save();
  }
}
