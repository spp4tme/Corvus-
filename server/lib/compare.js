// Comparer un fichier de configuration entre 2 à 5 hôtes : lecture par SFTP (aucun shell), diff en JS pur.
// Les valeurs sensibles sont masquées CÔTÉ SERVEUR (elles ne quittent pas Corvus sans demande explicite, journalisée).
import * as v from './validate.js';
import { HttpError } from './validate.js';
import { splitLines, hasCrlf, maskLines, sideBySide } from './diff.js';

export const MAX_COMPARE_BYTES = 512 * 1024;
export const MIN_HOSTS = 2;
export const MAX_HOSTS = 5;

export class CompareService {
  constructor({ sftp, hosts, journal }) {
    Object.assign(this, { sftp, hosts, journal });
  }

  /**
   * @param {object} user compte demandeur
   * @param {{ path: string, hostIds: string[], reveal?: boolean }} input
   * @param {(user: object, hostId: string, level: string) => {host: object}} requireHost contrôle d'accès (404 si hôte non accordé)
   */
  async run(user, input, requireHost) {
    const file = v.remotePath(input?.path, 'fichier');
    if (!Array.isArray(input?.hostIds)) throw v.bad('hostIds doit être une liste');
    if (input.hostIds.length > MAX_HOSTS * 4) throw v.bad('Trop d\'hôtes');
    const ids = [...new Set(input.hostIds.map((x) => v.id(x, 'hôte')))];
    if (ids.length < MIN_HOSTS || ids.length > MAX_HOSTS) throw v.bad(`Choisissez de ${MIN_HOSTS} à ${MAX_HOSTS} hôtes différents`);
    const reveal = v.bool(input.reveal, false);
    // Tous les hôtes sont vérifiés AVANT toute lecture : un hôte non accordé = 404, sans rien révéler des autres.
    const targets = ids.map((id) => requireHost(user, id, 'viewer').host);

    const reads = await Promise.all(targets.map(async (host) => {
      try {
        const r = await this.sftp.readLimited(host.id, file, MAX_COMPARE_BYTES);
        return { host, ok: true, path: r.path, text: r.text, size: r.size };
      } catch (err) {
        const e = err instanceof HttpError ? err : new HttpError(502, 'READ_FAILED', 'Lecture impossible');
        return { host, ok: false, error: { status: e.status, code: e.code, message: e.message } };
      }
    }));

    const lines = (r) => splitLines(r.text);
    const ref = reads[0];
    const refLines = ref.ok ? lines(ref) : null;
    const refShown = refLines && (reveal ? refLines : maskLines(refLines));
    const hostsOut = reads.map((r) => ({
      hostId: r.host.id, name: r.host.name, ok: r.ok, path: r.path, size: r.size, crlf: r.ok ? hasCrlf(r.text) : undefined, lines: r.ok ? lines(r).length : undefined, error: r.error,
    }));
    const diffs = [];
    for (const r of reads.slice(1)) {
      if (!ref.ok || !r.ok) { diffs.push({ hostId: r.host.id, skipped: true }); continue; }
      const other = lines(r);
      try {
        const sbs = sideBySide(refLines, other, { shownA: refShown, shownB: reveal ? other : maskLines(other) });
        diffs.push({ hostId: r.host.id, ...sbs });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        diffs.push({ hostId: r.host.id, skipped: true, error: { status: err.status, code: err.code, message: err.message } });
      }
    }

    // Journal : qui a comparé quoi, sur quels hôtes (jamais le contenu).
    const names = targets.map((h) => h.name).join(', ');
    this.journal.add({ type: 'sftp', event: reveal ? 'compare-reveal' : 'compare', detail: `${file} sur ${targets.length} hôtes : ${names}` });
    return { path: file, reference: ref.host.id, hosts: hostsOut, diffs, masked: !reveal };
  }
}
