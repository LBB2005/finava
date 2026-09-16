/**
 * Real-filing regression tests for the EDGAR extraction.
 *
 * Fixtures are trimmed SEC companyfacts (see src/lib/__fixtures__/sec/README.md):
 * the tags under test, entries from 2022 on, plus the tail of any tag that went
 * stale so we can prove we no longer pick it.
 *
 * Every expected number below is either a figure as filed, or filed figures
 * differenced (fiscal Q4 = FY − 9M YTD, which is how a 10-K reports it).
 */
import { describe, expect, it } from "vitest";
import aapl from "./__fixtures__/sec/aapl.json";
import msft from "./__fixtures__/sec/msft.json";
import cost from "./__fixtures__/sec/cost.json";
import jpm from "./__fixtures__/sec/jpm.json";
import bkng from "./__fixtures__/sec/bkng.json";
import {
  extractQuarterlyFundamentals,
  extractBalanceSnapshot,
  extractCurrentSharesOutstanding,
  ttmFromQuarters,
} from "./edgar";

const latest = <T,>(a: T[]) => a[a.length - 1];

describe("off-calendar fiscal years keep every quarter (AAPL, FY ends late Sep)", () => {
  const q = extractQuarterlyFundamentals(aapl, 12);

  it("reports the quarter the last 10-Q filed, not a calendar-frame gap", () => {
    // 10-Q for the quarter ended 27 Jun 2026: net sales $109,417M.
    expect(latest(q.revenue)).toMatchObject({ end: "2026-06-27", value: 109_417_000_000 });
  });

  it("derives fiscal Q4 (Jul–Sep), which no 10-Q ever reports", () => {
    // FY2025 (ended 27 Sep 2025) − nine months ended 28 Jun 2025, both as filed.
    const q4 = q.revenue.find((m) => m.end === "2025-09-27");
    expect(q4?.value).toBe(102_466_000_000);
  });

  it("has four consecutive quarters per fiscal year, so TTM is not blank", () => {
    expect(q.revenue.length).toBeGreaterThanOrEqual(8);
    expect(ttmFromQuarters(q.revenue)?.value).toBe(466_823_000_000);
    expect(ttmFromQuarters(q.netIncome)?.value).toBe(128_930_000_000);
    // Cash flow is filed year-to-date; it has to be de-cumulated per quarter.
    expect(ttmFromQuarters(q.operatingCashFlow)?.value).toBe(146_724_000_000);
  });
});

describe("off-calendar fiscal years keep every quarter (MSFT FY ends Jun, COST Aug/Sep 52-53wk)", () => {
  it("MSFT TTM at fiscal year end equals the revenue on the FY2026 10-K", () => {
    const q = extractQuarterlyFundamentals(msft, 12);
    expect(latest(q.revenue)).toMatchObject({ end: "2026-06-30", value: 90_007_000_000 });
    // Cross-check: the four quarters sum to the filed FY2026 total, $331,839M.
    expect(ttmFromQuarters(q.revenue)?.value).toBe(331_839_000_000);
  });

  it("COST keeps its 16-week fiscal Q4 and the 12-week quarters around it", () => {
    const q = extractQuarterlyFundamentals(cost, 12);
    expect(latest(q.revenue)).toMatchObject({ end: "2026-05-10", value: 70_527_000_000 });
    expect(q.revenue.find((m) => m.end === "2025-08-31")?.value).toBe(86_156_000_000);
    expect(ttmFromQuarters(q.revenue)?.value).toBe(293_587_000_000);
  });
});

describe("issuer-specific tags (JPM, BKNG)", () => {
  it("JPM reads current revenue, not the Revenues tag it stopped using in 2014", () => {
    const q = extractQuarterlyFundamentals(jpm, 12);
    // Total net revenue, quarter ended 30 Jun 2026: $57,347M (RevenuesNetOfInterestExpense).
    expect(latest(q.revenue)).toMatchObject({ end: "2026-06-30", value: 57_347_000_000 });
    // The abandoned tag's 2012-2014 quarters are gone; what's left is contiguous.
    expect(q.revenue.every((m) => m.end >= "2022-01-01")).toBe(true);
    expect(ttmFromQuarters(q.revenue)?.value).toBe(199_408_000_000);
  });

  it("BKNG reads current net income, not the 2010-2012 NetIncomeLoss tail", () => {
    const q = extractQuarterlyFundamentals(bkng, 12);
    expect(latest(q.netIncome)).toMatchObject({ end: "2026-06-30", value: 1_950_000_000 });
    expect(ttmFromQuarters(q.netIncome)?.value).toBe(7_209_000_000);
  });

  it("ignores figures from proxy statements and other non-10-K/Q forms", () => {
    // BKNG's recent NetIncomeLoss entries are DEF 14A full-year figures. A full
    // year must never be read as a quarter: Q4 2025 is $1.428B, not the $5.40B year.
    const q = extractQuarterlyFundamentals(bkng, 12);
    expect(q.netIncome.find((m) => m.end === "2025-12-31")?.value).toBe(1_428_000_000);
    expect(q.netIncome.every((m) => m.end >= "2023-01-01")).toBe(true);
  });
});

describe("balance snapshot", () => {
  it("separates cash from cash + short-term investments (AAPL)", () => {
    const b = extractBalanceSnapshot(aapl);
    // 10-Q, 27 Jun 2026: cash $39,544M + current marketable securities $22,855M.
    expect(b.cash).toBe(39_544_000_000);
    expect(b.cashAndShortTermInvestments).toBe(62_399_000_000);
    expect(b.asOf).toBe("2026-06-27");
  });

  it("returns Unavailable rather than a stale figure (JPM stopped tagging these)", () => {
    const b = extractBalanceSnapshot(jpm);
    expect(b.totalAssets).toBe(5_015_069_000_000); // current, 30 Jun 2026
    expect(b.cash).toBeNull(); // last tagged 2018 — not "current cash"
    expect(b.totalDebt).toBeNull(); // last tagged 2014
  });
});

describe("current shares outstanding (split-safe)", () => {
  it("dates the snapshot by the balance sheet, not the later cover page (BKNG)", () => {
    // Balance sheet is as of 30 Jun 2026; the cover page count is dated 27 Jul.
    expect(extractBalanceSnapshot(bkng).asOf).toBe("2026-06-30");
    expect(extractBalanceSnapshot(bkng).sharesOutstanding).toBe(751_380_500);
  });

  it("takes the cover-page count, which is post-split (BKNG)", () => {
    // BKNG's FY2025 10-K weighted average is 32,639,000 pre-split shares; the
    // cover page of the 10-Q filed 2026-07-27 reports 751,380,500 post-split.
    expect(extractCurrentSharesOutstanding(bkng)).toEqual({
      shares: 751_380_500,
      asOf: "2026-07-27",
    });
  });

  it("is the freshest cover-page count for AAPL too", () => {
    expect(extractCurrentSharesOutstanding(aapl)?.shares).toBe(14_594_180_000);
  });
});

describe("annual-only concepts", () => {
  it("never invents quarters from a concept only ever tagged annually", () => {
    // CurrentFederalTaxExpenseBenefit is 10-K-only for AAPL — the same shape a
    // 10-K-only filer has for every concept.
    const us = (aapl as { facts: Record<string, Record<string, unknown>> }).facts["us-gaap"];
    expect(us.CurrentFederalTaxExpenseBenefit).toBeDefined();
    const q = extractQuarterlyFundamentals({ facts: { "us-gaap": { Revenues: us.CurrentFederalTaxExpenseBenefit } } }, 12);
    expect(q.revenue).toEqual([]);
  });
});
