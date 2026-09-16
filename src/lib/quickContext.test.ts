import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  getQuote: vi.fn(),
  getBasicFinancials: vi.fn(),
  getCompanyNews: vi.fn(),
  getEarningsCalendar: vi.fn(),
  getFactorUniverse: vi.fn(),
}));

vi.mock("@/lib/finnhub", () => ({
  getQuote: deps.getQuote,
  getBasicFinancials: deps.getBasicFinancials,
  getCompanyNews: deps.getCompanyNews,
  getEarningsCalendar: deps.getEarningsCalendar,
}));
vi.mock("@/lib/factorUniverse", () => ({ getFactorUniverse: deps.getFactorUniverse }));

import {
  UNAVAILABLE,
  getQuickContext,
  pickTickers,
  renderQuickContext,
  type QuickContext,
} from "./quickContext";

/** A promise that never settles inside the budget. */
function hangs<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const QUOTE = {
  ticker: "NVDA",
  price: 182.5,
  change: 3.2,
  changePct: 1.79,
  volume: 0,
  high: 0,
  low: 0,
  open: 0,
  prevClose: 179.3,
  asOf: "2026-09-15T20:00:00.000Z",
  asOfSource: "exchange" as const,
};

const FINANCIALS = {
  metric: {
    marketCapitalization: 4_460_000,
    peTTM: 51.2,
    "52WeekHigh": 195.6,
    "52WeekLow": 86.6,
    dividendYieldIndicatedAnnual: 0.02,
    epsTTM: 3.56,
  },
};

const NEWS = [
  { headline: "Nvidia lifts data-centre outlook", source: "Reuters", url: "u1", datetime: 1_757_000_000 },
  { headline: "Supply chain checks point to strong quarter", source: "Bloomberg", url: "u2", datetime: 1_756_900_000 },
  { headline: "Analyst raises target", source: "Barron's", url: "u3", datetime: 1_756_800_000 },
  { headline: "Older story", source: "CNBC", url: "u4", datetime: 1_756_700_000 },
  { headline: "Even older story", source: "WSJ", url: "u5", datetime: 1_756_600_000 },
  { headline: "Ancient story", source: "FT", url: "u6", datetime: 1_756_500_000 },
];

