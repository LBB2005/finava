import { describe, expect, it } from "vitest";
import { REVEAL_FRAME_MS, revealStep } from "./revealPace";

const TEXT = "NVIDIA is not too late in a binary sense — the stock is in a confirmed long-term uptrend.";

describe("revealStep", () => {
  it("reveals nothing new when it has caught up", () => {
    expect(revealStep(TEXT, TEXT.length, REVEAL_FRAME_MS)).toBe(TEXT.length);
  });

  it("always moves forward while there is a backlog", () => {
    expect(revealStep(TEXT, 0, 1)).toBeGreaterThan(0);
  });

  it("stops at the end of a word, not in the middle of one", () => {
    for (let shown = 0; shown < TEXT.length; ) {
      const next = revealStep(TEXT, shown, REVEAL_FRAME_MS);
      expect(next).toBeGreaterThan(shown);
      if (next < TEXT.length) expect(TEXT[next]).toMatch(/\s/);
      shown = next;
    }
  });

  it("shows a trailing half-word when the stream has not sent the rest yet", () => {
    // The buffer ends mid-word: holding it back could hide it for the whole
    // pause before the next chunk.
    const buffered = "The stock is in a confirmed long-te";
    expect(revealStep(buffered, buffered.length - 4, REVEAL_FRAME_MS)).toBe(buffered.length);
  });

  it("does not wait forever on a very long token (a URL)", () => {
    const url = "see https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=10-K";
    const next = revealStep(url + " more text follows here", 4, REVEAL_FRAME_MS);
    expect(next).toBeGreaterThan(4);
    expect(next).toBeLessThan(url.length);
  });

  it("catches up faster the further behind it is", () => {
    const long = "word ".repeat(2000);
    const small = revealStep(long, long.length - 100, REVEAL_FRAME_MS) - (long.length - 100);
    const big = revealStep(long, 0, REVEAL_FRAME_MS);
    expect(big).toBeGreaterThan(small * 10);
  });

  it("paces about the old base speed (~110 chars/s) on a short backlog", () => {
    const long = "abcd ".repeat(40); // 200 chars
    let shown = long.length - 60;
    const start = shown;
    // One second of 30 fps updates.
    for (let i = 0; i < 30; i++) shown = revealStep(long, shown, REVEAL_FRAME_MS);
    expect(shown - start).toBeGreaterThan(50);
  });

  it("rewinds when a new stream replaced the text with something shorter", () => {
    expect(revealStep("New answer", 500, REVEAL_FRAME_MS)).toBeLessThanOrEqual("New answer".length);
    expect(revealStep("New answer", 500, REVEAL_FRAME_MS)).toBeGreaterThan(0);
  });

  it("updates at most ~30 times a second", () => {
    expect(REVEAL_FRAME_MS).toBeGreaterThanOrEqual(30);
  });
});
