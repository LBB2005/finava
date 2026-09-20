import { describe, expect, it } from "vitest";
import { isSafeDocId } from "./docId";

describe("isSafeDocId", () => {
  it.each(["9b2f6c1e-3d4a-4f5b-8c7d-0e1f2a3b4c5d", "Xk3P9sQ2vL8mN4bR6tY1", "BRK.B", "BF-B", "a_b:c"])(
    "accepts ids this app mints: %s",
    (id) => expect(isSafeDocId(id)).toBe(true)
  );

  it.each(["", ".", "..", "a/b", "../user", "user_1/holdings/x", "a b", "a%2Fb", "x".repeat(151), 5, null])(
    "rejects path-altering or malformed ids: %s",
    (id) => expect(isSafeDocId(id)).toBe(false)
  );
});
