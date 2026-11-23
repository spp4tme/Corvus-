// Import optionnel des machines du tailnet via `tailscale status --json` (si le CLI est présent).
import { execFile } from 'node:child_process';
import { HttpError } from './validate.js';

export function tailscalePeers(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['status', '--json'], { timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return reject(new HttpError(404, 'TAILSCALE_MISSING', 'CLI tailscale introuvable sur le serveur Corvus'));
        }
        return reject(new HttpError(502, 'TAILSCALE_ERROR', `tailscale status a échoué : ${err.message.split('\n')[0]}`));
      }
      let data;
      try { data = JSON.parse(stdout); } catch {
        return reject(new HttpError(502, 'TAILSCALE_ERROR', 'Sortie de tailscale status illisible'));
      }
      const toPeer = (p, self = false) => ({
        hostName: String(p.HostName || ''),
        dnsName: String(p.DNSName || '').replace(/\.$/, ''),
        ips: Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs.map(String) : [],
        os: String(p.OS || ''),
        online: !!p.Online || self,
        self,
      });
      const peers = [];
      if (data.Self) peers.push(toPeer(data.Self, true));
      for (const p of Object.values(data.Peer || {})) peers.push(toPeer(p));
      resolve({
        tailnet: data.CurrentTailnet?.Name || data.MagicDNSSuffix || null,
        magicDNS: !!data.CurrentTailnet?.MagicDNSEnabled,
        peers: peers.filter((p) => p.hostName),
      });
    });
  });
}
