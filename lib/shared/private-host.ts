// Hosts that a server-side fetch or the shared browser never reaches.

/**
 * Loopback, private, link-local, and unspecified hosts, in IPv4 and IPv6
 * (including IPv4-mapped IPv6), and *.localhost names. The browser runs at
 * Browserbase, but a step never points it at a private network.
 */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  )
    return true;
  const mapped = host.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1];
    if (tail.includes('.')) return isPrivateHost(tail);
    // ::ffff:7f00:1 is 127.0.0.1 written as hex groups.
    const groups = tail.split(':').map((part) => Number.parseInt(part, 16));
    if (groups.length === 2 && groups.every((part) => Number.isFinite(part)))
      return isPrivateHost(`${groups[0] >> 8}.${groups[0] & 255}.${groups[1] >> 8}.${groups[1] & 255}`);
    return true;
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    // fc00::/7 (unique local) and fe80::/10 (link-local).
    return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const [a, b] = parts.map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
