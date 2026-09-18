import { beforeEach, describe, expect, it, vi } from "vitest";
import aaplFixture from "@/lib/__fixtures__/sec/aapl.json";
import jpmFixture from "@/lib/__fixtures__/sec/jpm.json";

const deps = vi.hoisted(() => ({
  rateLimitGuard: vi.fn(),
  getCikByTicker: vi.fn(),
  getCompanyFacts: vi.fn(),
  getEarnings: vi.fn(),
}));

// Real extraction functions, mocked network lookups.
vi.mock("@/lib/edgar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edgar")>()),
  getCikByTicker: deps.getCikByTicker,
  getCompanyFacts: deps.getCompanyFacts,
}));
vi.mock("@/lib/finnhub", () => ({ getEarnings: deps.getEarnings }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));

import { GET } from "./route";

function ctx(ticker: string) {
  return { params: Promise.resolve({ ticker }) };
}

/** Quarterly duration facts, as companyfacts files them: real period dates. */
const Q_DATES: Record<string, [string, string]> = {
  "2025Q1": ["2025-01-01", "2025-03-31"],
  "2025Q2": ["2025-04-01", "2025-06-30"],
  "2025Q3": ["2025-07-01", "2025-09-30"],
  "2025Q4": ["2025-10-01", "2025-12-31"],
  "2026Q1": ["2026-01-01", "2026-03-31"],
  "2026Q2": ["2026-04-01", "2026-06-30"],
};
function duration(pairs: Array<[string, number]>) {
  return {
    units: {
      USD: pairs.map(([q, val]) => {
        const [start, end] = Q_DATES[q];
        return { form: "10-Q", filed: end, start, end, val };
      }),
    },
  };
}
function instant(pairs: Array<[number, string]>) {
  return { units: { USD: pairs.map(([val, end]) => ({ form: "10-Q", filed: end, val, end })) } };
}

// 6 revenue quarters 2025Q1..2026Q2; flows for the last 4; fresh balance sheet.
const FACTS = {
  facts: {
    "us-gaap": {
      Revenues: duration([
        ["2025Q1", 100],
        ["2025Q2", 110],
        ["2025Q3", 120],
        ["2025Q4", 130],
        ["2026Q1", 140],
        ["2026Q2", 154],
      ]),
      GrossProfit: duration([["2026Q2", 77]]),
      CostOfRevenue: duration([["2026Q1", 70]]),
      NetIncomeLoss: duration([
        ["2025Q3", 25],
        ["2025Q4", 25],
        ["2026Q1", 25],
        ["2026Q2", 25],
      ]),
      OperatingIncomeLoss: duration([
        ["2025Q3", 30],
        ["2025Q4", 30],
        ["2026Q1", 30],
        ["2026Q2", 30],
      ]),
      NetCashProvidedByUsedInOperatingActivities: duration([
        ["2025Q3", 40],
        ["2025Q4", 40],
        ["2026Q1", 40],
        ["2026Q2", 40],
      ]),
      PaymentsForRepurchaseOfCommonStock: duration([
        ["2025Q3", 10],
        ["2025Q4", 10],
        ["2026Q1", 10],
        ["2026Q2", 10],
      ]),
      CashCashEquivalentsAndShortTermInvestments: instant([[500, "2026-06-30"]]),
      LongTermDebt: instant([[100, "2026-06-30"]]),
      Assets: instant([[2000, "2026-06-30"]]),
      StockholdersEquity: instant([[800, "2026-06-30"]]),
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: { shares: [{ form: "10-Q", filed: "2026-06-30", val: 100, end: "2026-06-30" }] },
      },
    },
  },
};

const EARNINGS = [
  { actual: 1.3, period: "2026-06-30" }, // 2026 Q2
  { actual: 1.2, period: "2026-03-31" }, // 2026 Q1
  { actual: 1.1, period: "2025-12-31" }, // 2025 Q4
  { actual: 1.0, period: "2025-09-30" }, // 2025 Q3
];

beforeEach(() => {
  vi.clearAllMocks();
  deps.rateLimitGuard.mockResolvedValue(null);
  deps.getCikByTicker.mockResolvedValue("0000123456");
  deps.getCompanyFacts.mockResolvedValue(FACTS);
  deps.getEarnings.mockResolvedValue(EARNINGS);
});

