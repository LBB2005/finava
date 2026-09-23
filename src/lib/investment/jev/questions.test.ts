import { describe, it, expect } from "vitest";
import { JevQuestionSchema } from "./schemas";
import {
  buildFirstPassQuestions,
  buildScenarioQuestion,
  buildSecondPassQuestions,
  formatBoundary,
  CONTRADICTORY_EVIDENCE_OPTIONS,
  FIRST_PASS_QUESTION_IDS,
  INSUFFICIENT_EVIDENCE,
  NO_USABLE_SOURCES_LEVEL,
  QUESTION_SET_VERSION,
  SCENARIO_OPTIONS,
  SCENARIO_QUESTION_ID,
  SECOND_PASS_QUESTION_IDS,
  SOURCE_ADEQUACY_LEVELS,
  SUPPLIED_DATA_FIT_OPTIONS,
  THESIS_SUPPORT_OPTIONS,
} from "./questions";

const FIRST = buildFirstPassQuestions({ ticker: "NVDA", criteria: ["durable pricing power"] });
const SECOND = buildSecondPassQuestions({ ticker: "NVDA", thesis: "Datacentre demand holds through FY27." });
const SCENARIO = buildScenarioQuestion({
  ticker: "NVDA",
  asOf: "2026-09-19T20:00:00.000Z",
  targetDate: "2027-09-19",
  boundaries: [-0.05, 0.4],
});

describe("the version constant", () => {
  it("is persisted with every report, so it must be a stable non-empty string", () => {
    expect(QUESTION_SET_VERSION).toBe("jevq-v1-2026-09-22");
  });
});

