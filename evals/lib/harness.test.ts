/**
 * Unit tests for the harness's own logic: the numbers a readout prints must be
 * right before anyone spends money producing them.
 */
import { describe, expect, it } from "vitest";
import baseline from "../baseline/2026-09-14.json";
import personas from "../panel/personas.json";
import { lastJsonObject, sampleClaims } from "../report/analyze";
import { manualGate } from "../report/build";
import { compare, launchGate, summarizePanel, type Baseline, type PanelRow } from "../report/compare";
import { summarizeLive } from "../report/live";
import { SCENARIOS, TURN_COUNT } from "../live/scenarios";
import { appUsd, panelEstimate, tokenUsd } from "./cost";
import { answerFromWire, collapseCheck, contractShape, mismatchRate, nps, numberCheckFrom, percentile } from "./metrics";
import { chunkBytes } from "./replay";

describe("metrics", () => {
  it("percentile is nearest-rank and ignores non-finite values", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([NaN, 7], 50)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it("NPS: promoters 9–10 minus detractors 0–6", () => {
    expect(nps([10, 9, 8, 7, 6, 0])).toBe(0);
    expect(nps([6, 6, 4])).toBe(-100);
    expect(nps([])).toBeNull();
  });

  it("the Sep-14 baseline reproduces NPS −100 from its own ratings", () => {
    expect(nps(baseline.perPersona.map((p) => p.nps))).toBe(baseline.nps);
    expect(baseline.perPersona).toHaveLength(50);
  });

  it("answerFromWire honours replace and appends everything else", () => {
    expect(
      answerFromWire([
        { type: "final_response", content: "draft" },
        { type: "agent_start" },
        { type: "final_response", content: "full", replace: true },
        { type: "final_response", content: " + note" },
        { text: "ignored? no: chat text" },
      ])
    ).toBe("full + noteignored? no: chat text");
  });

  it("collapseCheck names the first stage that lost text", () => {
    expect(collapseCheck({ streamed: "abc", rendered: "abc", saved: "abc", reloaded: "abc" }).collapsed).toBe(false);
    expect(collapseCheck({ streamed: "abc", rendered: "abc", saved: "c" }).where).toBe("saved");
    expect(collapseCheck({ streamed: "abc", rendered: "c", saved: "c" }).where).toBe("rendered");
    expect(collapseCheck({ streamed: "abc", rendered: "abc", saved: "abc", reloaded: "" }).where).toBe("reloaded");
  });

  it("contractShape distinguishes full, answer-only, partial and none", () => {
    expect(contractShape("## Answer\nYes.").kind).toBe("answer_only");
    expect(contractShape("plain").kind).toBe("none");
  });

  it("number checks are Unavailable (null) until something reports them", () => {
    expect(numberCheckFrom([{ type: "done" }])).toBeNull();
    const a = numberCheckFrom([{ type: "number_check", checked: 10, mismatched: 1 }, { type: "number_check", checked: 5, mismatched: 0 }]);
    expect(a).toEqual({ checked: 15, mismatched: 1 });
    expect(mismatchRate([a, null])).toBeCloseTo(1 / 15);
    expect(mismatchRate([null])).toBeNull();
  });
});

describe("replay", () => {
  it("chunking keeps every byte in order", () => {
    const bytes = new TextEncoder().encode("data: {\"a\":\"—×≈\"}\n\n".repeat(20));
    for (const seed of [0, 1, 99]) {
      const joined = Buffer.concat(chunkBytes(bytes, seed).map((c) => Buffer.from(c)));
      expect(joined.equals(Buffer.from(bytes))).toBe(true);
    }
    expect(chunkBytes(bytes, 3).length).toBeGreaterThan(5);
  });
});

describe("cost estimates", () => {
  it("prices tokens at list rates", () => {
    expect(tokenUsd("claude-opus-5", 1_000_000, 0)).toBe(5);
    expect(tokenUsd("claude-sonnet-5", 0, 1_000_000)).toBe(10);
    expect(() => tokenUsd("gpt-x", 1, 1)).toThrow();
  });

  it("app spend uses the W3-4 p90 per lane", () => {
    const e = appUsd({ fast: 10, full_analysis: 2, deep_research: 0, discover: 0, clarify: 1 }, 0);
    expect(e.totalUsd).toBeCloseTo(10 * 0.0064 + 2 * 0.2231);
  });

  it("panel estimate lists every line and sums them", () => {
    const e = panelEstimate({
      apiPersonas: 40,
      browserPersonas: 10,
      turnsPerPersona: 3,
      mix: { fast: 105, full_analysis: 23, discover: 12, clarify: 10, deep_research: 0 },
      personaModel: "claude-opus-5",
      judgeModel: "claude-opus-5",
      factChecks: 25,
    });
    expect(e.totalUsd).toBeCloseTo(e.lines.reduce((a, l) => a + l.usd, 0));
    expect(e.lines.some((l) => l.label.startsWith("fact-check"))).toBe(true);
  });
});

describe("persona grid and scenarios", () => {
  it("is the 5×5×2 grid with 40 API and 10 browser personas, 3 at phone width", () => {
    const ps = personas.personas;
    expect(ps).toHaveLength(50);
    for (const a of ["A1", "A2", "A3", "A4", "A5"])
      for (const s of ["S1", "S2", "S3", "S4", "S5"]) expect(ps.filter((p) => p.ai === a && p.stock === s)).toHaveLength(2);
    expect(ps.filter((p) => p.channel === "browser")).toHaveLength(10);
    expect(ps.filter((p) => p.mobile && p.channel === "browser")).toHaveLength(3);
    expect(ps.every((p) => p.opening.trim().length > 0)).toBe(true);
  });

  it("the live set is about 20 prompts and covers every lane", () => {
    expect(TURN_COUNT).toBe(20);
    const lanes = new Set(SCENARIOS.flatMap((s) => s.turns.map((t) => t.expect)));
    expect([...lanes].sort()).toEqual(["clarify", "deep_research", "discover", "fast", "full_analysis"]);
  });
});

const rating = (o: Partial<{ nps: number; pay: "yes" | "maybe" | "no"; ret: number; quit: boolean }> = {}) => ({
  scores: { easeOfUse: 5, answerUsefulness: 5, answerClarityForMe: 5, trustInNumbers: 5, speed: 5, modeUnderstanding: 5, wouldReturn: o.ret ?? 5 },
  nps: o.nps ?? 5,
  pay: o.pay ?? "no",
  price: 0,
  quit: o.quit ?? false,
});
const turn = (lane: "fast" | "full_analysis", totalMs: number, collapsed = false) => ({
  lane,
  totalMs,
  collapse: { streamedChars: 1, renderedChars: 1, savedChars: 1, reloadedChars: null, collapsed, where: collapsed ? ("saved" as const) : null },
});
const prow = (id: number, r: ReturnType<typeof rating> | null, turns = [turn("fast", 6000)]): PanelRow => ({
  persona: { id, ai: "A1", stock: "S1", channel: "api", mobile: false },
  shown: turns.map((t) => ({ lane: t.lane, waitSec: t.totalMs / 1000, stopped: false })),
  metrics: turns,
  rating: r,
  quitMidSession: false,
  error: r ? null : "boom",
});

describe("readout", () => {
  const rows = [
    prow(1, rating({ nps: 9, pay: "yes", ret: 7 }), [turn("fast", 4000), turn("full_analysis", 150_000)]),
    prow(2, rating({ nps: 3, pay: "maybe", ret: 5, quit: true })),
    prow(3, null, [turn("fast", 8000, true)]),
  ];

  it("summarizes a panel, excluding failed personas from ratings but not from collapse", () => {
    const s = summarizePanel(rows);
    expect(s).toMatchObject({ personas: 3, rated: 2, failed: 1, nps: 0, quit: 1, lostAnswerToCollapse: 1, collapsedTurns: 1 });
    expect(s.wouldPay).toEqual({ yes: 1, maybe: 1, no: 0 });
    expect(s.wouldReturnMean).toBe(6);
    expect(s.lanes.find((l) => l.lane === "fast")?.medianSec).toBe(6);
  });

  it("compares against the baseline with the right direction per metric", () => {
    const c = compare(baseline as unknown as Baseline, summarizePanel(rows));
    const by = (m: string) => c.find((r) => r.metric === m)!;
    expect(by("NPS").better).toBe(true);
    expect(by("Lost a finished answer to collapse (share)").baseline).toBeCloseTo(44 / 50);
    expect(by("Wait p50 (s): full_analysis")).toMatchObject({ baseline: 253, now: 150, better: true });
    expect(by("Wait p50 (s): deep_research").better).toBeNull();
  });

  it("scores the launch gate and never passes a criterion it has no data for", () => {
    const live = summarizeLive([
      { prompt: "a", lane: "fast", routed: "fast", ttftMs: 900, totalMs: 7000, collapse: null, contract: null, numberCheck: null, httpStatus: 200, error: null, answerChars: 10, scenario: "s", expect: "fast" },
      { prompt: "b", lane: "full_analysis", routed: null, ttftMs: 60_000, totalMs: 200_000, collapse: null, contract: null, numberCheck: null, httpStatus: 200, error: null, answerChars: 10, scenario: "s", expect: "full_analysis" },
    ]);
    const g = launchGate({
      smoke: { collapsePassed: true, switchesPassed: 13, switchesTotal: 13 },
      live,
      panel: null,
      manual: { lawyerReviewed: false, capsMeasured: true, privacyTodosClosed: false },
    });
    const by = (s: string) => g.find((x) => x.criterion.startsWith(s))!.status;
    expect(by("Zero collapse")).toBe("pass");
    expect(by("Fast-lane p50")).toBe("pass");
    expect(by("Full-analysis p90")).toBe("fail");
    expect(by("13/13")).toBe("pass");
    expect(by("Number-check")).toBe("unavailable");
    expect(by("Legal packet")).toBe("manual");
    expect(by("Per-lane caps")).toBe("pass");
    expect(by("Panel would-return")).toBe("unavailable");
  });

  it("reads hand-ticked gate items from the doc", () => {
    expect(manualGate("- [x] Legal packet reviewed by a lawyer\n- [ ] Per-lane caps measured\n- [X] /privacy entity and postal address TODOs closed")).toEqual({
      lawyerReviewed: true,
      capsMeasured: false,
      privacyTodosClosed: true,
    });
  });
});

describe("analysis helpers", () => {
  it("samples claims round-robin across personas", () => {
    const r = (id: number, claims: string[]) => ({ persona: { id }, rating: { claims } });
    expect(sampleClaims([r(1, ["a1", "a2"]), r(2, ["b1"]), r(3, [])], 3)).toEqual([
      { personaId: 1, claim: "a1" },
      { personaId: 2, claim: "b1" },
      { personaId: 1, claim: "a2" },
    ]);
  });

  it("takes the last JSON object from prose", () => {
    expect(lastJsonObject<{ verdict: string }>('Checked {a} the 10-K. {"verdict": "wrong", "note": "x {y}"}')).toEqual({ verdict: "wrong", note: "x {y}" });
    expect(lastJsonObject("no json")).toBeNull();
  });
});
