import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetBuckets, clientKey, consumeToken, rateLimitGuard, userRateLimit } from "./rateLimit";

beforeEach(() => {
  _resetBuckets();
  vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
});

describe("rateLimit", () => {
  it("consumes burst tokens and refills over elapsed time", () => {
    expect(consumeToken("quotes:ip", { capacity: 2, refillPerSec: 1 })).toBe(true);
    expect(consumeToken("quotes:ip", { capacity: 2, refillPerSec: 1 })).toBe(true);
    expect(consumeToken("quotes:ip", { capacity: 2, refillPerSec: 1 })).toBe(false);

    vi.setSystemTime(new Date("2026-06-15T12:00:01Z"));

    expect(consumeToken("quotes:ip", { capacity: 2, refillPerSec: 1 })).toBe(true);
  });

  it("keys anonymous requests from the first forwarded IP", () => {
    const req = new Request("http://localhost/api/quotes", {
      headers: { "x-forwarded-for": " 203.0.113.5, 10.0.0.2 " },
    });

    expect(clientKey(req)).toBe("203.0.113.5");
    expect(clientKey(new Request("http://localhost/api/quotes"))).toBe("anonymous");
  });

  // An IPv6 client usually owns a whole /64, so per-address keys let one client
  // rotate through fresh buckets without end.
  it("keys an IPv6 client by its /64, in any textual form", () => {
    const key = (ip: string) =>
      clientKey(new Request("http://localhost/", { headers: { "x-forwarded-for": ip } }));
    expect(key("2001:db8:abcd:12:1::1")).toBe("2001:db8:abcd:12::/64");
    expect(key("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff")).toBe("2001:db8:abcd:12::/64");
    expect(key("2001:db8:abcd:12::99")).toBe("2001:db8:abcd:12::/64");
    expect(key("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(key("[2001:db8:abcd:12::1]")).toBe("2001:db8:abcd:12::/64");
    expect(key("198.51.100.4")).toBe("198.51.100.4");
  });

  // Regression: overflowing the map used to clear() it, resetting EVERY bucket —
  // including exhausted per-user LLM guards — for anyone who could mint ~10K keys.
  it("evicts only the least-recently-used buckets when the map is full", () => {
    const opts = { capacity: 1, refillPerSec: 0 };
    expect(consumeToken("agent:user:victim", opts)).toBe(true);
    expect(consumeToken("agent:user:victim", opts)).toBe(false); // exhausted
    for (let i = 0; i < 9_000; i++) consumeToken(`spray:${i}`, opts);
    expect(consumeToken("agent:user:victim", opts)).toBe(false); // touched → most recent
    for (let i = 9_000; i < 12_000; i++) consumeToken(`spray:${i}`, opts);
    // Still exhausted: the spray evicted old spray keys, not the recently-used victim.
    expect(consumeToken("agent:user:victim", opts)).toBe(false);
  });

  it("returns retryable 429 responses for exhausted user and request buckets", async () => {
    expect(await userRateLimit("user_123", "agent", { capacity: 1, refillPerSec: 0 })).toBeNull();
    const userBlocked = await userRateLimit("user_123", "agent", { capacity: 1, refillPerSec: 0 });

    expect(userBlocked?.status).toBe(429);
    expect(userBlocked?.headers.get("Retry-After")).toBe("10");
    await expect(userBlocked?.json()).resolves.toEqual({
      error: "Too many requests — slow down and try again shortly.",
    });

    const req = new Request("http://localhost/api/quotes", {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(await rateLimitGuard(req, "quotes", { capacity: 1, refillPerSec: 0 })).toBeNull();
    expect((await rateLimitGuard(req, "quotes", { capacity: 1, refillPerSec: 0 }))?.status).toBe(429);
  });
});
