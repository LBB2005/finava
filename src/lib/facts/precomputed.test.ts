import { describe, expect, it } from "vitest";
import {
  pctChange,
  positionShocks,
  weightChangePts,
  insiderSummary,
  insiderFacts,
  form4Url,
  edgarFilingsUrl,
} from "./precomputed";

describe("pctChange", () => {
  it("is the percent distance from a reference level", () => {
    expect(pctChange(90, 100)).toBeCloseTo(-10, 10);
    expect(pctChange(125, 100)).toBeCloseTo(25, 10);
  });

  it("is null without two usable numbers", () => {
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(100, Number.NaN)).toBeNull();
  });
});

describe("positionShocks", () => {
  it("states the dollar loss of a position at −10/−20/−30%", () => {
    expect(positionShocks(20_000)).toEqual([
      { shockPct: 10, loss: -2_000, valueAfter: 18_000 },
      { shockPct: 20, loss: -4_000, valueAfter: 16_000 },
      { shockPct: 30, loss: -6_000, valueAfter: 14_000 },
    ]);
  });

  it("has nothing to say about an unpriced position", () => {
    expect(positionShocks(null)).toEqual([]);
  });
});

describe("weightChangePts", () => {
  it("is today's weight minus the weight at cost, in percentage points", () => {
    // Bought at 10% of the book, now 15.3% of it.
    expect(weightChangePts(0.153, 0.1)).toBeCloseTo(5.3, 10);
  });

  it("is null when either weight is missing", () => {
    expect(weightChangePts(null, 0.1)).toBeNull();
    expect(weightChangePts(0.2, null)).toBeNull();
  });
});

// The readout's fact-check: Pfizer's CEO bought ~$1.0M of stock and the answer
// said $10.3M. The value must come from shares × price in code.
const PFE_ROWS = [
  { name: "Bourla Albert", change: 38_000, share: 250_000, transactionPrice: 26.32, transactionDate: "2026-08-04", transactionCode: "P" },
  { name: "Doe Jane", change: -5_000, share: 40_000, transactionPrice: 27.1, transactionDate: "2026-08-20", transactionCode: "S" },
  { name: "Roe Rick", change: 1_200, share: 9_000, transactionPrice: 0, transactionDate: "2026-07-30", transactionCode: "A" },
  { name: "No Date", change: 900, share: 900, transactionPrice: 26, transactionCode: "P" },
];

describe("insiderSummary", () => {
  it("totals open-market buys and sells as shares × price", () => {
    const s = insiderSummary(PFE_ROWS);
    expect(s.buys).toEqual({ count: 1, value: 38_000 * 26.32 });
    expect(s.sells).toEqual({ count: 1, value: 5_000 * 27.1 });
    expect(s.largestBuy).toEqual({ name: "Bourla Albert", shares: 38_000, price: 26.32, value: 38_000 * 26.32, date: "2026-08-04" });
  });

  it("states the window the dated rows cover and counts undated rows it excluded", () => {
    const s = insiderSummary(PFE_ROWS);
    expect(s.window).toEqual({ from: "2026-07-30", to: "2026-08-20" });
    expect(s.undatedExcluded).toBe(1);
  });

  it("has no largest buy and no window when there is nothing to total", () => {
    const s = insiderSummary([]);
    expect(s.largestBuy).toBeNull();
    expect(s.window).toBeNull();
    expect(s.buys).toEqual({ count: 0, value: 0 });
  });
});

describe("insiderFacts", () => {
  const asOf = "2026-09-16T14:00:00.000Z";

  it("carries the Pfizer buy as $1.0M with a Form 4 link", () => {
    const f = insiderFacts("pfe", { data: PFE_ROWS }, asOf);
    expect(f.ticker).toBe("PFE");
    expect(f.largestBuy.value?.value).toBeCloseTo(1_000_160, 0);
    expect(f.largestBuy.url).toBe(form4Url("PFE"));
    expect(f.buyTotal.period).toBe("2026-07-30 to 2026-08-20");
    expect(f.buyCount.value).toBe(1);
  });

  it("is missing, with a reason, when the feed returned nothing", () => {
    const f = insiderFacts("PFE", null, asOf);
    expect(f.buyTotal.value).toBeNull();
    expect(f.buyTotal.note).toMatch(/unavailable/i);
    expect(f.largestBuy.value).toBeNull();
  });

  it("says there was no open-market buy rather than inventing one", () => {
    const f = insiderFacts("PFE", { data: [PFE_ROWS[1]] }, asOf);
    expect(f.largestBuy.value).toBeNull();
    expect(f.largestBuy.note).toMatch(/no open-market purchases/i);
    expect(f.buyTotal.value).toBe(0);
  });
});

describe("source links", () => {
  it("point at SEC EDGAR for the symbol", () => {
    expect(form4Url("PFE")).toBe("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=PFE&type=4&owner=include&count=40");
    expect(edgarFilingsUrl("aapl")).toBe("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=AAPL&type=10-&owner=include&count=40");
  });
});
