// SSRF guard helpers for server-side URL fetching (e.g. the og-image proxy).
//
// Threat model: a user-supplied URL whose hostname an attacker controls via DNS.
// Validating the resolved IP is NOT enough on its own — Node re-resolves the
// hostname when it opens the socket, so a low-TTL DNS-rebinding answer can pass a
// pre-flight check and then connect to an internal/metadata address (a TOCTOU
// window). `resolvePinnedIp` validates AND returns the vetted IP; `pinnedLookup`
// forces the outbound socket onto exactly that IP so no second resolution happens.
import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";

export type PinnedIp = { address: string; family: number };

// Expand any IPv6 textual form to canonical 8×4-hex groups (e.g. "::1" →
// "0000:…:0001"), or null if it isn't a parseable IPv6 literal. Lets isPrivateIp
// screen every representation of an address, not just the canonical one — an
// attacker-controlled DNS answer could otherwise smuggle loopback past the check
// as a hex-mapped or fully-expanded form.
export function expandIpv6(addr: string): string | null {
  if (!addr.includes(":") || addr.includes(".")) return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null; // at most one "::"
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

// True when `ip` falls in a private, loopback, link-local, CGNAT, or otherwise
// non-public range. Covers IPv4, IPv6, and IPv4-mapped IPv6 in dotted
// (::ffff:127.0.0.1) AND hex (::ffff:7f00:1) / fully-expanded forms.
export function isPrivateIp(ip: string): boolean {
  let addr = ip.toLowerCase().trim();
  const zone = addr.indexOf("%"); // strip IPv6 zone id (fe80::1%eth0)
  if (zone !== -1) addr = addr.slice(0, zone);

  // IPv4-mapped/embedded IPv6 in dotted form — unwrap and test the embedded v4.
  const dotted = addr.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isPrivateIp(dotted[1]);

  if (addr.includes(":")) {
    const full = expandIpv6(addr);
    if (!full) return true; // unparseable IPv6 → treat as unsafe
    if (full === "0000:0000:0000:0000:0000:0000:0000:0001") return true; // ::1 loopback
    if (full === "0000:0000:0000:0000:0000:0000:0000:0000") return true; // :: unspecified
    if (/^f[cd]/.test(full)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(full)) return true; // fe80::/10 link-local
    if (full.startsWith("ff")) return true; // ff00::/8 multicast
    if (full.startsWith("2001:0db8:")) return true; // 2001:db8::/32 documentation
    if (full.startsWith("0100:0000:0000:0000:")) return true; // 100::/64 discard
    const v4 = (hiHex: string, loHex: string) => {
      const hi = parseInt(hiHex, 16);
      const lo = parseInt(loHex, 16);
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    };
    // IPv4 embedded in the low 32 bits: ffff-mapped (::ffff:a.b.c.d), the
    // deprecated IPv4-compatible form (::a.b.c.d, e.g. ::7f00:1), and NAT64
    // (64:ff9b::/96), which on a NAT64 network routes to that v4 address.
    const low32 = full.match(
      /^(?:0000:0000:0000:0000:0000:(?:ffff|0000)|0064:ff9b:0000:0000:0000:0000):([0-9a-f]{4}):([0-9a-f]{4})$/
    );
    if (low32) return isPrivateIp(v4(low32[1], low32[2]));
    // 6to4 (2002::/16) carries the v4 address in bits 16–47.
    const sixToFour = full.match(/^2002:([0-9a-f]{4}):([0-9a-f]{4}):/);
    if (sixToFour) return isPrivateIp(v4(sixToFour[1], sixToFour[2]));
    return false;
  }

  const parts = addr.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable → treat as unsafe
  }
  const [a, b, c] = parts;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local / cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 documentation
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 documentation
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 documentation
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved (incl. broadcast)
  );
}

// Resolve the hostname, confirm EVERY address it maps to is public, and return
// ONE vetted address. Returning the address (not just a boolean) lets the caller
// PIN the socket to the IP we validated — closing the TOCTOU/DNS-rebinding window
// where a name that resolved to a public IP during this check silently
// re-resolves to an internal/metadata IP at connect time.
export async function resolvePinnedIp(hostname: string): Promise<PinnedIp | null> {
  try {
    const results = await lookup(hostname, { all: true });
    if (results.length === 0) return null;
    if (!results.every((r) => !isPrivateIp(r.address))) return null;
    return { address: results[0].address, family: results[0].family };
  } catch {
    return null; // unresolvable → refuse
  }
}

// Force the outbound socket to connect to the pre-validated IP instead of letting
// Node re-resolve the hostname (a fresh DNS lookup at connect time is exactly the
// rebinding gap we're closing). Host header + TLS SNI still derive from the URL's
// hostname, so virtual hosting and certificate validation are unaffected. Handles
// both the single-address and all:true (Happy Eyeballs) callback shapes.
export function pinnedLookup(pin: PinnedIp) {
  const family = pin.family === 6 ? 6 : 4;
  return (
    _hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    if (options?.all) callback(null, [{ address: pin.address, family }]);
    else callback(null, pin.address, family);
  };
}
