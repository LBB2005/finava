import { describe, it, expect, vi } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a: unknown[]) => lookupMock(...a) }));

import { isPrivateIp, expandIpv6, resolvePinnedIp, pinnedLookup } from "./ssrfGuard";

describe("isPrivateIp", () => {
  it("flags IPv4 private / loopback / link-local / CGNAT ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("allows public IPv4 (including just-outside-range boundaries)", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "172.32.0.1", "100.63.0.1"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it("flags IPv6 loopback/unspecified/ULA/link-local in every representation", () => {
    for (const ip of [
      "::1",
      "0:0:0:0:0:0:0:1", // fully-expanded loopback
      "0000:0000:0000:0000:0000:0000:0000:0001",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%eth0", // with zone id
      "::ffff:127.0.0.1", // dotted v4-mapped loopback
      "::ffff:7f00:1", // hex v4-mapped loopback — the bypass this fix closes
      "::ffff:0a00:0001", // hex v4-mapped 10.0.0.1
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  // Ranges added in the 2026-09 audit: non-public v4 blocks, plus every IPv6
  // form that embeds (and on some networks routes to) an IPv4 address.
  it("flags special-purpose IPv4 blocks", () => {
    for (const ip of [
      "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.19.255.254", "198.51.100.7",
      "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ["198.17.255.255", "198.20.0.1", "223.255.255.255", "192.0.1.1"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it("flags IPv6 forms that embed a private IPv4, and IPv6 multicast/documentation", () => {
    for (const ip of [
      "::7f00:1", // IPv4-compatible loopback (hex)
      "64:ff9b::7f00:1", // NAT64 → 127.0.0.1
      "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254 (metadata)
      "2002:7f00:0001::1", // 6to4 → 127.0.0.1
      "2002:a9fe:a9fe::", // 6to4 → 169.254.169.254
      "ff02::1", // multicast
      "2001:db8::1", // documentation
      "100::1", // discard
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ["64:ff9b::808:808", "2002:0808:0808::1"]) {
      expect(isPrivateIp(ip)).toBe(false); // embeds 8.8.8.8 — public
    }
  });

  it("allows public IPv6", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it("treats unparseable colon-addresses as unsafe (fail closed)", () => {
    expect(isPrivateIp("1:2:3::4::5")).toBe(true);
    expect(isPrivateIp("nonsense:::")).toBe(true);
  });
});

describe("expandIpv6", () => {
  it("expands compressed forms to canonical 8-group hex", () => {
    expect(expandIpv6("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(expandIpv6("fe80::1")).toBe("fe80:0000:0000:0000:0000:0000:0000:0001");
    expect(expandIpv6("2606:4700:4700::1111")).toBe("2606:4700:4700:0000:0000:0000:0000:1111");
  });

  it("returns null for non-IPv6 / malformed input", () => {
    expect(expandIpv6("127.0.0.1")).toBeNull();
    expect(expandIpv6("1:2:3::4::5")).toBeNull();
    expect(expandIpv6("::ffff:127.0.0.1")).toBeNull(); // dotted form is not pure hex
  });
});

describe("resolvePinnedIp", () => {
  it("returns null when ANY resolved address is private (rebinding defense)", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 }, // one poisoned answer → refuse the whole name
    ]);
    await expect(resolvePinnedIp("rebind.evil")).resolves.toBeNull();
  });

  it("returns the first vetted public address to pin the socket to", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "140.82.112.3", family: 4 }]);
    await expect(resolvePinnedIp("github.com")).resolves.toEqual({
      address: "140.82.112.3",
      family: 4,
    });
  });

  it("refuses on resolution failure or empty answer", async () => {
    lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(resolvePinnedIp("nope.invalid")).resolves.toBeNull();
    lookupMock.mockResolvedValueOnce([]);
    await expect(resolvePinnedIp("empty.example")).resolves.toBeNull();
  });
});

describe("pinnedLookup", () => {
  it("hands the socket the pinned IP under the single-address contract", () => {
    const cb = vi.fn();
    pinnedLookup({ address: "140.82.112.3", family: 4 })("ignored.host", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "140.82.112.3", 4);
  });

  it("returns an array under the all:true (Happy Eyeballs) contract", () => {
    const cb = vi.fn();
    pinnedLookup({ address: "2606:4700:4700::1111", family: 6 })(
      "ignored.host",
      { all: true },
      cb,
    );
    expect(cb).toHaveBeenCalledWith(null, [{ address: "2606:4700:4700::1111", family: 6 }]);
  });
});
