import { afterEach, describe, expect, it, vi } from "vitest";
import { createResponseMemo } from "./responseMemo";

afterEach(() => vi.useRealTimers());

describe("createResponseMemo", () => {
  it("returns a stored value until its TTL passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const memo = createResponseMemo<number>({ ttlMs: 1000, maxEntries: 10 });
    memo.set("A", 1);
    expect(memo.get("A")).toBe(1);
    vi.setSystemTime(1001);
    expect(memo.get("A")).toBeUndefined();
  });

  it("evicts the least-recently-used entry at capacity", () => {
    const memo = createResponseMemo<number>({ ttlMs: 60_000, maxEntries: 2 });
    memo.set("A", 1);
    memo.set("B", 2);
    memo.get("A"); // A is now most recent
    memo.set("C", 3);
    expect(memo.get("B")).toBeUndefined();
    expect(memo.get("A")).toBe(1);
    expect(memo.get("C")).toBe(3);
    expect(memo.size).toBe(2);
  });
});
