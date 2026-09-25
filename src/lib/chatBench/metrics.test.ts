import { describe, expect, it } from "vitest";
import {
  classifyScroll,
  frameSummary,
  labelElement,
  layoutShiftSummary,
  longTaskSummary,
  percentile,
  shiftsByPhase,
  topScripts,
  transitionAt,
  type FrameSample,
  type Shift,
} from "./metrics";

describe("percentile", () => {
  it("is nearest-rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 95)).toBeNull();
  });
});

describe("longTaskSummary", () => {
  it("counts tasks over 50 ms in the window and sums blocking time past 50 ms", () => {
    const s = longTaskSummary(
      [
        { start: 100, duration: 60 },
        { start: 200, duration: 180 },
        { start: 900, duration: 400 }, // after the window
        { start: 50, duration: 90 }, // before the window
      ],
      { start: 100, end: 800 }
    );
    expect(s).toEqual({ count: 2, maxMs: 180, tbtMs: 10 + 130 });
  });

  it("is zero, not null, when nothing blocked", () => {
    expect(longTaskSummary([], { start: 0, end: 10 })).toEqual({ count: 0, maxMs: 0, tbtMs: 0 });
  });
});

describe("frameSummary", () => {
  it("reports frame-time percentiles and counts frames missed at 60 Hz", () => {
    // 16.7 ms frames, then one 50 ms frame (two missed) and one 33 ms frame (one missed).
    const t = [0, 16.7, 33.4, 50.1, 100.1, 133.4, 150.1];
    const s = frameSummary(t);
    expect(s.frames).toBe(6);
    expect(s.budgetMs).toBeCloseTo(16.7, 1);
    expect(s.p95Ms).toBeCloseTo(50, 0);
    expect(s.maxMs).toBeCloseTo(50, 0);
    expect(s.dropped).toBe(3);
  });

  it("uses the 120 Hz budget on a 120 Hz display", () => {
    const t = Array.from({ length: 30 }, (_, i) => i * 8.33);
    const s = frameSummary(t);
    expect(s.budgetMs).toBeCloseTo(8.33, 1);
    expect(s.dropped).toBe(0);
  });

  it("is empty with fewer than two frames", () => {
    expect(frameSummary([5]).frames).toBe(0);
    expect(frameSummary([5]).p95Ms).toBeNull();
  });
});

describe("layoutShiftSummary", () => {
  it("CLS is the worst session window (gap ≤ 1 s, window ≤ 5 s); largest names the element", () => {
    const s = layoutShiftSummary([
      { t: 0, value: 0.05, hadRecentInput: false, sources: [{ label: "div.a", dy: 20 }] },
      { t: 500, value: 0.1, hadRecentInput: false, sources: [{ label: "div.crew", dy: -180 }] },
      // new window (gap > 1 s)
      { t: 3_000, value: 0.12, hadRecentInput: false, sources: [{ label: "div.b", dy: 40 }] },
      // excluded: right after input
      { t: 3_100, value: 0.9, hadRecentInput: true, sources: [] },
    ]);
    expect(s.count).toBe(3);
    expect(s.total).toBeCloseTo(0.27);
    expect(s.cls).toBeCloseTo(0.15);
    expect(s.largest).toEqual({ t: 3_000, value: 0.12, sources: [{ label: "div.b", dy: 40 }] });
  });

  it("closes a session window after 5 s even with no gap", () => {
    const shifts = Array.from({ length: 12 }, (_, i) => ({ t: i * 900, value: 0.01, hadRecentInput: false, sources: [] }));
    // 0..4500 fits in the first 5 s window (6 shifts), the next window holds the other 6.
    expect(layoutShiftSummary(shifts).cls).toBeCloseTo(0.06);
  });

  it("has no largest shift when nothing moved", () => {
    expect(layoutShiftSummary([])).toEqual({ count: 0, total: 0, cls: 0, largest: null });
  });
});

