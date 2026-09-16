import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aaplFacts from "@/test/fixtures/edgar-companyfacts-aapl.json";
import proxyFacts from "@/test/fixtures/edgar-companyfacts-proxy-fcf.json";
import {
  extractBalanceSnapshot,
  extractFinancialMetrics,
  extractFundamentalTimeSeries,
  extractQuarterlyFundamentals,
  getCikByTicker,
  getCompanyFacts,
  getLatest10KText,
  getRecentFilings,
  searchRecentForm4,
  extractCurrentSharesOutstanding,
  ttmFromQuarters,
} from "./edgar";

/** A quarterly duration fact, as companyfacts files it (dates, not frames). */
function quarter(year: number, q: 1 | 2 | 3 | 4, val: number) {
  const starts = ["01-01", "04-01", "07-01", "10-01"];
  const ends = ["03-31", "06-30", "09-30", "12-31"];
  return { form: "10-Q", filed: `${year}-12-31`, start: `${year}-${starts[q - 1]}`, end: `${year}-${ends[q - 1]}`, val };
}
function fiscalYear(year: number, val: number) {
  return { form: "10-K", filed: `${year + 1}-02-01`, start: `${year}-01-01`, end: `${year}-12-31`, val };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const duration = (entries: any[]) => ({ units: { USD: entries } });
/** An instant (balance-sheet) fact. */
function instant(entries: Array<[string, number]>) {
  return {
    units: {
      USD: entries.map(([end, val]) => ({ form: "10-Q", filed: end, end, val })),
    },
  };
}

const QUARTERLY_FACTS = {
  facts: {
    "us-gaap": {
      // 2024 Q1-Q3 + the fiscal year (Q4 derived: 450 − 330 = 120), split across
      // the two revenue tags to exercise merging (freshest tag leads, the other
      // back-fills). 2025 arrives as year-to-date columns, the way a cash-flow
      // statement is filed, so it has to be de-cumulated.
      Revenues: duration([quarter(2024, 1, 100), quarter(2024, 2, 110)]),
      RevenueFromContractWithCustomerExcludingAssessedTax: duration([
        quarter(2024, 3, 120),
        fiscalYear(2024, 450),
        { form: "10-Q", filed: "2025-04-30", start: "2025-01-01", end: "2025-03-31", val: 130 },
        { form: "10-Q", filed: "2025-07-31", start: "2025-01-01", end: "2025-06-30", val: 270 }, // H1 YTD
        { form: "10-Q", filed: "2025-10-31", start: "2025-01-01", end: "2025-09-30", val: 420 }, // 9M YTD
        fiscalYear(2025, 580),
        quarter(2026, 1, 170),
      ]),
      GrossProfit: duration([quarter(2025, 3, 60)]),
      CostOfRevenue: duration([quarter(2026, 1, 68)]),
      NetIncomeLoss: duration([quarter(2025, 2, 25), quarter(2025, 3, 25), quarter(2025, 4, 25), quarter(2026, 1, 25)]),
      OperatingIncomeLoss: duration([quarter(2025, 2, 30), quarter(2025, 3, 30), quarter(2025, 4, 30), quarter(2026, 1, 30)]),
      NetCashProvidedByUsedInOperatingActivities: duration([
        quarter(2025, 2, 40), quarter(2025, 3, 40), quarter(2025, 4, 40), quarter(2026, 1, 40),
      ]),
      PaymentsForRepurchaseOfCommonStock: duration([
        quarter(2025, 2, 10), quarter(2025, 3, 10), quarter(2025, 4, 10), quarter(2026, 1, 10),
      ]),
      CashCashEquivalentsAndShortTermInvestments: instant([["2025-12-27", 480], ["2026-03-28", 500]]),
      LongTermDebt: instant([["2026-03-28", 100]]),
      Assets: instant([["2026-03-28", 2000]]),
      StockholdersEquity: instant([["2026-03-28", 800]]),
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: { shares: [{ form: "10-Q", filed: "2026-03-28", val: 100, end: "2026-03-28" }] },
      },
    },
  },
};

