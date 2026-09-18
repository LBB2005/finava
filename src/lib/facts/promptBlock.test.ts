import { describe, expect, it } from "vitest";
import { tickerFactsFixture, FIXTURE_ASOF } from "@/test/factsFixture";
import { fact, missing, type PortfolioFacts } from "./types";
import { insiderFacts, form4Url, edgarFilingsUrl } from "./precomputed";
import {
  collectFacts,
  indexFacts,
  renderFactsBlock,
  formatFactValue,
  readerBlock,
  FACT_CITATION_RULE,
} from "./promptBlock";

const byId = (entries: ReturnType<typeof collectFacts>) => indexFacts(entries);

describe("formatFactValue", () => {
  it("writes dollars the way an answer should quote them", () => {
    expect(formatFactValue("usd", 182.5)).toBe("$182.50");
    expect(formatFactValue("usd", 1_000_160)).toBe("$1.0M");
    expect(formatFactValue("usd", 4.46e12)).toBe("$4.46T");
    expect(formatFactValue("usd", 165e9)).toBe("$165.00B");
    expect(formatFactValue("usd", 12_345.6)).toBe("$12,345.60");
    expect(formatFactValue("usd", -4_000)).toBe("-$4,000");
  });

  it("signs percentages and points, and suffixes multiples", () => {
    expect(formatFactValue("chg", -6.7)).toBe("-6.7%");
    expect(formatFactValue("chg", 23.3)).toBe("+23.3%");
    expect(formatFactValue("pct", 40)).toBe("40.0%");
    expect(formatFactValue("pts", 5.3)).toBe("+5.3 pts");
    expect(formatFactValue("ratio", 51.26)).toBe("51.3x");
    expect(formatFactValue("count", 3)).toBe("3");
  });

  it("is Unavailable for a missing value", () => {
    expect(formatFactValue("usd", null)).toBe("Unavailable");
  });
});

describe("collectFacts: a ticker", () => {
  const entries = collectFacts({ tickers: [tickerFactsFixture("NVDA")] });
  const f = byId(entries);

  it("gives every fact a stable ID under its ticker", () => {
    expect(f.get("NVDA.price")?.text).toBe("$182.50");
    expect(f.get("NVDA.pe")?.text).toBe("51.3x");
    expect(f.get("NVDA.pe")?.source).toBe("Computed: price ÷ EPS (TTM)");
    expect(f.get("NVDA.streetTarget")?.value).toBe(225);
  });

  it("precomputes the comparisons the model used to calculate", () => {
    // 182.5 vs a 195.6 high and an 86.6 low.
    expect(f.get("NVDA.pctFrom52wHigh")?.value).toBeCloseTo((182.5 / 195.6 - 1) * 100, 6);
    expect(f.get("NVDA.pctFrom52wLow")?.value).toBeCloseTo((182.5 / 86.6 - 1) * 100, 6);
    expect(f.get("NVDA.upsideToStreetTarget")?.value).toBeCloseTo((225 / 182.5 - 1) * 100, 6);
    expect(f.get("NVDA.upsideToDcf")?.value).toBeCloseTo((215 / 182.5 - 1) * 100, 6);
    expect(f.get("NVDA.pctFrom52wHigh")?.source).toMatch(/^Computed:/);
  });

  // Seen live after the Sep-17 panel: "Net margin 19.5% — Computed (NI ÷ Revenue)",
  // worked out by the model. Margins are the comparison models reach for most.
  it("precomputes net and free-cash-flow margins", () => {
    // Fixture: net income $86B, FCF $72B on $165B revenue.
    expect(f.get("NVDA.netMarginTTM")?.value).toBeCloseTo((86 / 165) * 100, 6);
    expect(f.get("NVDA.netMarginTTM")?.text).toBe("52.1%");
    expect(f.get("NVDA.fcfMarginTTM")?.value).toBeCloseTo((72 / 165) * 100, 6);
    expect(f.get("NVDA.netMarginTTM")?.source).toMatch(/^Computed:/);
  });

  it("says in words which side of fair value and target the price is on", () => {
    // Seen live: "-54.2% upside to DCF" was written up as "54.2% below its DCF fair value".
    expect(f.get("NVDA.priceVsDcf")?.text).toBe("Price is below DCF fair value");
    expect(f.get("NVDA.priceVsStreetTarget")?.text).toBe("Price is below the Street target");
    const rich = byId(collectFacts({ tickers: [tickerFactsFixture("NVDA", { price: fact(300, { source: "Finnhub quote", asOf: FIXTURE_ASOF, unit: "USD" }) })] }));
    expect(rich.get("NVDA.priceVsDcf")?.text).toBe("Price is above DCF fair value");
    expect(rich.get("NVDA.upsideToDcf")?.label).toMatch(/negative means the price is above/i);
  });

  it("links SEC-sourced facts to the filing index", () => {
    expect(f.get("NVDA.revenueTTM")?.url).toBe(edgarFilingsUrl("NVDA"));
    expect(f.get("NVDA.price")?.url).toBeUndefined();
  });

  it("keeps a missing fact as an explicit Unavailable with its reason", () => {
    const t = tickerFactsFixture("NVDA", { streetTarget: missing("Finnhub price target", "No analyst price target for this symbol", FIXTURE_ASOF) });
    const g = byId(collectFacts({ tickers: [t] }));
    expect(g.get("NVDA.streetTarget")?.value).toBeNull();
    expect(g.get("NVDA.streetTarget")?.text).toBe("Unavailable");
    expect(g.get("NVDA.upsideToStreetTarget")?.value).toBeNull();
  });
});

