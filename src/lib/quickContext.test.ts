import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tickerFactsFixture } from "@/test/factsFixture";
import { missing } from "@/lib/facts/types";

const deps = vi.hoisted(() => ({ getTickerFacts: vi.fn(), getCompanyNews: vi.fn() }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));
vi.mock("@/lib/finnhub", () => ({ getCompanyNews: deps.getCompanyNews }));

import { UNAVAILABLE, getQuickContext, pickTickers, renderQuickContext, type QuickContext } from "./quickContext";

/** A promise that never settles inside the budget. */
function hangs<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

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
  deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA"));
  deps.getCompanyNews.mockResolvedValue(NEWS);
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
    expect(qc.facts.price).toEqual({ value: "$182.50", source: "Finnhub quote", asOf: "2026-09-15T20:00:00.000Z" });
    expect(qc.facts.change.value).toBe("+1.79%");
    expect(qc.facts.marketCap.value).toBe("$4.46T");
    expect(qc.facts.peTTM.value).toBe("51.3");
    expect(qc.facts.epsTTM.value).toBe("$3.56");
    expect(qc.facts.range52w.value).toBe("$86.60–$195.60");
    expect(qc.facts.dividendYield.value).toBe("0.02%");
    expect(qc.facts.nextEarnings.value).toBe("2026-11-18 (estimated)");
  });

  it("reads the facts layer cache-only under the turn's budget", async () => {
    await getQuickContext({ tickers: ["NVDA"], budgetMs: 900 });
    expect(deps.getTickerFacts).toHaveBeenCalledWith("NVDA", { cachedOnly: true, deadlineMs: 900 });
  });

  it("carries the canonical Finava score with its as-of", async () => {
    const f = tickerFactsFixture("NVDA");
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.finavaScore).toEqual({
      value: `${f.score.value!.total} (${f.score.value!.grade})`,
      source: "Finava Score v2 (15 factors)",
      asOf: f.score.asOf,
    });
  });

  it("shows a score nobody has computed yet as Unavailable, not as dropped", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { score: missing("Finava Score v2 (15 factors)", "Not scored yet") }));
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.finavaScore.value).toBe(UNAVAILABLE);
    expect(qc.dropped).not.toContain("score");
  });

  it("keeps the raw facts for the citation block, and each article's link", async () => {
    deps.getCompanyNews.mockResolvedValue([{ ...NEWS[0], url: "https://www.reuters.com/a" }, NEWS[1]]);
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.factsInput?.tickers?.[0].ticker).toBe("NVDA");
    expect(qc.headlines[0].url).toBe("https://www.reuters.com/a");
    // A non-URL is not a link.
    expect(qc.headlines[1].url).toBeUndefined();
  });

  it("returns the 5 latest dated headlines, newest first", async () => {
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.headlines).toHaveLength(5);
    expect(qc.headlines[0].headline).toBe("Nvidia lifts data-centre outlook");
    expect(qc.headlines[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("renders a missing value as Unavailable, never a stand-in", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { marketCap: missing("x", "Needs a price and a share count"), pe: missing("x", "Loss-making") }));
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.marketCap).toEqual({ value: UNAVAILABLE, source: UNAVAILABLE, asOf: UNAVAILABLE });
    expect(qc.facts.peTTM.value).toBe(UNAVAILABLE);
  });

  it("names the sources facts dropped, in the words the prompt already uses", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { price: missing("Finnhub quote", "Not retrieved in time"), dropped: ["quote", "metric", "earnings"] }));
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.price.value).toBe(UNAVAILABLE);
    expect(qc.dropped).toEqual(expect.arrayContaining(["quote", "key stats", "earnings date"]));
  });

  it("returns within the budget even when every source hangs", async () => {
    deps.getTickerFacts.mockReturnValue(hangs());
    deps.getCompanyNews.mockReturnValue(hangs());
    const started = Date.now();
    const qc = await getQuickContext({ tickers: ["NVDA"], budgetMs: 120 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(qc.facts.price.value).toBe(UNAVAILABLE);
    expect(qc.headlines).toEqual([]);
    expect(qc.dropped).toEqual(expect.arrayContaining(["market data", "news"]));
  });

  it("fetches facts and news in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = <T,>(v: T) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return v;
    };
    deps.getTickerFacts.mockImplementation(slow(tickerFactsFixture("NVDA")));
    deps.getCompanyNews.mockImplementation(slow(NEWS));
    await getQuickContext({ tickers: ["NVDA"] });
    expect(peak).toBe(2);
  });

  it("skips every fetch when there is no ticker to fetch for", async () => {
    const qc = await getQuickContext({ tickers: [] });
    expect(deps.getTickerFacts).not.toHaveBeenCalled();
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
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { nextEarnings: missing("Finnhub earnings calendar", "No earnings date in the next 120 days") }));
    const md = await rendered();
    expect(md).toMatch(new RegExp(`Next earnings.*${UNAVAILABLE}`));
  });

  it("lists what was dropped so the answer can admit the gap", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { dropped: ["edgar"] }));
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(renderQuickContext(qc)).toMatch(/filings/);
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
