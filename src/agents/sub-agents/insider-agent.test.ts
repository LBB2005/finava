import { describe, it, expect, vi, beforeEach } from "vitest";

const generate = vi.fn(async (_o?: unknown) => "INSIDER ANALYSIS");
vi.mock("@/lib/llm", () => ({ generate: (o: unknown) => generate(o) }));
vi.mock("@/agents/skills", () => ({ getSkillsPrompt: () => "skill prompt" }));

const getInsiderTransactions = vi.fn();
vi.mock("@/lib/finnhub", () => ({ getInsiderTransactions: (...a: unknown[]) => getInsiderTransactions(...a) }));

const searchRecentForm4 = vi.fn();
vi.mock("@/lib/edgar", () => ({ searchRecentForm4: (...a: unknown[]) => searchRecentForm4(...a) }));

const lastPrompt = () => (generate.mock.calls.at(-1)![0] as { prompt: string }).prompt;

beforeEach(() => {
  generate.mockClear().mockResolvedValue("INSIDER ANALYSIS");
  searchRecentForm4.mockReset().mockResolvedValue([]); // no Form 4 filings → no fetch needed
  getInsiderTransactions.mockReset().mockResolvedValue({ data: [] });
});

describe("runInsiderAgent", () => {
  it("reports no qualifying purchases and folds in Finnhub history", async () => {
    getInsiderTransactions.mockResolvedValue({
      data: [
        { name: "Jane CEO", change: 1000, transactionPrice: 50, transactionCode: "P", transactionDate: "2026-05-01", share: 1000 },
        { name: "Bob CFO", change: -500, transactionPrice: 60, transactionCode: "S", transactionDate: "2026-05-02", share: 500 },
      ],
    });
    const { runInsiderAgent } = await import("./insider-agent");
    const out = await runInsiderAgent({ tickers: ["AAPL"] });
    expect(out).toBe("INSIDER ANALYSIS");
    const p = lastPrompt();
    expect(p).toContain("No qualifying insider purchases");
    expect(p).toContain("FINNHUB");
    expect(p).toContain("AAPL");
  });

  it("flags EDGAR as UNAVAILABLE (not empty) when every lookup fails", async () => {
    searchRecentForm4.mockRejectedValue(new Error("SEC unreachable"));
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL", "MSFT"] });
    const p = lastPrompt();
    expect(p).toContain("UNAVAILABLE");
    expect(p).toContain("do not treat this as an absence of purchases");
  });

  it("degrades gracefully when Finnhub insider data errors", async () => {
    getInsiderTransactions.mockRejectedValue(new Error("rate limited"));
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    expect(lastPrompt()).toContain("Could not fetch Finnhub insider data");
    expect(generate).toHaveBeenCalled(); // still synthesizes
  });
});

// ── Form 4 XML parsing (parseForm4Purchases) ─────────────────────────────────
// searchRecentForm4 returns filing stubs; the agent then fetches the EDGAR Atom
// index (browse-edgar) to find the primary XML, fetches that XML, and parses the
// non-derivative transactions. We stub global fetch for both hops.

const FILING = {
  accessionNo: "0000320193-25-000001",
  cik: "320193",
  filedAt: "2026-07-10",
  periodOfReport: "2026-07-09",
  entityName: "Filing Entity",
};


/** A Form 4 XML. Real filings carry a transaction date and a coding block. */
function form4Xml(opts: {
  code: string;          // P=open-market purchase, S=sale, M=option exercise, A=grant, F=tax withholding
  acquired: string;      // A=acquired, D=disposed
  shares: string;
  price: string;
  ownedAfter: string;
  date?: string;
  title?: string;
  name?: string;
}) {
  return `<ownershipDocument>
    <reportingOwner><rptOwnerName>${opts.name ?? "Jane Insider"}</rptOwnerName></reportingOwner>
    ${opts.title ? `<reportingOwnerRelationship><officerTitle>${opts.title}</officerTitle></reportingOwnerRelationship>` : ""}
    <nonDerivativeTable>
      <nonDerivativeTransaction>
        <transactionDate><value>${opts.date ?? "2026-07-09"}</value></transactionDate>
        <transactionCoding><transactionCode>${opts.code}</transactionCode></transactionCoding>
        <transactionAmounts>
          <transactionShares><value>${opts.shares}</value></transactionShares>
          <transactionPricePerShare><value>${opts.price}</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>${opts.acquired}</value></transactionAcquiredDisposedCode>
        </transactionAmounts>
        <postTransactionAmounts>
          <sharesOwnedFollowingTransaction><value>${opts.ownedAfter}</value></sharesOwnedFollowingTransaction>
        </postTransactionAmounts>
      </nonDerivativeTransaction>
    </nonDerivativeTable>
  </ownershipDocument>`;
}