describe("EDGAR quarterly extraction", () => {
  it("extracts discrete quarters, derives Q4 from the fiscal year, and merges tags", () => {
    const q = extractQuarterlyFundamentals(QUARTERLY_FACTS, 12);
    expect(q.revenue.map((m) => [m.year, m.quarter, m.value])).toEqual([
      [2024, 1, 100],
      [2024, 2, 110],
      [2024, 3, 120],
      [2024, 4, 120], // 450 − (100+110+120): no Q4 is ever filed on its own
      [2025, 1, 130],
      [2025, 2, 140], // 270 YTD − 130
      [2025, 3, 150], // 420 YTD − 270
      [2025, 4, 160], // 580 FY − 420 YTD
      [2026, 1, 170],
    ]);
    expect(q.grossProfit.map((m) => m.value)).toEqual([60]);
    expect(q.costOfRevenue.map((m) => m.value)).toEqual([68]);
    expect(q.capex).toEqual([]); // absent concept → empty, never invented
  });

  it("keeps the period each quarter covers, so callers can check contiguity", () => {
    const q = extractQuarterlyFundamentals(QUARTERLY_FACTS, 12);
    expect(q.revenue.at(-1)).toMatchObject({ start: "2026-01-01", end: "2026-03-31" });
    // The four most recent quarters, Apr 2025 → Mar 2026: 140+150+160+170.
    expect(ttmFromQuarters(q.revenue)?.value).toBe(620);
  });

  it("trims to the requested number of quarters", () => {
    const q = extractQuarterlyFundamentals(QUARTERLY_FACTS, 4);
    expect(q.revenue).toHaveLength(4);
    expect(q.revenue[0]).toMatchObject({ year: 2025, quarter: 2, value: 140 });
  });

  it("takes the freshest instant snapshot for the balance sheet (dei shares fallback)", () => {
    expect(extractBalanceSnapshot(QUARTERLY_FACTS)).toEqual({
      cash: 500, // 2026-03-28 beats 2025-12-27
      cashAndShortTermInvestments: 500, // the combined tag already includes them
      totalDebt: 100,
      totalAssets: 2000,
      equity: 800,
      sharesOutstanding: 100,
      asOf: "2026-03-28",
    });
  });

  it("returns empty series and a null snapshot for factless issuers", () => {
    const q = extractQuarterlyFundamentals({ facts: {} }, 8);
    expect(q.revenue).toEqual([]);
    expect(extractBalanceSnapshot({ facts: {} })).toEqual({
      cash: null,
      cashAndShortTermInvestments: null,
      totalDebt: null,
      totalAssets: null,
      equity: null,
      sharesOutstanding: null,
      asOf: null,
    });
    expect(extractCurrentSharesOutstanding({ facts: {} })).toBeNull();
  });
});

describe("EDGAR facts extraction", () => {
  it("extracts the latest annual financial metrics with share units", () => {
    expect(extractFinancialMetrics(aaplFacts)).toEqual({
      // FY2024, the year that ended last. The Revenues tag stops at FY2022 here,
      // and taking the first tag that had a value used to serve that stale figure.
      revenue: 391035000000,
      cashAndShortTermInvestments: 29943000000, // no separate securities tag → equals cash
      netIncome: 93736000000,
      totalAssets: 364980000000,
      totalDebt: 85750000000,
      cash: 29943000000,
      operatingCashFlow: 118254000000,
      capex: 9447000000,
      sharesOutstanding: 15116786000,
    });
  });

  it("tolerates missing optional facts so the DCF route can use proxy FCF", () => {
    expect(extractFinancialMetrics(proxyFacts)).toMatchObject({
      revenue: 1000000000,
      operatingCashFlow: 125000000,
      capex: null,
      sharesOutstanding: null,
    });
  });

  it("stitches revenue tags by freshest concept and trims to the requested years", () => {
    const series = extractFundamentalTimeSeries(aaplFacts, 3);

    expect(series.revenue).toEqual([
      { year: 2022, value: 394328000000 },
      { year: 2023, value: 383285000000 },
      { year: 2024, value: 391035000000 },
    ]);
    expect(series.operatingCashFlow).toEqual([
      { year: 2023, value: 110543000000 },
      { year: 2024, value: 118254000000 },
    ]);
  });
});

