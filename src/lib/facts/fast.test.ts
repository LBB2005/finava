import { describe, expect, it, vi } from "vitest";

// finavaInputs → grok → usage → firebase-admin; earnings-agent → llm.
vi.mock("@/lib/sentiment/grok", () => ({ getGrokSentiment: vi.fn() }));
vi.mock("@/lib/llm", () => ({ generate: vi.fn() }));
vi.mock("@/agents/skills", () => ({ getSkillsPrompt: () => "" }));
import aapl from "@/lib/__fixtures__/sec/aapl.json";
import { buildFastFacts, snapshotEdgar, quoteFacts, SRC, type FastSources } from "./fast";

const AT = Date.parse("2026-09-15T18:00:00.000Z");
const QUOTE = {
  ticker: "AAPL", price: 230, change: 2.3, changePct: 1.01, volume: 0, high: 231, low: 227, open: 228, prevClose: 227.7,
  asOf: "2026-09-15T17:59:30.000Z", asOfSource: "exchange" as const,
};
const METRIC = {
  epsTTM: 7.5, "52WeekLow": 170, "52WeekHigh": 260, beta: 1.2, dividendYieldIndicatedAnnual: 0.45,
  marketCapitalization: 3_400_000, shareOutstanding: 14_900, ebitdPerShareTTM: 11,
};
const EARN = { date: "2026-10-28", quarter: 4, year: 2026, epsEstimate: 2.02, epsActual: null, status: "upcoming" as const, estimated: true };

function sources(over: Partial<FastSources> = {}): FastSources {
  return {
    quote: { value: QUOTE, at: AT },
    metric: { value: METRIC, at: AT },
    edgar: { value: snapshotEdgar(aapl), at: AT },
    earnings: { value: EARN, at: AT },
    target: { value: { targetMean: 250, numberOfAnalysts: 38 }, at: AT },
    errors: {},
    ...over,
  };
}

const FIELDS = [
  "price", "change1d", "marketCap", "sharesOut", "pe", "evEbitda", "epsTTM", "range52w", "revenueTTM",
  "netIncomeTTM", "fcfTTM", "cashAndSTI", "debt", "beta", "dividendYield", "nextEarnings", "streetTarget",
] as const;

describe("buildFastFacts", () => {
  it("gives every field a source and an as-of, and a note whenever the value is null", () => {
    const f = buildFastFacts("AAPL", sources());
    for (const k of FIELDS) {
      expect(f[k].source, k).toBeTruthy();
      expect(new Date(f[k].asOf.length === 10 ? `${f[k].asOf}T00:00:00Z` : f[k].asOf).toString(), k).not.toBe("Invalid Date");
      if (f[k].value == null) expect(f[k].note, k).toBeTruthy();
    }
  });

  it("derives P/E, market cap and EV/EBITDA in code", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(f.pe.value).toBeCloseTo(230 / 7.5);
    expect(f.pe.source).toBe(SRC.pe);
    expect(f.marketCap.value).toBeCloseTo(230 * f.sharesOut.value!);
    expect(f.marketCap.source).toBe(SRC.marketCap);
    const ev = f.marketCap.value! + f.debt.value! - f.cashAndSTI.value!;
    expect(f.evEbitda.value).toBeCloseTo(ev / (11 * f.sharesOut.value!));
  });

  it("uses filings for TTM figures with the covered period", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(f.revenueTTM.value).toBeGreaterThan(0);
    expect(f.revenueTTM.period).toMatch(/^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    expect(f.sharesOut.source).toBe(SRC.edgarShares);
  });

  it("refuses a P/E for a loss-maker", () => {
    const f = buildFastFacts("X", sources({ metric: { value: { ...METRIC, epsTTM: -1.2 }, at: AT } }));
    expect(f.pe.value).toBeNull();
    expect(f.pe.note).toMatch(/loss/i);
  });

  it("a failed quote nulls price, change and P/E only; market cap falls back to Finnhub", () => {
    const f = buildFastFacts("AAPL", sources({ quote: null, errors: { quote: "error" } }));
    expect(f.price.value).toBeNull();
    expect(f.price.note).toBe("Source unavailable right now");
    expect(f.change1d.value).toBeNull();
    expect(f.pe.value).toBeNull();
    expect(f.marketCap.value).toBe(3_400_000 * 1e6);
    expect(f.marketCap.source).toBe(SRC.metric);
    expect(f.revenueTTM.value).not.toBeNull();
  });

  it("a timed-out filings read says so on every filing field", () => {
    const f = buildFastFacts("AAPL", sources({ edgar: null, errors: { edgar: "timeout" } }));
    for (const k of ["revenueTTM", "netIncomeTTM", "fcfTTM", "cashAndSTI", "debt"] as const) {
      expect(f[k].value, k).toBeNull();
      expect(f[k].note, k).toBe("Not retrieved in time");
    }
    expect(f.sharesOut.source).toBe(SRC.metric); // Finnhub fallback
  });

  it("a symbol with no SEC filings says so", () => {
    const f = buildFastFacts("SPY", sources({ edgar: { value: snapshotEdgar(null), at: AT } }));
    expect(f.revenueTTM.note).toBe("No SEC filings for this symbol");
  });

  it("never puts a missing-value note on a real value", () => {
    const f = buildFastFacts("AAPL", sources());
    for (const k of ["epsTTM", "beta", "range52w", "debt", "cashAndSTI"] as const) {
      if (f[k].value != null) expect(f[k].note, k).toBeUndefined();
    }
  });

  it("carries the next earnings date and whether it is estimated", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(f.nextEarnings.value).toEqual({ date: "2026-10-28", estimated: true, epsEst: 2.02 });
  });

  it("notes the analyst count on the Street target", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(f.streetTarget.value).toBe(250);
    expect(f.streetTarget.note).toBe("Mean of 38 analysts");
  });
});

describe("quoteFacts", () => {
  it("is exactly what buildFastFacts uses for price and change", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(quoteFacts({ value: QUOTE, at: AT }, {})).toEqual({ price: f.price, change1d: f.change1d });
  });
});