/** The filing's own directory listing, which is how EDGAR exposes its documents. */
const FILING_INDEX = JSON.stringify({
  directory: {
    item: [
      { name: "0000320193-25-000001-index.htm", type: "text.gif" },
      { name: "xslF345X05/form4.xml", type: "text.gif" }, // the rendered wrapper, not the data
      { name: "form4.xml", type: "text.gif" },
    ],
  },
});

/** Stub global fetch: the filing index, then the Form 4 XML itself. */
function stubEdgarFetch(index: string | { status: number }, xml: string | { status: number }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("index.json")) {
        if (typeof index !== "string") return new Response("err", { status: index.status });
        return new Response(index);
      }
      if (typeof xml !== "string") return new Response("err", { status: xml.status });
      return new Response(xml);
    }),
  );
  return calls;
}

describe("runInsiderAgent — Finnhub history window", () => {
  it("labels the window with the dates the rows actually cover", async () => {
    getInsiderTransactions.mockResolvedValue({
      data: [
        { name: "Jane CEO", change: 1000, transactionPrice: 50, transactionCode: "P", transactionDate: "2026-06-03" },
        { name: "Bob CFO", change: -500, transactionPrice: 60, transactionCode: "S", transactionDate: "2026-09-09" },
      ],
    });
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    const p = lastPrompt();
    // Was hard-coded as "last90Days" over whatever 20 rows came back.
    expect(p).toContain("2026-06-03");
    expect(p).toContain("2026-09-09");
    expect(p).not.toContain("last90Days");
  });

  it("excludes undated rows from the window and counts them", async () => {
    getInsiderTransactions.mockResolvedValue({
      data: [
        { name: "Jane CEO", change: 1000, transactionPrice: 50, transactionCode: "P", transactionDate: "2026-06-03" },
        { name: "No Date", change: 400, transactionPrice: 10, transactionCode: "P" },
      ],
    });
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    const p = lastPrompt();
    expect(p).toContain('"undatedRowsExcluded": 1');
  });

  it("says so when no row carries a date, instead of naming a window", async () => {
    getInsiderTransactions.mockResolvedValue({
      data: [{ name: "No Date", change: 400, transactionPrice: 10, transactionCode: "P" }],
    });
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    expect(lastPrompt()).toContain("no transaction dates");
  });
});

describe("runInsiderAgent — the model never multiplies", () => {
  it("states each trade's dollar value and the buy/sell totals, computed in code", async () => {
    // The readout's case: 38,000 × $26.32 ≈ $1.0M was written up as $10.3M.
    getInsiderTransactions.mockResolvedValue({
      data: [
        { name: "Bourla Albert", change: 38_000, transactionPrice: 26.32, transactionCode: "P", transactionDate: "2026-08-04" },
        { name: "Doe Jane", change: -5_000, transactionPrice: 27.1, transactionCode: "S", transactionDate: "2026-08-20" },
      ],
    });
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["PFE"] });
    const p = lastPrompt();
    expect(p).toContain('"value": "$1.0M"');
    expect(p).toContain('"totalBuyValue": "$1.0M"');
    expect(p).toContain('"totalSellValue": "$135,500"');
    expect(p).toMatch(/never (multiply|recompute)/i);
  });
});

