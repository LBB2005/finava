import { describe, it, expect } from "vitest";

import {
  EXCERPT_CHARS,
  buildEvidenceItem,
  coversSubject,
  evidenceContentHash,
  evidenceFieldOf,
  evidenceId,
  isValidPeriod,
  partitionEvidence,
  unknownEvidenceIds,
  type EvidenceDraft,
} from "./evidence";
import type { EvidenceItem, ResearchClaim } from "./schemas";

const AS_OF = "2026-09-22T12:00:00.000Z";

function draft(over: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    ticker: "TEST",
    field: "freeCashFlow",
    kind: "financial",
    source: "sec_edgar",
    url: "https://example.test/filing",
    publishedAt: "2026-08-01T00:00:00.000Z",
    period: "FY2025",
    value: 1_234_000_000,
    unit: "usd",
    text: "Net cash provided by operating activities less capital expenditures",
    ...over,
  };
}

function built(over: Partial<EvidenceDraft> = {}) {
  const result = buildEvidenceItem(draft(over), { asOf: AS_OF });
  if (!result.ok) throw new Error(`expected a built item, got: ${result.reason}`);
  return result.built;
}

// ── The plan's fixture ───────────────────────────────────────────────────────

describe("unknownEvidenceIds", () => {
  it("names an id a claim cited that does not exist", () => {
    expect(
      unknownEvidenceIds(
        [
          {
            id: "c1",
            agent: "risk",
            ticker: "TEST",
            text: "Debt increased",
            evidenceIds: ["missing"],
            kind: "observed",
            direction: "bear",
          },
        ],
        []
      )
    ).toEqual(["missing"]);
  });

  it("returns nothing when every citation resolves", () => {
    const item = built().item;
    const claim: ResearchClaim = {
      id: "c1",
      agent: "risk",
      ticker: "TEST",
      text: "Free cash flow was 1.234bn in FY2025",
      evidenceIds: [item.id],
      kind: "observed",
      direction: "neutral",
    };
    expect(unknownEvidenceIds([claim], [item])).toEqual([]);
  });

  it("reports each missing id once, in first-reference order", () => {
    const claim = (ids: string[], n: number): ResearchClaim => ({
      id: `c${n}`,
      agent: "risk",
      ticker: "TEST",
      text: `claim ${n}`,
      evidenceIds: ids,
      kind: "observed",
      direction: "bear",
    });
    expect(
      unknownEvidenceIds([claim(["zz", "aa"], 1), claim(["aa", "zz"], 2)], [])
    ).toEqual(["zz", "aa"]);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("evidenceContentHash", () => {
  it("is the same for the same content", () => {
    expect(evidenceContentHash(draft())).toBe(evidenceContentHash(draft()));
  });

  it("ignores when WE read it — two reads of one filing are one piece of content", () => {
    expect(evidenceContentHash(draft({ observedAt: "2026-09-22T09:00:00.000Z" }))).toBe(
      evidenceContentHash(draft({ observedAt: "2026-09-22T17:30:00.000Z" }))
    );
  });

  it("changes when the period changes — a restatement is different content", () => {
    expect(evidenceContentHash(draft({ period: "FY2024" }))).not.toBe(
      evidenceContentHash(draft({ period: "FY2025" }))
    );
  });

  it("changes when the unit changes, even at the same number", () => {
    expect(evidenceContentHash(draft({ value: 12, unit: "ratio" }))).not.toBe(
      evidenceContentHash(draft({ value: 12, unit: "usd_per_share" }))
    );
  });

  it("normalises ticker case, so aapl and AAPL are one piece of content", () => {
    expect(evidenceContentHash(draft({ ticker: "aapl" }))).toBe(
      evidenceContentHash(draft({ ticker: "AAPL" }))
    );
  });
});

describe("evidence ids", () => {
  it("carries the field, which the persisted contract has nowhere to put", () => {
    const item = built().item;
    expect(evidenceFieldOf(item.id)).toBe("freeCashFlow");
  });

  it("returns null for an id we did not build", () => {
    expect(evidenceFieldOf("some-other-id")).toBeNull();
    expect(evidenceFieldOf("a__b")).toBeNull();
  });

  it("is derived from the content hash, so identical content collides on purpose", () => {
    const hash = evidenceContentHash(draft());
    expect(built().item.id).toBe(evidenceId("freeCashFlow", "financial", hash));
  });
});

// ── Standing ─────────────────────────────────────────────────────────────────

describe("standing against the run as-of", () => {
  it("stamps a figure published before the cutoff as clean", () => {
    expect(built().item.standing).toBe("clean");
  });

  it("keeps an undated figure as undated — not clean, not excluded", () => {
    const b = built({ publishedAt: null });
    expect(b.item.standing).toBe("undated");
    expect(b.item.publishedAt).toBeNull();
    // observedAt is still known, because we did the reading.
    expect(b.item.observedAt).not.toBe("");
  });

  it("stamps a figure published after the cutoff as post_asof", () => {
    expect(built({ publishedAt: "2026-09-23T00:00:00.000Z" }).item.standing).toBe("post_asof");
  });

  it("withholds post-as-of evidence and keeps undated evidence usable", () => {
    const clean = built();
    const undated = built({ publishedAt: null, field: "netDebt" });
    const future = built({ publishedAt: "2026-10-01T00:00:00.000Z", field: "capex" });

    const part = partitionEvidence([clean, undated, future]);
    expect(part.withheld.map((b) => b.field)).toEqual(["capex"]);
    expect(part.usable.map((b) => b.field)).toEqual(["freeCashFlow", "netDebt"]);
    // Clean plus undated is not the same as clean: the weakness is recorded.
    expect(part.unverifiable.map((b) => b.field)).toEqual(["netDebt", "capex"]);
  });
});

// ── Units, periods, tickers ──────────────────────────────────────────────────

describe("unit validation", () => {
  it("refuses a number with no unit", () => {
    const r = buildEvidenceItem(draft({ unit: null }), { asOf: AS_OF });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no unit/);
  });

  it("refuses a percentage unit, because returns here are fractions", () => {
    const r = buildEvidenceItem(
      // @ts-expect-error — "percent" is deliberately absent from the enum.
      draft({ value: 15, unit: "percent" }),
      { asOf: AS_OF }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unsupported unit/);
  });

  it("refuses a unit with no value", () => {
    const r = buildEvidenceItem(draft({ value: null }), { asOf: AS_OF });
    expect(r.ok).toBe(false);
  });

  it("accepts prose evidence carrying no figure at all", () => {
    const r = buildEvidenceItem(
      draft({ kind: "news", value: null, unit: null, period: null, field: "litigation" }),
      { asOf: AS_OF }
    );
    expect(r.ok).toBe(true);
  });
});

describe("period validation", () => {
  it("accepts the declared forms and rejects free text", () => {
    for (const p of ["FY2025", "Q2 2026", "Q2 FY2026", "H1 2026", "TTM 2026-06-30", "2026-06-30"]) {
      expect(isValidPeriod(p)).toBe(true);
    }
    for (const p of ["last year", "FY25", "Q5 2026", ""]) {
      expect(isValidPeriod(p)).toBe(false);
    }
  });

  it("refuses a financial figure with no period", () => {
    const r = buildEvidenceItem(draft({ period: null }), { asOf: AS_OF });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/must declare the period/);
  });

  it("refuses an unrecognised period rather than storing it", () => {
    const r = buildEvidenceItem(draft({ period: "last quarter" }), { asOf: AS_OF });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unrecognised period/);
  });
});

describe("ticker validation", () => {
  it("upper-cases what it accepts", () => {
    expect(built({ ticker: " brk.b " }).item.ticker).toBe("BRK.B");
  });

  it("refuses something that is not a ticker", () => {
    for (const t of ["", "not a ticker", "123", "TOOLONGTICKERHERE"]) {
      expect(buildEvidenceItem(draft({ ticker: t }), { asOf: AS_OF }).ok).toBe(false);
    }
  });
});

// ── Subject coverage ─────────────────────────────────────────────────────────

describe("coversSubject", () => {
  const item = built().item;

  it("covers a matching ticker, field and period", () => {
    expect(
      coversSubject(item, { ticker: "TEST", period: "FY2025", fields: ["freeCashFlow"] })
    ).toBe(true);
  });

  it("does not cover a claim about another security", () => {
    expect(coversSubject(item, { ticker: "OTHER", period: "FY2025", fields: [] })).toBe(false);
  });

  it("does not cover a claim about another period", () => {
    expect(coversSubject(item, { ticker: "TEST", period: "FY2024", fields: [] })).toBe(false);
  });

  it("does not cover another input, however relevant the source looks", () => {
    expect(coversSubject(item, { ticker: "TEST", period: "FY2025", fields: ["netDebt"] })).toBe(
      false
    );
  });

  it("refuses an undated figure as support for a period-specific claim", () => {
    const undated: EvidenceItem = {
      ...item,
      id: evidenceId("litigation", "news", item.contentHash),
      kind: "news",
      period: null,
      standing: "undated",
    };
    expect(coversSubject(undated, { ticker: "TEST", period: "FY2025", fields: [] })).toBe(false);
    expect(coversSubject(undated, { ticker: "TEST", period: null, fields: [] })).toBe(true);
  });
});

// ── Excerpts ─────────────────────────────────────────────────────────────────

describe("excerpts", () => {
  it("caps what the snapshot carries and keeps the full text for chunked storage", () => {
    const long = "x".repeat(EXCERPT_CHARS * 3);
    const b = built({ text: long });
    expect(b.item.excerpt.length).toBe(EXCERPT_CHARS);
    expect(b.fullText.length).toBe(long.length);
  });
});
