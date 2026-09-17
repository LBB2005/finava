import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The harness copies ChatEngine's control flow, so it has to copy this too: an
 * ETF question that Auto sends to Discover is re-routed to the fast lane (W4-1),
 * because the scout only knows individual stocks. Without it the eval reports a
 * routing miss for every fund question and measures the wrong lane.
 */
describe("auto routing parity with ChatEngine", () => {
  const harness = readFileSync(new URL("../lib/conversation.ts", import.meta.url), "utf8");
  const engine = readFileSync(new URL("../../src/components/chat/ChatEngine.tsx", import.meta.url), "utf8");

  it("re-routes a fund question away from Discover, as ChatEngine does", () => {
    const rule = /intent === "discover" && isFundQuestion\(/;
    expect(engine).toMatch(rule);
    expect(harness).toMatch(rule);
  });
});
