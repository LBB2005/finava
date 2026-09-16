import { describe, it, expect, vi } from "vitest";
import {
  normalizeFigure,
  extractFigures,
  quoteAppearsIn,
  parseCritique,
  validateIssues,
  buildEvidenceBlock,
  foldCaveats,
  summarizeSkeptic,
  serializeSkepticReport,
  parseSkepticReport,
  critiqueAndRevise,
} from "./skeptic";
import type { AgentEvent, SkepticIssue, SkepticReport } from "@/types/chat";

const issue = (over: Partial<SkepticIssue> = {}): SkepticIssue => ({
  quote: "revenue grew 12%",
  problem: "unsourced",
  fix: "remove it",
  ...over,
});

describe("normalizeFigure", () => {
  it("collapses currency, separators and magnitude suffixes to one canonical number", () => {
    expect(normalizeFigure("$1.2B")).toBe("1200000000");
    expect(normalizeFigure("1,200,000,000")).toBe("1200000000");
    expect(normalizeFigure("1.2 billion")).toBe("1200000000");
    expect(normalizeFigure("$1.2bn")).toBe("1200000000");
  });

  it("keeps plain and percentage figures comparable", () => {
    expect(normalizeFigure("45.3%")).toBe("45.3");
    expect(normalizeFigure("45.30")).toBe("45.3");
    expect(normalizeFigure("$187.42")).toBe("187.42");
  });

  it("returns null for text that holds no number", () => {
    expect(normalizeFigure("Unavailable")).toBeNull();
    expect(normalizeFigure("")).toBeNull();
  });
});

describe("extractFigures", () => {
  it("pulls every figure out of a sentence in canonical form", () => {
    const figs = extractFigures("Free cash flow was $1.2B on a 45.3% gross margin.");
    expect(figs.has("1200000000")).toBe(true);
    expect(figs.has("45.3")).toBe(true);
  });

  it("matches the same value written two different ways", () => {
    const draft = extractFigures("FCF of $1.2B");
    const evidence = extractFigures("net cash from operations: 1,200,000,000 USD");
    expect([...draft].some((f) => evidence.has(f))).toBe(true);
  });
});

describe("quoteAppearsIn", () => {
  const draft = "## Answer\nApple's **free cash flow** was $1.2B last\nquarter.";

  it("accepts a quote lifted verbatim from the draft", () => {
    expect(quoteAppearsIn(draft, "free cash flow was $1.2B")).toBe(true);
  });

  it("ignores markdown emphasis and line wrapping the model dropped", () => {
    expect(quoteAppearsIn(draft, "was $1.2B last quarter.")).toBe(true);
  });

  it("rejects a quote that is not in the draft at all", () => {
    expect(quoteAppearsIn(draft, "operating margin hit 31%")).toBe(false);
  });

  it("rejects an empty quote", () => {
    expect(quoteAppearsIn(draft, "   ")).toBe(false);
  });
});

describe("parseCritique", () => {
  it("reads the issue list out of a bare JSON object", () => {
    const out = parseCritique('{"issues":[{"quote":"a","problem":"stale","fix":"b"}]}');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ quote: "a", problem: "stale", fix: "b" });
  });

  it("reads it out of a fenced block with chatter around it", () => {
    const out = parseCritique('Sure!\n```json\n{"issues":[{"quote":"x","problem":"overclaim","fix":"y"}]}\n```\n');
    expect(out).toHaveLength(1);
    expect(out[0].problem).toBe("overclaim");
  });

  it("drops entries with an unknown problem type or no quote", () => {
    const out = parseCritique(
      '{"issues":[{"quote":"a","problem":"vibes","fix":"b"},{"quote":"","problem":"stale","fix":"b"},{"quote":"c","problem":"advice_line","fix":"d"}]}'
    );
    expect(out).toHaveLength(1);
    expect(out[0].quote).toBe("c");
  });

  it("returns nothing for unparseable text rather than throwing", () => {
    expect(parseCritique("the report looks fine to me")).toEqual([]);
    expect(parseCritique("")).toEqual([]);
  });
});

