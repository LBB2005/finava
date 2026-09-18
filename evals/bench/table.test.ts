import { describe, expect, it } from "vitest";
import type { BenchReport } from "@/app/dev/chat-replay/recorder";
import { baselineRow, markdownTable, parseArgs } from "./table";

function report(over: Partial<BenchReport> = {}): BenchReport {
  const frames = { frames: 100, p50Ms: 16.7, p95Ms: 33.4, maxMs: 90, dropped: 12, budgetMs: 16.67 };
  return {
    fixture: "recorded-agent-verdict-then-escalate-3",
    reader: "trackpad",
    speed: 1,
    viewport: { width: 1440, height: 900, dpr: 1 },
    visibility: "visible",
    ranAt: "2026-09-18T00:00:00.000Z",
    firstTextMs: 61_000,
    endMs: 109_000,
    answerChars: 8_399,
    answerMatches: true,
    longTasks: { count: 3, maxMs: 180, tbtMs: 412 },
    longAnimationFrames: { count: 0, top: [] },
    framesStream: frames,
    framesReader: frames,
    scroll: { follows: 40, yanks: 14, yankPx: 70, others: 1, otherPx: 180, largestOther: { t: 5, delta: -180 }, maxAwayPx: 5, pulledBack: true, leftBehindPx: 0 },
    layout: {
      count: 4,
      total: 0.05,
      cls: 0.042,
      largest: { t: 61_000, value: 0.031, sources: [{ label: 'div.flex.gap-[14px] "L Answer"', dy: -210 }] },
    },
    topShifts: [],
    ...over,
  };
}

describe("baselineRow", () => {
  it("fills the README's Baseline columns from one report", () => {
    expect(baselineRow("crew", report())).toEqual([
      "crew",
      "1440",
      "3 (max 180 ms)",
      "412 ms",
      "33.4 ms (12 dropped)",
      "14 yanks (70 px); reader held ≤ 5 px from the bottom",
      '0.042 (largest 0.031: div.flex.gap-[14px] "L Answer", moved −210 px)',
    ]);
  });

  it("says plainly when the reader got away and nothing moved", () => {
    const row = baselineRow("fast lane", report({
      longTasks: { count: 0, maxMs: 0, tbtMs: 0 },
      scroll: { follows: 3, yanks: 0, yankPx: 0, others: 0, otherPx: 0, largestOther: null, maxAwayPx: 300, pulledBack: false, leftBehindPx: 0 },
      layout: { count: 0, total: 0, cls: 0, largest: null },
    }));
    expect(row[2]).toBe("0");
    expect(row[5]).toBe("0; reader stayed 300 px up");
    expect(row[6]).toBe("0");
  });

  it("says when the page stopped following the stream for a reader who sat still", () => {
    const row = baselineRow("crew", report({
      scroll: { follows: 1, yanks: 0, yankPx: 0, others: 0, otherPx: 0, largestOther: null, maxAwayPx: 2_164, pulledBack: false, leftBehindPx: 1_864 },
    }));
    expect(row[5]).toBe("0; reader stayed 2164 px up; stream ran 1864 px past a still reader");
  });

  it("doesn't name a largest shift too small to see", () => {
    const row = baselineRow("fast lane", report({
      layout: { count: 1, total: 0.00005, cls: 0.00005, largest: { t: 1, value: 0.00005, sources: [{ label: "span", dy: 0 }] } },
    }));
    expect(row[6]).toBe("0.000");
  });

  it("says when there was nothing to scroll", () => {
    const row = baselineRow("fast lane", report({
      scroll: { follows: 0, yanks: 0, yankPx: 0, others: 0, otherPx: 0, largestOther: null, maxAwayPx: 0, pulledBack: false, leftBehindPx: 0 },
    }));
    expect(row[5]).toBe("n/a (answer fits on screen)");
  });

  it("flags a run whose answer didn't match the fixture", () => {
    expect(baselineRow("crew", report({ answerMatches: false }))[0]).toBe("crew ⚠ answer mismatch");
  });

  it("flags a run in a hidden tab, whose frame numbers are meaningless", () => {
    expect(baselineRow("crew", report({ visibility: "hidden" }))[0]).toBe("crew ⚠ hidden tab");
  });
});

describe("markdownTable", () => {
  it("renders a header, a rule and the rows", () => {
    expect(markdownTable(["A", "B"], [["1", "2"]])).toBe("| A | B |\n|---|---|\n| 1 | 2 |");
  });
});

describe("parseArgs", () => {
  it("reads the bench flags with defaults", () => {
    expect(parseArgs([])).toEqual({ base: "http://localhost:3011", fixtures: [], widths: [1440, 375], cpu: [1], reader: "trackpad", speed: 1, out: null });
    expect(parseArgs(["--fixture", "a,b", "--width", "375", "--cpu", "1,4", "--reader", "wheel", "--speed", "4", "--out", "x.json", "--base", "http://h"])).toEqual({
      base: "http://h",
      fixtures: ["a", "b"],
      widths: [375],
      cpu: [1, 4],
      reader: "wheel",
      speed: 4,
      out: "x.json",
    });
  });
});
