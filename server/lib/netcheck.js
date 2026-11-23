// Classification d'adresses IP : sert à refuser un bind public et à filtrer le proxy web.
import net from 'node:net';

function v4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
function inV4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** @returns {'loopback'|'tailscale'|'private'|'linklocal'|'any'|'public'} */
export function classifyAddress(addr) {
  let ip = String(addr).replace(/^\[|\]$/g, '').toLowerCase();
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    if (ip === '0.0.0.0') return 'any';
    if (inV4(ip, '127.0.0.0/8')) return 'loopback';
    if (inV4(ip, '100.64.0.0/10')) return 'tailscale';
    if (inV4(ip, '10.0.0.0/8') || inV4(ip, '172.16.0.0/12') || inV4(ip, '192.168.0.0/16')) return 'private';
    if (inV4(ip, '169.254.0.0/16')) return 'linklocal';
    return 'public';
  }
  if (net.isIPv6(ip)) {
    if (ip === '::') return 'any';
    if (ip === '::1') return 'loopback';
    if (ip.startsWith('fd7a:115c:a1e0:')) return 'tailscale';
    if (/^f[cd]/.test(ip)) return 'private';
    if (/^fe[89ab]/.test(ip)) return 'linklocal';
    return 'public';
  }
  return ip === 'localhost' ? 'loopback' : 'hostname';
}