describe("runInsiderAgent — Form 4 purchase parsing", () => {
  beforeEach(() => {
    searchRecentForm4.mockResolvedValue([FILING]);
    getInsiderTransactions.mockResolvedValue({ data: [] });
  });

  it("surfaces a qualifying >$100K purchase as a NEW POSITION with formatted value", async () => {
    // 5,000 @ $50 = $250K; owned-after == shares bought → treated as a new position.
    stubEdgarFetch(
      FILING_INDEX,
      form4Xml({ code: "P", acquired: "A", shares: "5000", price: "50.00", ownedAfter: "5000", title: "Chief Executive Officer" }),
    );
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    const p = lastPrompt();
    expect(p).toContain("Purchases >$100K");
    expect(p).toContain("Jane Insider (Chief Executive Officer)");
    expect(p).toContain("BOUGHT 5,000 shares @ $50.00 = $250,000");
    expect(p).toContain("[NEW POSITION]");
  });

  it("marks a top-up buy as an ADDITION and formats million-dollar values", async () => {
    // 30,000 @ $60 = $1.8M into a 200,000-share stake → an addition, not new.
    stubEdgarFetch(
      FILING_INDEX,
      form4Xml({ code: "P", acquired: "A", shares: "30000", price: "60.00", ownedAfter: "200000" }),
    );
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    const p = lastPrompt();
    expect(p).toContain("= $1.80M");
    expect(p).toContain("[ADDITION]");
  });

  it("filters out sub-$100K purchases", async () => {
    // 100 @ $10 = $1,000 — below the threshold.
    stubEdgarFetch(
      FILING_INDEX,
      form4Xml({ code: "P", acquired: "A", shares: "100", price: "10.00", ownedAfter: "100" }),
    );
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    expect(lastPrompt()).toContain("No qualifying insider purchases");
  });

  it("filters out disposals/sales", async () => {
    // A large sale (code S, disposed D) must never show up as a purchase.
    stubEdgarFetch(
      FILING_INDEX,
      form4Xml({ code: "S", acquired: "D", shares: "5000", price: "50.00", ownedAfter: "0" }),
    );
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    expect(lastPrompt()).toContain("No qualifying insider purchases");
  });

  it("returns no purchases when the filing index lists no Form 4 XML", async () => {
    stubEdgarFetch(JSON.stringify({ directory: { item: [{ name: "readme.htm" }] } }), "unused");
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    expect(lastPrompt()).toContain("No qualifying insider purchases");
  });

  it("returns no purchases when the index lookup returns an HTTP error", async () => {
    stubEdgarFetch({ status: 503 }, "unused");
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    // A failed index hop is swallowed inside parseForm4Purchases (returns []),
    // which is distinct from searchRecentForm4 failing (→ "UNAVAILABLE").
    expect(lastPrompt()).toContain("No qualifying insider purchases");
    expect(lastPrompt()).not.toContain("UNAVAILABLE");
  });

  it("reads the filing named by the search hit, not whatever EDGAR lists first", async () => {
    const calls = stubEdgarFetch(
      FILING_INDEX,
      form4Xml({ code: "P", acquired: "A", shares: "5000", price: "50.00", ownedAfter: "5000" }),
    );
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    // Addressed by accession number. The old code followed a browse-edgar Atom
    // feed and regex-matched an .xml link that EDGAR does not put there, so the
    // parser never matched a filing in production.
    expect(calls[0]).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019325000001/index.json");
    expect(calls.some((u) => u.includes("browse-edgar"))).toBe(false);
    // The rendered xslF345X05/ wrapper must not be mistaken for the data file.
    expect(calls[1]).toBe("https://www.sec.gov/Archives/edgar/data/320193/000032019325000001/form4.xml");
  });

  it("does not call an option exercise a purchase", async () => {
    // Code M with acquired=A: shares acquired by exercising options, not bought
    // on the open market. The old filter (code !== P && acquired !== A) let it
    // through and printed it as "BOUGHT".
    stubEdgarFetch(
      FILING_INDEX,
      form4Xml({ code: "M", acquired: "A", shares: "5000", price: "50.00", ownedAfter: "5000" }),
    );
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    const p = lastPrompt();
    expect(p).not.toContain("BOUGHT");
    expect(p).toContain("No qualifying insider purchases");
    // Still reported, honestly labelled, so the model can weigh it.
    expect(p).toContain("Also filed (acquisitions that are NOT open-market purchases): 1 option exercise");
  });

  it("dates every purchase from the filing's transaction date", async () => {
    stubEdgarFetch(
      FILING_INDEX,
      form4Xml({ code: "P", acquired: "A", shares: "5000", price: "50.00", ownedAfter: "5000", date: "2026-07-06" }),
    );
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    expect(lastPrompt()).toContain("Transacted: 2026-07-06");
  });

  it("returns no purchases when the XML document fetch fails", async () => {
    stubEdgarFetch(FILING_INDEX, { status: 500 });
    const { runInsiderAgent } = await import("./insider-agent");
    await runInsiderAgent({ tickers: ["AAPL"] });
    expect(lastPrompt()).toContain("No qualifying insider purchases");
  });
});
