// src/lib/facts/cache.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase-admin", () => ({ db: { collection: vi.fn() } }));

import { memo, isFresh, clearFactsMemo } from "./cache";

// Tue 15 Sep 2026: 14:00 ET is open; 20:00 ET is closed.
const OPEN = new Date("2026-09-15T18:00:00.000Z");
const CLOSED = new Date("2026-09-16T00:00:00.000Z");

beforeEach(() => clearFactsMemo());
afterEach(() => vi.useRealTimers());

describe("isFresh", () => {
  it("quote: fresh for 60 s while open", () => {
    const e = { at: OPEN.getTime(), openAtFetch: true, closeDate: "2026-09-14" };
    expect(isFresh(e, "quote", new Date(OPEN.getTime() + 59_000))).toBe(true);
    expect(isFresh(e, "quote", new Date(OPEN.getTime() + 61_000))).toBe(false);
  });

  it("quote: a closed-market read stays fresh until the next session closes", () => {
    const e = { at: CLOSED.getTime(), openAtFetch: false, closeDate: "2026-09-15" };
    expect(isFresh(e, "quote", new Date(CLOSED.getTime() + 8 * 3600_000))).toBe(true); // 04:00 ET next day
    expect(isFresh(e, "quote", new Date("2026-09-16T14:00:00.000Z"))).toBe(false); // 10:00 ET, open again
  });

  it("day: fresh for 24 h", () => {
    const e = { at: OPEN.getTime(), openAtFetch: true, closeDate: "2026-09-14" };
    expect(isFresh(e, "day", new Date(OPEN.getTime() + 86_399_000))).toBe(true);
    expect(isFresh(e, "day", new Date(OPEN.getTime() + 86_401_000))).toBe(false);
  });

  it("maxAgeSec can only make a read stricter", () => {
    const e = { at: OPEN.getTime(), openAtFetch: true, closeDate: "2026-09-14" };
    expect(isFresh(e, "day", new Date(OPEN.getTime() + 10_000), 5)).toBe(false);
  });
});

describe("memo", () => {
  it("loads once and serves the cached value with its fetch time", async () => {
    const load = vi.fn().mockResolvedValue({ price: 1 });
    const a = await memo("quote:AAPL", "quote", load, { now: () => OPEN });
    const b = await memo("quote:AAPL", "quote", load, { now: () => OPEN });
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ value: { price: 1 }, at: OPEN.getTime() });
    expect(b).toEqual(a);
  });

  it("collapses concurrent cold calls onto one load", async () => {
    let resolve!: (v: number) => void;
    const load = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const p1 = memo("k", "day", load, { now: () => OPEN });
    const p2 = memo("k", "day", load, { now: () => OPEN });
    resolve(7);
    expect((await p1).value).toBe(7);
    expect((await p2).value).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce(3);
    await expect(memo("k2", "day", load, { now: () => OPEN })).rejects.toThrow("429");
    expect((await memo("k2", "day", load, { now: () => OPEN })).value).toBe(3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never caches null", async () => {
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(4);
    expect((await memo("k3", "day", load, { now: () => OPEN })).value).toBeNull();
    expect((await memo("k3", "day", load, { now: () => OPEN })).value).toBe(4);
  });
});
