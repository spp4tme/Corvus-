// Journal local des connexions (terminal, SFTP, git…), stocké en JSONL dans le dossier de données.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileSecure } from './store.js';

const MAX_ENTRIES = 5000;
const TYPES = new Set(['terminal', 'sftp', 'git', 'monitor', 'docker', 'proxy', 'auth', 'test']);

export class Journal {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'journal.jsonl');
    this.count = 0;
    try {
      this.count = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).length;
    } catch { /* nouveau journal */ }
  }

  /**
   * @param {{type: string, event: string, host?: {id: string, name: string, hostname: string}, detail?: string, ok?: boolean}} e
   */
  add(e) {
    if (!TYPES.has(e.type)) return;
    const entry = {
      ts: new Date().toISOString(),
      type: e.type,
      event: String(e.event).slice(0, 40),
      ok: e.ok !== false,
      hostId: e.host?.id,
      host: e.host ? `${e.host.name} (${e.host.username ? e.host.username + '@' : ''}${e.host.hostname})` : undefined,
      detail: e.detail ? String(e.detail).slice(0, 300) : undefined,
    };
    try {
      if (!fs.existsSync(this.file)) writeFileSecure(this.file, '');
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      this.count++;
      if (this.count > MAX_ENTRIES * 1.2) this.compact();
    } catch { /* le journal ne doit jamais casser une action */ }
  }

  compact() {
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-MAX_ENTRIES);
    writeFileSecure(this.file, lines.join('\n') + '\n');
    this.count = lines.length;
  }

  list({ limit = 200, type, hostId } = {}) {
    let lines;
    try {
      lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (type && e.type !== type) continue;
        if (hostId && e.hostId !== hostId) continue;
        out.push(e);
      } catch { /* ligne corrompue ignorée */ }
    }
    return out;
  }

  clear() {
    writeFileSecure(this.file, '');
    this.count = 0;
  }
}
