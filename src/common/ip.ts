import * as ipaddr from 'ipaddr.js';

/**
 * Normalise an address: IPv4-mapped IPv6 (::ffff:1.2.3.4) is unwrapped to IPv4, IPv6 is canonicalised.
 * Returns 'unknown' for anything that does not parse.
 */
export function normalizeIp(raw: string | undefined | null): string {
  if (!raw) return 'unknown';
  try {
    let addr = ipaddr.parse(raw.trim().replace(/^\[|\]$/g, '').split('%')[0]);
    if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
    return addr.toNormalizedString();
  } catch {
    return 'unknown';
  }
}

/** Coarse prefix for shared-IP-aware correlation: /24 for IPv4, /48 for IPv6. */
export function ipPrefix(ip: string): string {
  try {
    const addr = ipaddr.parse(ip);
    if (addr.kind() === 'ipv4') {
      const o = (addr as ipaddr.IPv4).octets;
      return `${o[0]}.${o[1]}.${o[2]}.0/24`;
    }
    const parts = (addr as ipaddr.IPv6).parts;
    return `${parts[0].toString(16)}:${parts[1].toString(16)}:${parts[2].toString(16)}::/48`;
  } catch {
    return 'unknown';
  }
}

export function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const addr = ipaddr.parse(ip);
    const [range, bits] = ipaddr.parseCIDR(cidr);
    return addr.kind() === range.kind() && (addr as any).match(range, bits);
  } catch {
    return false;
  }
}

export function isPrivateIp(ip: string): boolean {
  try {
    const range = ipaddr.parse(ip).range();
    return ['private', 'loopback', 'linkLocal', 'uniqueLocal', 'carrierGradeNat'].includes(range);
  } catch {
    return false;
  }
}

/**
 * The client address as seen by Express. Express runs with `trust proxy = TRUST_PROXY_HOPS`, so `req.ip` only honours
 * X-Forwarded-For entries added by that many trusted proxies; client-supplied values are ignored.
 */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return normalizeIp(req.ip || req.socket?.remoteAddress);
}