describe("EDGAR fetch wrappers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("company_tickers.json")) {
          return Response.json({
            "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
          });
        }
        if (url.includes("companyfacts")) {
          return Response.json(aaplFacts);
        }
        if (url.includes("search-index")) {
          return Response.json({
            hits: {
              hits: [
                {
                  _id: "0000320193-25-000001:primary_doc.xml",
                  _source: {
                    display_names: [
                      "Jane Insider (CIK 0001111111)",
                      "Apple Inc. (CIK 0000320193)",
                    ],
                    ciks: ["0001111111", "0000320193"],
                    file_date: "2025-01-03",
                    period_ending: "2025-01-02",
                    adsh: "0000320193-25-000001",
                  },
                },
              ],
            },
          });
        }
        return new Response("not found", { status: 404 });
      })
    );
  });

  it("loads and caches SEC ticker CIK mappings", async () => {
    await expect(getCikByTicker("aapl")).resolves.toBe("0000320193");
    await expect(getCikByTicker("AAPL")).resolves.toBe("0000320193");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://www.sec.gov/files/company_tickers.json",
      expect.objectContaining({
        headers: { "User-Agent": expect.stringContaining("Finava App") },
      })
    );
  });

  it("fetches company facts with a padded CIK", async () => {
    await expect(getCompanyFacts("320193")).resolves.toEqual(aaplFacts);

    expect(fetch).toHaveBeenCalledWith(
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
      expect.objectContaining({
        headers: { "User-Agent": expect.stringContaining("Finava App") },
      })
    );
  });

  it("maps recent Form 4 hits to insider filing summaries", async () => {
    await expect(searchRecentForm4("AAPL", 1, 1)).resolves.toEqual([
      {
        entityName: "Jane Insider",
        filedAt: "2025-01-03",
        periodOfReport: "2025-01-02",
        accessionNo: "0000320193-25-000001",
        cik: "0001111111",
      },
    ]);
  });
});

describe("EDGAR failure modes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws (never silently returns []) when the Form 4 search errors", async () => {
    // The distinction matters: the insider agent treats a thrown error as
    // "lookup UNAVAILABLE" and an empty array as "no activity". They must not blur.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    await expect(searchRecentForm4("AAPL")).rejects.toThrow(/EDGAR FTS 429/);
  });

  it("returns an empty map (not a throw) when the CIK ticker file is unreachable", async () => {
    // Fresh module so CIK_CACHE starts null and the failing fetch is actually hit.
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const fresh = await import("./edgar");
    // Unknown ticker resolves to null rather than crashing the caller.
    await expect(fresh.getCikByTicker("AAPL")).resolves.toBeNull();
  });

  it("fetches submissions with a zero-padded CIK", async () => {
    const submissions = { filings: { recent: { form: [], accessionNumber: [], primaryDocument: [] } } };
    const spy = vi.fn(async () => Response.json(submissions));
    vi.stubGlobal("fetch", spy);
    await expect(getRecentFilings("320193")).resolves.toEqual(submissions);
    expect(spy).toHaveBeenCalledWith(
      "https://data.sec.gov/submissions/CIK0000320193.json",
      expect.objectContaining({ headers: { "User-Agent": expect.stringContaining("Finava App") } }),
    );
  });
});

describe("getLatest10KText", () => {
  afterEach(() => vi.restoreAllMocks());

  const submissionsWith10K = {
    filings: {
      recent: {
        form: ["8-K", "10-K", "10-Q"],
        accessionNumber: ["0000320193-24-000001", "0000320193-24-000123", "0000320193-24-000200"],
        primaryDocument: ["ev.htm", "aapl-10k.htm", "q.htm"],
      },
    },
  };

  it("fetches the latest 10-K and returns HTML stripped to readable text", async () => {
    const html =
      "<html><head><style>.x{color:red}</style></head>" +
      "<body><script>steal()</script><p>Item&nbsp;1. Business &amp; competition</p></body></html>";
    const spy = vi.fn(async (url: string) => {
      if (url.includes("submissions")) return Response.json(submissionsWith10K);
      return new Response(html); // the primary-document hop
    });
    vi.stubGlobal("fetch", spy);

    const text = await getLatest10KText("320193");
    expect(text).toContain("Item 1. Business & competition");
    expect(text).not.toContain("steal("); // <script> body dropped
    expect(text).not.toContain("<p>"); // tags stripped
    expect(text).not.toContain("color:red"); // <style> body dropped

    // Archives path uses the un-padded CIK and the dash-stripped accession number.
    expect(spy).toHaveBeenCalledWith(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-10k.htm",
      expect.anything(),
    );
  });

  it("truncates to maxChars", async () => {
    const html = `<body>${"A".repeat(500)}</body>`;
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("submissions") ? Response.json(submissionsWith10K) : new Response(html),
    ));
    const text = await getLatest10KText("320193", 100);
    expect(text).toHaveLength(100);
  });

  it("returns null when the company has no 10-K on file", async () => {
    const noTenK = { filings: { recent: { form: ["8-K", "10-Q"], accessionNumber: ["a", "b"], primaryDocument: ["x", "y"] } } };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(noTenK)));
    await expect(getLatest10KText("320193")).resolves.toBeNull();
  });

  it("returns null when the 10-K document fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("submissions") ? Response.json(submissionsWith10K) : new Response("gone", { status: 404 }),
    ));
    await expect(getLatest10KText("320193")).resolves.toBeNull();
  });

  it("returns null when the submissions lookup itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    await expect(getLatest10KText("320193")).resolves.toBeNull();
  });
});