describe("collectFacts: insider and portfolio", () => {
  it("carries the Pfizer buy as $1.0M with its Form 4 link", () => {
    const ins = insiderFacts("PFE", { data: [{ name: "Bourla Albert", change: 38_000, transactionPrice: 26.32, transactionDate: "2026-08-04", transactionCode: "P" }] }, FIXTURE_ASOF);
    const f = byId(collectFacts({ insider: [ins] }));
    const buy = f.get("PFE.insider.largestBuy");
    expect(buy?.text).toBe("$1.0M");
    expect(buy?.label).toContain("Bourla Albert");
    expect(buy?.label).toContain("38,000 shares @ $26.32");
    expect(buy?.url).toBe(form4Url("PFE"));
    expect(f.get("PFE.insider.buyTotal")?.text).toBe("$1.0M");
    expect(f.get("PFE.insider.largestBuyShares")?.text).toBe("38,000");
    expect(f.get("PFE.insider.largestBuyPrice")?.text).toBe("$26.32");
  });

  const portfolio: PortfolioFacts = {
    holdings: [
      {
        ticker: "GOOGL", shares: 100,
        price: fact(200, { source: "Finnhub quote", asOf: FIXTURE_ASOF, unit: "USD" }),
        marketValue: fact(20_000, { source: "Computed: price × shares", asOf: FIXTURE_ASOF, unit: "USD" }),
        weight: fact(0.4, { source: "Computed: market value ÷ total value (holdings + cash)", asOf: FIXTURE_ASOF, unit: "fraction" }),
        costBasis: fact(150, { source: "Your holdings", asOf: FIXTURE_ASOF, unit: "USD" }),
        score: missing("Finava Score v2 (15 factors)", "Not scored yet", FIXTURE_ASOF),
      },
      {
        ticker: "XYZ", shares: 10,
        price: missing("Finnhub quote", "No live price", FIXTURE_ASOF),
        marketValue: missing("Computed: price × shares", "No live price; excluded from totals", FIXTURE_ASOF),
        weight: missing("Computed", "No live price; excluded from totals", FIXTURE_ASOF),
        costBasis: fact(5, { source: "Your holdings", asOf: FIXTURE_ASOF, unit: "USD" }),
        score: missing("Finava Score v2 (15 factors)", "Not scored yet", FIXTURE_ASOF),
      },
    ],
    totalValue: fact(50_000, { source: "Computed: priced holdings + cash", asOf: FIXTURE_ASOF, unit: "USD" }),
    cash: fact(30_000, { source: "Your portfolio settings", asOf: FIXTURE_ASOF, unit: "USD" }),
    weightsSum: 1,
  };
  const f = byId(collectFacts({ portfolio }));

  it("states weights as percents and position downside in dollars", () => {
    expect(f.get("PORT.GOOGL.weight")?.text).toBe("40.0%");
    expect(f.get("PORT.GOOGL.down10")?.text).toBe("-$2,000");
    expect(f.get("PORT.GOOGL.down20")?.value).toBe(-4_000);
    expect(f.get("PORT.GOOGL.down30")?.text).toBe("-$6,000");
    expect(f.get("PORT.total")?.text).toBe("$50,000");
  });

  it("precomputes unrealized P&L and weight change since purchase", () => {
    expect(f.get("PORT.GOOGL.pnl")?.value).toBe(5_000);
    expect(f.get("PORT.GOOGL.pnlPct")?.value).toBeCloseTo(33.333, 2);
    // At cost: 15,000 of (15,000 + 50 + 30,000 cash) = 33.30%; now 40%.
    expect(f.get("PORT.GOOGL.weightChange")?.value).toBeCloseTo(40 - (15_000 / 45_050) * 100, 6);
  });

  it("leaves an unpriced holding Unavailable instead of guessing", () => {
    expect(f.get("PORT.XYZ.value")?.text).toBe("Unavailable");
    expect(f.has("PORT.XYZ.down10")).toBe(false);
    expect(f.get("PORT.XYZ.weightChange")?.value).toBeNull();
  });
});

describe("renderFactsBlock", () => {
  it("renders one line per fact with its ID, value, source and as-of", () => {
    const block = renderFactsBlock(collectFacts({ tickers: [tickerFactsFixture("NVDA")] }));
    expect(block).toContain("[F:NVDA.price] NVDA price = $182.50 · Finnhub quote · as of 2026-09-15");
    expect(block).toMatch(/\[F:NVDA\.pctFrom52wHigh\] NVDA % from 52-week high = -6\.7% · Computed:/);
  });

  it("says why a value is Unavailable", () => {
    const t = tickerFactsFixture("NVDA", { streetTarget: missing("Finnhub price target", "No analyst price target for this symbol", FIXTURE_ASOF) });
    expect(renderFactsBlock(collectFacts({ tickers: [t] }))).toContain(
      "[F:NVDA.streetTarget] NVDA Street price target = Unavailable (No analyst price target for this symbol)"
    );
  });

  it("says plainly when there are no facts", () => {
    expect(renderFactsBlock([])).toMatch(/no facts/i);
  });
});

describe("prompt rules", () => {
  it("forbids arithmetic and requires a citation for every number", () => {
    expect(FACT_CITATION_RULE).toMatch(/\[F:/);
    expect(FACT_CITATION_RULE).toMatch(/ratio/i);
    expect(FACT_CITATION_RULE).toMatch(/Unavailable/);
    expect(FACT_CITATION_RULE).toMatch(/never (calculate|compute)/i);
  });

  it("tells a beginner answer to define terms, skip indicators and stay short", () => {
    const b = readerBlock("beginner");
    expect(b).toMatch(/define/i);
    expect(b).toMatch(/RSI|MACD|technical/i);
    expect(b).toMatch(/3.5 sentences/);
    expect(readerBlock("professional")).not.toMatch(/3.5 sentences/);
  });
});