describe("GET /api/stock/[ticker]/financials", () => {
  it("404s for tickers without SEC filings or without quarterly revenue", async () => {
    deps.getCikByTicker.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://t"), ctx("SPY"))).status).toBe(404);

    deps.getCompanyFacts.mockResolvedValueOnce({ facts: {} });
    expect((await GET(new Request("http://t"), ctx("NEWCO"))).status).toBe(404);
  });

  it("says SEC is unavailable (503), never that the company has no filings, when the lookup fails", async () => {
    deps.getCikByTicker.mockRejectedValueOnce(new Error("SEC company tickers unavailable (429)"));
    const res = await GET(new Request("http://t"), ctx("T"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/no SEC filings/i);
  });

  it("builds ledger rows with YoY, margin fallback, EPS mapping, and proxy FCF", async () => {
    const res = await GET(new Request("http://t"), ctx("acme"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.ticker).toBe("ACME");
    expect(body.quarters).toHaveLength(6);

    const last = body.quarters.at(-1);
    expect(last).toMatchObject({
      year: 2026,
      quarter: 2,
      revenue: 154,
      epsDiluted: 1.3,
      netIncome: 25,
      fcf: 40, // capex absent → OCF proxy
    });
    expect(last.revenueYoY).toBeCloseTo(0.4, 5); // 154 vs 110
    expect(last.grossMargin).toBeCloseTo(0.5, 5); // GrossProfit 77 / 154

    // Q1 2026 has no GrossProfit tag — falls back to revenue − costOfRevenue.
    const q1 = body.quarters.find(
      (q: { year: number; quarter: number }) => q.year === 2026 && q.quarter === 1
    );
    expect(q1.grossMargin).toBeCloseTo(0.5, 5); // (140 − 70) / 140
    expect(body.fcfIsProxy).toBe(true);
  });

  it("sums TTM flows, maps the balance snapshot, and derives netCash + BVPS", async () => {
    const body = await (await GET(new Request("http://t"), ctx("ACME"))).json();

    expect(body.ttm.income).toMatchObject({
      revenue: 100 + 110 + 120 + 130 + 140 + 154 - 100 - 110, // last 4: 120+130+140+154
      netIncome: 100,
      operatingIncome: 120,
      epsDiluted: 4.6,
    });
    expect(body.ttm.income.grossProfit).toBeNull(); // only one GP quarter — no TTM
    expect(body.ttm.balance).toMatchObject({
      cash: 500,
      totalDebt: 100,
      netCash: 400,
      totalAssets: 2000,
      bookValuePerShare: 8,
    });
    expect(body.ttm.cashflow).toMatchObject({
      operatingCF: 160,
      capex: null,
      fcf: 160,
      buybacks: 40,
    });
    expect(body.ttm.cashflow.fcfMargin).toBeCloseTo(160 / 544, 5);
  });

  it("survives a Finnhub earnings failure (EPS columns null)", async () => {
    deps.getEarnings.mockRejectedValueOnce(new Error("finnhub down"));
    const body = await (await GET(new Request("http://t"), ctx("ACME"))).json();
    expect(body.quarters.at(-1).epsDiluted).toBeNull();
    expect(body.ttm.income.epsDiluted).toBeNull();
  });
});

describe("GET financials — real filings (trimmed SEC companyfacts)", () => {
  beforeEach(() => {
    deps.rateLimitGuard.mockResolvedValue(null);
    deps.getCikByTicker.mockResolvedValue("0000320193");
    deps.getEarnings.mockResolvedValue([]);
  });

  it("fills the TTM statements for an off-calendar filer (AAPL, FY ends late Sep)", async () => {
    deps.getCompanyFacts.mockResolvedValue(aaplFixture);
    const body = await (await GET(new Request("http://localhost/api/stock/AAPL/financials"), ctx("AAPL"))).json();

    // Used to be null: the fiscal Q4 was missing, so no 4 consecutive quarters.
    expect(body.ttm.income.revenue).toBe(466_823_000_000);
    expect(body.ttm.income.netIncome).toBe(128_930_000_000);
    expect(body.ttm.cashflow.operatingCF).toBe(146_724_000_000);
    expect(body.ttmPeriod).toEqual({ from: "2025-06-29", to: "2026-06-27" });
    // Rows carry the fiscal period they cover, not a calendar-quarter guess.
    expect(body.quarters.at(-1)).toMatchObject({ periodStart: "2026-03-29", periodEnd: "2026-06-27" });
    expect(body.ttm.balance.cash).toBe(39_544_000_000);
    expect(body.ttm.balance.cashAndShortTermInvestments).toBe(62_399_000_000);
  });

  it("reports JPM's current revenue and marks concepts it stopped tagging Unavailable", async () => {
    deps.getCikByTicker.mockResolvedValue("0000019617");
    deps.getCompanyFacts.mockResolvedValue(jpmFixture);
    const body = await (await GET(new Request("http://localhost/api/stock/JPM/financials"), ctx("JPM"))).json();

    expect(body.quarters.at(-1)).toMatchObject({ periodEnd: "2026-06-30", revenue: 57_347_000_000 });
    expect(body.ttm.income.revenue).toBe(199_408_000_000);
    // JPM last tagged these in 2014/2018 — null renders "—" instead of a stale figure.
    expect(body.ttm.balance.cash).toBeNull();
    expect(body.ttm.balance.totalDebt).toBeNull();
    expect(body.ttm.balance.netCash).toBeNull();
    expect(body.ttm.balance.totalAssets).toBe(5_015_069_000_000);
  });

  it("refuses to sum a TTM EPS across a gap in the quarters", async () => {
    deps.getCompanyFacts.mockResolvedValue(aaplFixture);
    deps.getEarnings.mockResolvedValue([
      { actual: 1.0, period: "2025-06-28" },
      // 2025-09-27 missing → the last four actuals are not four consecutive quarters
      { actual: 1.1, period: "2025-12-27" },
      { actual: 1.2, period: "2026-03-28" },
      { actual: 1.3, period: "2026-06-27" },
    ]);
    const body = await (await GET(new Request("http://localhost/api/stock/AAPL/financials"), ctx("AAPL"))).json();
    expect(body.ttm.income.epsDiluted).toBeNull();
  });
});