describe("validateIssues", () => {
  const draft = "Revenue grew 12% and free cash flow was $1.2B.";

  it("drops an issue whose quote is not verbatim in the draft", () => {
    const kept = validateIssues(
      [issue({ quote: "Revenue grew 12%" }), issue({ quote: "margins collapsed to 3%" })],
      { draft, evidence: new Map() }
    );
    expect(kept.map((i) => i.quote)).toEqual(["Revenue grew 12%"]);
  });

  it("does not let a figure that matches the evidence be flagged unsourced", () => {
    // The readout's SEC false positive: the filing reported 1,200,000,000 and the
    // draft wrote $1.2B, and the old skeptic called it fabricated.
    const evidence = new Map([["run_fundamentals_agent", "10-K net cash: 1,200,000,000 (SEC EDGAR, FY2025)"]]);
    const kept = validateIssues(
      [issue({ quote: "free cash flow was $1.2B", problem: "unsourced" })],
      { draft, evidence }
    );
    expect(kept).toEqual([]);
  });

  it("still flags a figure no agent reported", () => {
    const evidence = new Map([["run_fundamentals_agent", "10-K net cash: 1,200,000,000"]]);
    const kept = validateIssues(
      [issue({ quote: "Revenue grew 12%", problem: "unsourced" })],
      { draft, evidence }
    );
    expect(kept).toHaveLength(1);
  });

  it("keeps a non-unsourced problem even when the numbers check out", () => {
    const evidence = new Map([["a", "1,200,000,000"]]);
    const kept = validateIssues(
      [issue({ quote: "free cash flow was $1.2B", problem: "contradicts_evidence" })],
      { draft, evidence }
    );
    expect(kept).toHaveLength(1);
  });

  it("keeps an unsourced claim that carries no figure at all", () => {
    const kept = validateIssues(
      [issue({ quote: "Revenue grew", problem: "unsourced" })],
      { draft: "Revenue grew and margins held.", evidence: new Map([["a", "12"]]) }
    );
    expect(kept).toHaveLength(1);
  });

  it("de-duplicates repeated quotes", () => {
    const kept = validateIssues(
      [issue({ quote: "Revenue grew 12%" }), issue({ quote: "Revenue grew 12%" })],
      { draft, evidence: new Map() }
    );
    expect(kept).toHaveLength(1);
  });
});

describe("buildEvidenceBlock", () => {
  it("passes each agent's output in full when it fits the budget", () => {
    const outputs = new Map([
      ["run_risk_agent", "beta 1.14 as of 2026-09-12"],
      ["run_dcf_agent", "fair value $190"],
    ]);
    const block = buildEvidenceBlock(outputs, "beta is 1.14", 10_000);
    expect(block).toContain("beta 1.14 as of 2026-09-12");
    expect(block).toContain("fair value $190");
    expect(block).not.toContain("…");
  });

  it("puts the agents whose numbers are in the draft first when it must cut", () => {
    const outputs = new Map([
      ["run_news_agent", "N".repeat(400)],
      ["run_risk_agent", `beta 1.14 ${"R".repeat(300)}`],
    ]);
    const block = buildEvidenceBlock(outputs, "portfolio beta is 1.14", 420);
    expect(block.indexOf("run_risk_agent")).toBeGreaterThanOrEqual(0);
    // The risk agent's numbers are the ones the draft used, so it survives the cut.
    expect(block).toContain("beta 1.14");
  });

  it("says out loud when an agent had to be left out", () => {
    const outputs = new Map([
      ["run_risk_agent", "beta 1.14"],
      ["run_news_agent", "N".repeat(5_000)],
    ]);
    const block = buildEvidenceBlock(outputs, "beta 1.14", 300);
    expect(block).toMatch(/not shown|omitted/i);
  });

  it("is explicit when there is no evidence at all", () => {
    expect(buildEvidenceBlock(new Map(), "draft")).toMatch(/no .*evidence/i);
  });
});