describe("every question validates against the request contract", () => {
  it("accepts all three sets", () => {
    for (const set of [FIRST, SECOND, SCENARIO]) {
      for (const [id, q] of Object.entries(set)) {
        const parsed = JevQuestionSchema.safeParse(q);
        expect(parsed.success, `${id} failed: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      }
    }
  });
});

describe("the first pass", () => {
  it("asks exactly the declared ids, batched into one request", () => {
    expect(Object.keys(FIRST).sort()).toEqual([...FIRST_PASS_QUESTION_IDS].sort());
  });

  it("uses one of each primitive: a choice, a score and a noul", () => {
    expect(FIRST.supplied_data_fit.type).toBe("choice");
    expect(FIRST.source_adequacy.type).toBe("score");
    expect(FIRST.contradiction_flags.type).toBe("noul");
  });

  it("offers an explicit unknown option on the fit rubric", () => {
    const q = FIRST.supplied_data_fit;
    if (q.type !== "choice") throw new Error("expected a choice");
    expect(Object.keys(q.criteria).sort()).toEqual([...SUPPLIED_DATA_FIT_OPTIONS].sort());
    expect(q.criteria[INSUFFICIENT_EVIDENCE]).toMatch(/does not say enough/i);
  });

  it("tells the model that missing evidence is not a finding against the company", () => {
    const q = FIRST.supplied_data_fit;
    if (q.type !== "choice") throw new Error("expected a choice");
    expect(q.instructions).toContain("absent is not evidence against the company");
    // And the misfit option says outright which question it answers.
    expect(q.criteria.does_not_fit).toMatch(/not about the company's quality/i);
  });

  it("never asks the model to apply a numeric threshold", () => {
    const q = FIRST.supplied_data_fit;
    if (q.type !== "choice") throw new Error("expected a choice");
    expect(q.instructions).toMatch(/figures are checked in code/i);
  });

  it("keeps the source-adequacy levels inside the 2–10 the contract allows, ordered worst first", () => {
    expect(SOURCE_ADEQUACY_LEVELS.length).toBeGreaterThanOrEqual(2);
    expect(SOURCE_ADEQUACY_LEVELS.length).toBeLessThanOrEqual(10);
    // The bottom level is the unknown state, not a bad-company state.
    expect(SOURCE_ADEQUACY_LEVELS[NO_USABLE_SOURCES_LEVEL]).toMatch(/cannot be judged either way/i);
    const q = FIRST.source_adequacy;
    if (q.type !== "score") throw new Error("expected a score");
    expect(q.criteria).toEqual([...SOURCE_ADEQUACY_LEVELS]);
  });

  it("scores the SOURCES, and says so, so a good company with no sources scores low", () => {
    const q = FIRST.source_adequacy;
    if (q.type !== "score") throw new Error("expected a score");
    expect(q.instructions).toMatch(/not the company/i);
    expect(q.instructions).toMatch(/no dated sources belongs at a low level/i);
  });

  it("falls back to a stated wording when the mandate named no criteria", () => {
    const none = buildFirstPassQuestions({ ticker: "NVDA", criteria: [] });
    const q = none.supplied_data_fit;
    if (q.type !== "choice") throw new Error("expected a choice");
    expect(q.instructions).toContain("none were stated");
  });
});

describe("the second pass", () => {
  it("asks exactly the two evidence questions — the distribution is a LATER call", () => {
    expect(Object.keys(SECOND).sort()).toEqual([...SECOND_PASS_QUESTION_IDS].sort());
    expect(SECOND[SCENARIO_QUESTION_ID]).toBeUndefined();
  });

  it("keeps 'not addressed' off the same axis as 'contradicted'", () => {
    const q = SECOND.thesis_support;
    if (q.type !== "choice") throw new Error("expected a choice");
    expect(Object.keys(q.criteria).sort()).toEqual([...THESIS_SUPPORT_OPTIONS].sort());
    expect(q.criteria.contradicted).toMatch(/never merely because supporting evidence is missing/i);
    expect(q.criteria[INSUFFICIENT_EVIDENCE]).toMatch(/does not address the thesis/i);
  });

  it("offers an unknown option on the contradictory-evidence rubric too", () => {
    const q = SECOND.contradictory_evidence;
    if (q.type !== "choice") throw new Error("expected a choice");
    expect(Object.keys(q.criteria).sort()).toEqual([...CONTRADICTORY_EVIDENCE_OPTIONS].sort());
    expect(q.criteria.none_found).toMatch(/enough evidence for that absence to mean something/i);
  });
});

describe("the scenario distribution", () => {
  it("offers exactly the three scenario ids, by the names the mapper expects", () => {
    const q = SCENARIO[SCENARIO_QUESTION_ID];
    if (q.type !== "choice") throw new Error("expected a choice");
    expect(Object.keys(q.criteria).sort()).toEqual([...SCENARIO_OPTIONS].sort());
  });

  it("is the ONE rubric with no unknown option, because the mass has to sum to 1", () => {
    const q = SCENARIO[SCENARIO_QUESTION_ID];
    if (q.type !== "choice") throw new Error("expected a choice");
    // The unknown case is handled by not asking at all — see assessScenarios' gates.
    expect(q.criteria[INSUFFICIENT_EVIDENCE]).toBeUndefined();
  });

  it("states the buckets as half-open intervals, matching classifyRealisedReturn", () => {
    const q = SCENARIO[SCENARIO_QUESTION_ID];
    if (q.type !== "choice") throw new Error("expected a choice");
    expect(q.criteria.bear).toBe("Total return below -5.00%.");
    expect(q.criteria.base).toBe("Total return at or above -5.00% and below 40.00%.");
    expect(q.criteria.bull).toBe("Total return at or above 40.00%.");
  });

  it("defines the measurement window and forbids doing the arithmetic", () => {
    const q = SCENARIO[SCENARIO_QUESTION_ID];
    if (q.type !== "choice") throw new Error("expected a choice");
    expect(q.instructions).toContain("2026-09-19T20:00:00.000Z");
    expect(q.instructions).toContain("2027-09-19");
    expect(q.instructions).toMatch(/do not calculate\s*any return yourself/i);
    expect(q.instructions).toMatch(/cover every possible outcome/i);
    // No anchoring on the middle bucket just because it is labelled "base".
    expect(q.instructions).toMatch(/not treat the middle bucket as\s*more likely/i);
  });

  it("refuses boundaries that are not ascending — overlapping buckets are unanswerable", () => {
    const base = { ticker: "NVDA", asOf: "2026-09-19", targetDate: "2027-09-19" };
    expect(() => buildScenarioQuestion({ ...base, boundaries: [0.4, -0.05] })).toThrow(/ascending/);
    expect(() => buildScenarioQuestion({ ...base, boundaries: [0.1, 0.1] })).toThrow(/ascending/);
    expect(() => buildScenarioQuestion({ ...base, boundaries: [Number.NaN, 0.1] })).toThrow(/finite/);
  });
});

describe("formatBoundary", () => {
  it("renders a fraction as a fixed two-decimal percentage", () => {
    expect(formatBoundary(0.1234)).toBe("12.34%");
    expect(formatBoundary(-0.05)).toBe("-5.00%");
    expect(formatBoundary(0)).toBe("0.00%");
  });

  it("throws rather than printing NaN% into a question", () => {
    expect(() => formatBoundary(Number.NaN)).toThrow(/finite/);
  });
});

describe("no question conditions on another's answer", () => {
  it("never mentions a sibling question's id in its own instructions", () => {
    for (const set of [FIRST, SECOND, SCENARIO]) {
      const ids = Object.keys(set);
      for (const [id, q] of Object.entries(set)) {
        for (const other of ids) {
          if (other === id) continue;
          expect(q.instructions, `${id} referenced ${other}`).not.toContain(other);
        }
      }
    }
  });
});