beforeEach(() => {
  vi.clearAllMocks();
  deps.getQuote.mockResolvedValue(QUOTE);
  deps.getBasicFinancials.mockResolvedValue(FINANCIALS);
  deps.getCompanyNews.mockResolvedValue(NEWS);
  deps.getEarningsCalendar.mockResolvedValue({
    earningsCalendar: [{ symbol: "NVDA", date: "2026-11-18", hour: "amc" }],
  });
  deps.getFactorUniverse.mockResolvedValue({
    asOf: "2026-09-15T19:45:00.000Z",
    stocks: [
      {
        ticker: "NVDA",
        f: { mom: 72, growth: 95, quality: 88, analyst: 80, value: 30, health: 66 },
      },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pickTickers", () => {
  it("prefers the tickers named in the message", () => {
    expect(pickTickers({ tickers: ["AMD", "NVDA"] })).toEqual(["AMD", "NVDA"]);
  });

  it("falls back to the page's ticker when the message names none", () => {
    expect(
      pickTickers({ tickers: [], pageContext: { kind: "stock", ticker: "NVDA", snapshot: "" } })
    ).toEqual(["NVDA"]);
  });

  it("drops symbols that aren't valid tickers", () => {
    expect(pickTickers({ tickers: ["NVDA", "not a ticker", "!!"] })).toEqual(["NVDA"]);
  });

  it("caps the fan-out", () => {
    expect(pickTickers({ tickers: ["A", "AA", "AAA", "AAAA", "AB", "AC"] }).length).toBeLessThanOrEqual(3);
  });

  it("returns nothing for a question with no subject", () => {
    expect(pickTickers({ tickers: [] })).toEqual([]);
  });
});

describe("getQuickContext", () => {
  it("returns live values with a source and an as-of for each", async () => {
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.ticker).toBe("NVDA");
    expect(qc.facts.price.value).toBe("$182.50");
    expect(qc.facts.price.source).toMatch(/Finnhub/);
    expect(qc.facts.price.asOf).toBe("2026-09-15T20:00:00.000Z");
    expect(qc.facts.marketCap.value).toBe("$4.46T");
    expect(qc.facts.peTTM.value).toBe("51.2");
    expect(qc.facts.range52w.value).toBe("$86.60–$195.60");
    expect(qc.facts.dividendYield.value).toBe("0.02%");
    expect(qc.facts.nextEarnings.value).toBe("2026-11-18");
  });

  it("carries the Finava score with the universe's as-of", async () => {
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.finavaScore.value).toMatch(/^\d{1,3} \([A-F][+-]?\)$/);
    expect(qc.facts.finavaScore.asOf).toBe("2026-09-15T19:45:00.000Z");
  });

  it("refuses a score it cannot actually compute", async () => {
    // A universe row missing a factor must read Unavailable, not "NaN (F)".
    deps.getFactorUniverse.mockResolvedValue({
      asOf: "2026-09-15T19:45:00.000Z",
      stocks: [{ ticker: "NVDA", f: { mom: 72 } }],
    });
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.finavaScore.value).toBe(UNAVAILABLE);
  });

  it("returns the 5 latest dated headlines, newest first", async () => {
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.headlines).toHaveLength(5);
    expect(qc.headlines[0].headline).toBe("Nvidia lifts data-centre outlook");
    expect(qc.headlines[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("renders a missing value as Unavailable, never a stand-in", async () => {
    deps.getBasicFinancials.mockResolvedValue({ metric: {} });
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.marketCap.value).toBe(UNAVAILABLE);
    expect(qc.facts.peTTM.value).toBe(UNAVAILABLE);
    expect(qc.facts.marketCap.source).toBe(UNAVAILABLE);
  });

  it("survives a source that throws", async () => {
    deps.getQuote.mockRejectedValue(new Error("Finnhub 429"));
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.price.value).toBe(UNAVAILABLE);
    expect(qc.facts.peTTM.value).toBe("51.2"); // the others still land
    expect(qc.dropped).toContain("quote");
  });

  it("drops whatever misses the budget and names it", async () => {
    deps.getFactorUniverse.mockReturnValue(hangs());
    const started = Date.now();
    const qc = await getQuickContext({ tickers: ["NVDA"], budgetMs: 120 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(qc.facts.finavaScore.value).toBe(UNAVAILABLE);
    expect(qc.dropped).toContain("score");
    expect(qc.facts.price.value).toBe("$182.50"); // fast sources still made it
  });

  it("returns within the budget even when every source hangs", async () => {
    deps.getQuote.mockReturnValue(hangs());
    deps.getBasicFinancials.mockReturnValue(hangs());
    deps.getCompanyNews.mockReturnValue(hangs());
    deps.getEarningsCalendar.mockReturnValue(hangs());
    deps.getFactorUniverse.mockReturnValue(hangs());
    const started = Date.now();
    const qc = await getQuickContext({ tickers: ["NVDA"], budgetMs: 120 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(qc.facts.price.value).toBe(UNAVAILABLE);
    expect(qc.headlines).toEqual([]);
  });

  it("fetches the sources in parallel, not one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = <T,>(v: T) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return v;
    };
    deps.getQuote.mockImplementation(slow(QUOTE));
    deps.getBasicFinancials.mockImplementation(slow(FINANCIALS));
    deps.getCompanyNews.mockImplementation(slow(NEWS));
    await getQuickContext({ tickers: ["NVDA"] });
    expect(peak).toBeGreaterThan(1);
  });

  it("skips every fetch when there is no ticker to fetch for", async () => {
    const qc = await getQuickContext({ tickers: [] });
    expect(deps.getQuote).not.toHaveBeenCalled();
    expect(qc.ticker).toBeNull();
    expect(qc.facts.price.value).toBe(UNAVAILABLE);
  });
});

describe("renderQuickContext", () => {
  async function rendered(): Promise<string> {
    return renderQuickContext(await getQuickContext({ tickers: ["NVDA"] }));
  }

  it("labels every row with its source and as-of", async () => {
    const md = await rendered();
    expect(md).toMatch(/NVDA/);
    expect(md).toMatch(/\$182\.50/);
    expect(md).toMatch(/Finnhub/);
    expect(md).toMatch(/2026-09-15/);
  });

  it("says Unavailable rather than omitting a metric", async () => {
    deps.getEarningsCalendar.mockResolvedValue({ earningsCalendar: [] });
    const md = await rendered();
    expect(md).toMatch(new RegExp(`Next earnings.*${UNAVAILABLE}`));
  });

  it("lists what was dropped so the answer can admit the gap", async () => {
    deps.getFactorUniverse.mockReturnValue(hangs());
    const qc = await getQuickContext({ tickers: ["NVDA"], budgetMs: 120 });
    expect(renderQuickContext(qc)).toMatch(/score/);
  });

  it("produces a compact block, not a data dump", async () => {
    const md = await rendered();
    expect(md.length).toBeLessThan(2000);
  });

  it("handles an empty context without throwing", async () => {
    const empty: QuickContext = await getQuickContext({ tickers: [] });
    expect(() => renderQuickContext(empty)).not.toThrow();
  });
});