describe("classifyScroll", () => {
  const f = (t: number, before: number, after: number, phase: FrameSample["phase"], maxTop = 1_000): FrameSample => ({
    t,
    before,
    after,
    maxTop,
    phase,
  });

  it("an app scroll to the new bottom while the reader sits at the bottom is following, not a jump", () => {
    const s = classifyScroll([f(0, 1_000, 1_000, "idle"), f(16, 1_040, 1_040, "idle", 1_040), f(33, 1_080, 1_080, "idle", 1_080)]);
    expect(s).toMatchObject({ follows: 2, yanks: 0, others: 0, pulledBack: false });
  });

  it("a move toward the bottom while the reader is scrolling up or reading above is a yank", () => {
    const s = classifyScroll([
      f(0, 1_000, 1_000, "idle"),
      f(16, 1_000, 995, "up"), // reader scrolls up 5 px
      f(33, 1_000, 995, "up"), // app pinned back to the bottom, reader scrolls up again
      f(50, 1_000, 1_000, "hold"), // pinned again
      f(66, 1_000, 1_000, "idle"),
    ]);
    expect(s.yanks).toBe(2);
    expect(s.yankPx).toBe(10);
    expect(s.pulledBack).toBe(true);
    expect(s.maxAwayPx).toBe(5);
  });

  it("a reader who gets away and stays away is not pulled back", () => {
    const s = classifyScroll([
      f(0, 1_000, 1_000, "idle"),
      f(16, 1_000, 850, "up"),
      f(33, 850, 700, "up"),
      f(50, 700, 700, "hold", 1_100), // content grew below; the reader stays put
      f(66, 700, 700, "hold", 1_200),
    ]);
    expect(s).toMatchObject({ yanks: 0, others: 0, pulledBack: false, maxAwayPx: 500 });
  });

  it("measures how far the page left an idle reader behind the stream (follow lost)", () => {
    const s = classifyScroll([
      { ...f(0, 1_000, 1_000, "idle"), streaming: true },
      { ...f(16, 1_000, 1_000, "idle", 1_060), streaming: true }, // grew 60 px, not followed yet
      { ...f(33, 1_060, 1_060, "idle", 1_400), streaming: true }, // followed once, then a 340 px block landed
      { ...f(50, 1_060, 1_060, "idle", 2_000), streaming: true }, // and it never followed again
      { ...f(66, 1_060, 1_060, "idle", 5_000), streaming: false }, // after the stream: not counted
    ]);
    expect(s.leftBehindPx).toBe(940);
  });

  it("a reader catching up to the bottom is following: neither away nor left behind", () => {
    const s = classifyScroll([
      { ...f(0, 200, 1_000, "catchup"), streaming: true }, // reader jumps to the bottom
      { ...f(16, 1_040, 1_040, "catchup", 1_040), streaming: true }, // page follows the new text
    ]);
    expect(s).toMatchObject({ follows: 1, yanks: 0, maxAwayPx: 0, leftBehindPx: 0 });
  });

  it("any other move the reader didn't make (anchoring, clamping) is counted with its size", () => {
    const s = classifyScroll([f(0, 700, 700, "hold"), f(16, 520, 520, "hold", 900)]);
    expect(s.others).toBe(1);
    expect(s.otherPx).toBe(180);
    expect(s.largestOther).toEqual({ t: 16, delta: -180 });
  });
});

describe("shiftsByPhase", () => {
  const shift = (t: number, value: number): Shift => ({ t, value, hadRecentInput: false, sources: [{ label: `at ${t}`, dy: 10 }] });

  it("splits layout shifts into waiting, first text, streaming and the end-of-stream swap", () => {
    const p = shiftsByPhase([shift(100, 0.01), shift(5_100, 0.2), shift(6_000, 0.001), shift(9_200, 0.05)], {
      firstTextMs: 5_000,
      endMs: 9_000,
    });
    expect(p.waiting).toMatchObject({ count: 1, total: 0.01 });
    expect(p.firstText).toMatchObject({ count: 1, total: 0.2, largest: { t: 5_100, value: 0.2 } });
    expect(p.streaming).toMatchObject({ count: 1, total: 0.001 });
    expect(p.end).toMatchObject({ count: 1, total: 0.05 });
  });

  it("puts everything in waiting when no text ever came", () => {
    const p = shiftsByPhase([shift(100, 0.01)], { firstTextMs: null, endMs: null });
    expect(p.waiting.count).toBe(1);
    expect(p.firstText.count).toBe(0);
  });
});

describe("transitionAt", () => {
  const f = (t: number, before: number, maxTop: number): FrameSample => ({ t, before, after: before, maxTop, phase: "idle" });

  it("reports how the list's height and scroll position changed across a moment, once it settled", () => {
    const frames = [f(0, 900, 900), f(16, 900, 900), f(33, 640, 640), f(300, 660, 660), f(316, 680, 680)];
    // At 20 ms the 300 px crew panel went away and 40 px of text arrived.
    expect(transitionAt(frames, 20, 250)).toEqual({ dHeight: -240, dScrollTop: -240 });
  });

  it("is null without frames on both sides", () => {
    expect(transitionAt([f(0, 0, 0)], 20)).toBeNull();
  });
});

describe("labelElement", () => {
  it("names an element by tag, first classes and the start of its text", () => {
    expect(
      labelElement({ tag: "DIV", className: "flex gap-[14px] items-start extra more", text: "  NVDA still screens as a high-quality business  " })
    ).toBe('div.flex.gap-[14px].items-start "NVDA still screens as a high-quality bus…"');
  });

  it("handles elements with no class or text", () => {
    expect(labelElement({ tag: "SPAN", className: "", text: "" })).toBe("span");
  });
});

describe("topScripts", () => {
  it("totals long-animation-frame script time by what invoked it, largest first", () => {
    const top = topScripts([
      { scripts: [{ invoker: "FrameRequestCallback", sourceURL: "a.js", duration: 40 }] },
      { scripts: [{ invoker: "FrameRequestCallback", sourceURL: "a.js", duration: 30 }, { invoker: "MessagePort.onmessage", sourceURL: "react.js", duration: 90 }] },
    ]);
    expect(top).toEqual([
      { invoker: "MessagePort.onmessage", sourceURL: "react.js", ms: 90, count: 1 },
      { invoker: "FrameRequestCallback", sourceURL: "a.js", ms: 70, count: 2 },
    ]);
  });
});