describe("foldCaveats", () => {
  const caveats = [issue({ quote: "revenue grew 12%", problem: "unsourced", fix: "drop it" })];

  it("appends the caveat to an existing Confidence & gaps section", () => {
    const md = "## Answer\nYes.\n\n## Confidence & gaps\nMedium — no options data.\n\n## Details\nmore";
    const out = foldCaveats(md, caveats);
    const conf = out.split("## Confidence & gaps")[1].split("## Details")[0];
    expect(conf).toContain("Medium — no options data.");
    expect(conf).toContain("revenue grew 12%");
    expect(out.endsWith("more")).toBe(true);
  });

  it("creates the section above Details when the answer has none", () => {
    const md = "## Answer\nYes.\n\n## Details\nmore";
    const out = foldCaveats(md, caveats);
    expect(out.indexOf("## Confidence & gaps")).toBeGreaterThan(out.indexOf("## Answer"));
    expect(out.indexOf("## Confidence & gaps")).toBeLessThan(out.indexOf("## Details"));
  });

  it("appends the section at the end when there is no Details either", () => {
    const out = foldCaveats("## Answer\nYes.", caveats);
    expect(out).toContain("## Confidence & gaps");
    expect(out).toContain("revenue grew 12%");
  });

  it("matches the 'Confidence and gaps' spelling too", () => {
    const out = foldCaveats("## Answer\nYes.\n\n## Confidence and gaps\nLow.", caveats);
    expect(out.match(/## Confidence/g)).toHaveLength(1);
  });

  it("returns the answer untouched when nothing is left unresolved", () => {
    const md = "## Answer\nYes.";
    expect(foldCaveats(md, [])).toBe(md);
  });
});

describe("summarizeSkeptic", () => {
  it("counts the evidence read, the corrections and the caveats", () => {
    const line = summarizeSkeptic({
      status: "reviewed",
      agentsReviewed: 4,
      corrections: [issue(), issue(), issue()],
      caveats: [issue()],
    });
    expect(line).toBe("Reviewed against 4 analysts' evidence · 3 corrections applied · 1 caveat");
  });

  it("says so plainly when the review found nothing to fix", () => {
    const line = summarizeSkeptic({ status: "reviewed", agentsReviewed: 2, corrections: [], caveats: [] });
    expect(line).toBe("Reviewed against 2 analysts' evidence · no corrections needed");
  });

  it("never claims a review that did not happen", () => {
    expect(summarizeSkeptic({ status: "skipped", reason: "no time left", agentsReviewed: 0, corrections: [], caveats: [] }))
      .toBe("Second opinion didn't run for this answer — no time left");
    expect(summarizeSkeptic({ status: "failed", agentsReviewed: 0, corrections: [], caveats: [] }))
      .toBe("Second opinion didn't run for this answer");
  });
});

describe("serializeSkepticReport / parseSkepticReport", () => {
  it("round-trips a report", () => {
    const report = {
      status: "reviewed" as const,
      agentsReviewed: 3,
      corrections: [issue()],
      caveats: [issue({ problem: "stale" as const })],
    };
    expect(parseSkepticReport(serializeSkepticReport(report))).toEqual(report);
  });

  it("treats a legacy markdown critique as 'not a report' so the old rendering still works", () => {
    expect(parseSkepticReport("**Skeptic Review:** the beta claim is unsourced.")).toBeNull();
    expect(parseSkepticReport(undefined)).toBeNull();
    expect(parseSkepticReport("")).toBeNull();
  });
});

/* ── The review → revision pass ──────────────────────────────────────────── */

describe("critiqueAndRevise", () => {
  const draft = "## Answer\nApple is fine. Free cash flow was $1.2B and revenue grew 12%.\n\n## Details\nmore";
  const evidence = new Map([
    ["run_fundamentals_agent", "FY2025 net cash from operations: 1,200,000,000 (SEC EDGAR)"],
    ["run_risk_agent", "portfolio beta 1.14 as of 2026-09-12"],
  ]);

  function harness(over: Partial<Parameters<typeof critiqueAndRevise>[0]> = {}) {
    const events: AgentEvent[] = [];
    const revise = vi.fn(async ({ onDelta }: { onDelta: (d: string) => void }) => {
      onDelta("## Answer\nApple is fine. Free cash flow was $1.2B.\n\n## Details\nmore");
      return { text: "## Answer\nApple is fine. Free cash flow was $1.2B.\n\n## Details\nmore", truncated: false };
    });
    return {
      events,
      revise,
      run: (generate: (o: unknown) => Promise<string>) =>
        critiqueAndRevise({
          draft,
          draftAssistantBlocks: [{ type: "text", text: draft }],
          agentOutputs: evidence,
          messages: [],
          systemPrompt: "sys",
          maxTokens: 1000,
          emit: (e) => events.push(e),
          generate: generate as never,
          revise: revise as never,
          ...over,
        }),
    };
  }

  const issuesJson = (...issues: unknown[]) => JSON.stringify({ issues });
  const report = (events: AgentEvent[]) =>
    (events.find((e) => e.type === "skeptic_complete") as { report?: SkepticReport } | undefined)?.report;

  it("drops a critique of text that is not in the draft, and never revises for it", async () => {
    const h = harness();
    const out = await h.run(async () =>
      issuesJson({ quote: "operating margin collapsed to 3%", problem: "contradicts_evidence", fix: "remove it" })
    );

    expect(h.revise).not.toHaveBeenCalled();
    expect(out.finalResponse).toBe(draft);
    expect(report(h.events)).toMatchObject({ status: "reviewed", corrections: [], caveats: [] });
  });

  it("does not flag a figure that the agents' evidence actually reports", async () => {
    // The readout's SEC false positive: $1.2B in the draft, 1,200,000,000 in the filing.
    const h = harness();
    const out = await h.run(async () =>
      issuesJson({ quote: "Free cash flow was $1.2B", problem: "unsourced", fix: "remove the figure" })
    );

    expect(h.revise).not.toHaveBeenCalled();
    expect(out.finalResponse).toBe(draft);
    expect(report(h.events)?.caveats).toEqual([]);
  });

  it("revises for a real issue and counts it as a correction once the quote is gone", async () => {
    const h = harness();
    const out = await h.run(async () =>
      issuesJson({ quote: "revenue grew 12%", problem: "unsourced", fix: "remove it — no agent reported revenue growth" })
    );

    expect(h.revise).toHaveBeenCalledTimes(1);
    expect(out.finalResponse).not.toContain("revenue grew 12%");
    const r = report(h.events)!;
    expect(r.corrections).toHaveLength(1);
    expect(r.caveats).toHaveLength(0);
    expect(r.agentsReviewed).toBe(2);
  });

  it("folds an issue the revision left in place into Confidence & gaps", async () => {
    const h = harness({
      // The revision ignores the issue — the offending line survives verbatim.
      revise: vi.fn(async ({ onDelta }: { onDelta: (d: string) => void }) => {
        onDelta(draft);
        return { text: draft, truncated: false };
      }) as never,
    });
    const out = await h.run(async () =>
      issuesJson({ quote: "revenue grew 12%", problem: "unsourced", evidence: "no agent reported revenue", fix: "remove it" })
    );

    expect(out.finalResponse).toContain("## Confidence & gaps");
    expect(out.finalResponse).toContain("revenue grew 12%");
    const r = report(h.events)!;
    expect(r.caveats).toHaveLength(1);
    expect(r.corrections).toHaveLength(0);
    // The folded text differs from what streamed, so the caller must replace it.
    expect(out.streamed).toBe(false);
  });

  it("skips the review when the run's budget is nearly spent, and says so", async () => {
    const h = harness({ remainingMs: 12_000 });
    const generate = vi.fn(async () => issuesJson());
    const out = await h.run(generate);

    expect(generate).not.toHaveBeenCalled();
    expect(out.finalResponse).toBe(draft);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "skeptic_status", status: "skipped", reason: expect.stringMatching(/time/i) })
    );
    expect(h.events.find((e) => e.type === "skeptic_complete")).toBeUndefined();
  });

  it("still reviews when there is budget left", async () => {
    const h = harness({ remainingMs: 90_000 });
    const generate = vi.fn(async () => issuesJson());
    await h.run(generate);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("reports an honest failure when the reviewer call throws — never a completed step", async () => {
    const h = harness();
    const out = await h.run(async () => {
      throw new Error("upstream 503");
    });

    expect(out.finalResponse).toBe(draft);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "skeptic_status", status: "failed" })
    );
    expect(h.events.find((e) => e.type === "skeptic_complete")).toBeUndefined();
  });

  it("reports an honest failure when the reviewer's answer can't be read", async () => {
    const h = harness();
    await h.run(async () => "I think the report is broadly reasonable.");

    expect(h.events).toContainEqual(expect.objectContaining({ type: "skeptic_status", status: "failed" }));
  });

  it("keeps the partially streamed revision when the revision itself fails", async () => {
    const h = harness({
      revise: vi.fn(async ({ onDelta }: { onDelta: (d: string) => void }) => {
        onDelta("## Answer\nApple is fine.");
        throw new Error("stream aborted");
      }) as never,
    });
    const out = await h.run(async () =>
      issuesJson({ quote: "revenue grew 12%", problem: "unsourced", fix: "remove it" })
    );

    expect(out.finalResponse).toContain("Apple is fine.");
    // A cut-off rewrite takes no credit: the quote vanished with the truncation,
    // not because anyone fixed it.
    const r = report(h.events)!;
    expect(r.revisionFailed).toBe(true);
    expect(r.corrections).toHaveLength(0);
    expect(summarizeSkeptic(r)).toContain("the rewrite didn't finish");
  });

  it("gives the reviewer the whole draft and the evidence in full, not excerpts", async () => {
    const long = "L".repeat(4_000);
    const h = harness();
    let prompt = "";
    await critiqueAndRevise({
      draft: `${draft}\n${long}`,
      draftAssistantBlocks: [{ type: "text", text: draft }],
      agentOutputs: new Map([["run_news_agent", long]]),
      messages: [],
      systemPrompt: "sys",
      maxTokens: 1000,
      emit: (e) => h.events.push(e),
      generate: (async (o: { prompt: string }) => {
        prompt = o.prompt;
        return issuesJson();
      }) as never,
      revise: h.revise as never,
    });

    expect(prompt).toContain(long);
    expect(prompt).not.toContain("[truncated]");
  });

  it("emits skeptic_start exactly once, before anything else it does", async () => {
    const h = harness();
    await h.run(async () => issuesJson());
    expect(h.events.filter((e) => e.type === "skeptic_start")).toHaveLength(1);
    expect(h.events[0].type).toBe("skeptic_start");
  });
});

describe("extractFigures — dates", () => {
  it("does not mistake an as-of date for a reported number", () => {
    const figs = extractFigures("portfolio beta 1.14 as of 2026-09-12 (FY2025, Q3 2024)");
    expect([...figs]).toEqual(["1.14"]);
  });

  it("ignores written and slash dates too", () => {
    expect([...extractFigures("filed Sep 12, 2026 and amended 9/12/2026")]).toEqual([]);
  });
});

describe("summarizeSkeptic — unfinished rewrite", () => {
  it("never reads as 'no corrections needed' when the rewrite was cut off", () => {
    const line = summarizeSkeptic({
      status: "reviewed", revisionFailed: true, agentsReviewed: 2, corrections: [], caveats: [],
    });
    expect(line).toBe("Reviewed against 2 analysts' evidence · the rewrite didn't finish");
  });
});
