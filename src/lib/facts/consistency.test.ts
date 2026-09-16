// The acceptance check: for five tickers, every loader a surface reads returns
// the same score, DCF fair value and price. Upstream vendors are mocked at the
// module boundary; everything from the facts layer up runs for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import aapl from "@/lib/__fixtures__/sec/aapl.json";
import msft from "@/lib/__fixtures__/sec/msft.json";
import cost from "@/lib/__fixtures__/sec/cost.json";
import jpm from "@/lib/__fixtures__/sec/jpm.json";
import bkng from "@/lib/__fixtures__/sec/bkng.json";
import { createFakeFirestore } from "@/test/fakeFirestore";
import { scoreInputs } from "@/test/factsFixture";

const FILINGS: Record<string, unknown> = { AAPL: aapl, MSFT: msft, COST: cost, JPM: jpm, BKNG: bkng };
const PRICES: Record<string, number> = { AAPL: 230.1, MSFT: 505.2, COST: 940.4, JPM: 301.7, BKNG: 5480.9 };
const TICKERS = Object.keys(FILINGS);

const fs = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeFirestore> | null }));
const deps = vi.hoisted(() => ({
  getQuote: vi.fn(), getBasicFinancials: vi.fn(), getEarningsCalendar: vi.fn(), getPriceTarget: vi.fn(), getCompanyNews: vi.fn(),
  getCikByTicker: vi.fn(), getCompanyFacts: vi.fn(), getStockBundle: vi.fn(), assembleScoreInputs: vi.fn(),
}));

vi.mock("@/lib/firebase-admin", () => ({ get db() { return fs.current!.db; } }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: async () => null }));
vi.mock("@/lib/llm", () => ({ generate: vi.fn() }));
vi.mock("@/lib/sentiment/grok", () => ({ getGrokSentiment: vi.fn() }));
vi.mock("@/agents/skills", () => ({ getSkillsPrompt: () => "" }));
vi.mock("@/lib/finnhub", () => ({
  getQuote: deps.getQuote, getBasicFinancials: deps.getBasicFinancials, getEarningsCalendar: deps.getEarningsCalendar,
  getPriceTarget: deps.getPriceTarget, getCompanyNews: deps.getCompanyNews,
}));
vi.mock("@/lib/edgar", async (orig) => ({
  ...(await orig<typeof import("@/lib/edgar")>()),
  getCikByTicker: deps.getCikByTicker, getCompanyFacts: deps.getCompanyFacts,
}));
vi.mock("@/lib/stockData", async (orig) => ({
  ...(await orig<typeof import("@/lib/stockData")>()),
  getStockBundle: deps.getStockBundle,
}));
vi.mock("@/lib/finavaInputs", async (orig) => ({
  ...(await orig<typeof import("@/lib/finavaInputs")>()),
  assembleScoreInputs: deps.assembleScoreInputs,
}));

import { GET as factsRoute } from "@/app/api/facts/[ticker]/route";
import { GET as batchRoute } from "@/app/api/facts/route";
import { GET as scoreRoute } from "@/app/api/stock/[ticker]/score/route";
import { GET as dcfRoute } from "@/app/api/stock/[ticker]/dcf/route";
import { getQuickContext } from "@/lib/quickContext";
import { getPortfolioFacts } from "./portfolio";
import { clearFactsMemo } from "./cache";
import { defaultFairValue } from "@/lib/dcf";

const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(async () => {
  vi.clearAllMocks();
  clearFactsMemo();
  fs.current = createFakeFirestore();
  deps.getQuote.mockImplementation(async (t: string) => ({
    ticker: t, price: PRICES[t], change: 1, changePct: 0.5, volume: 0, high: 0, low: 0, open: 0, prevClose: 0,
    asOf: "2026-09-15T19:59:00.000Z", asOfSource: "exchange",
  }));
  deps.getBasicFinancials.mockImplementation(async () => ({ metric: { epsTTM: 7.5, beta: 1.1, "52WeekLow": 1, "52WeekHigh": 2, marketCapitalization: 1_000_000, ebitdPerShareTTM: 10 } }));
  deps.getEarningsCalendar.mockResolvedValue({ earningsCalendar: [] });
  deps.getPriceTarget.mockResolvedValue({ targetMean: 100, numberOfAnalysts: 10 });
  deps.getCompanyNews.mockResolvedValue([]);
  deps.getCikByTicker.mockImplementation(async (t: string) => `CIK-${t}`);
  deps.getCompanyFacts.mockImplementation(async (cik: string) => FILINGS[cik.slice(4)]);
  deps.getStockBundle.mockResolvedValue({ insider: null, sentiment: { score: 55 }, profile: null });
  // Give each ticker a different score so a mix-up between tickers can't pass.
  deps.assembleScoreInputs.mockImplementation(async (t: string, price: number | null, _i: unknown, _n: unknown, _c: unknown, pre: { dcf: { dcfFair: number | null } }) =>
    scoreInputs({ price, dcfFair: pre.dcf.dcfFair, ratingSkew: (TICKERS.indexOf(t) - 2) / 3 })
  );
  const u = fs.current.db.collection("users").doc("u1");
  for (const t of TICKERS) await u.collection("holdings").doc(t).set({ ticker: t, shares: 1, avgCost: 1 });
});

describe("one set of numbers", () => {
  it.each(TICKERS)("%s: score, DCF and price agree across every loader", async (t) => {
    const full = await (await factsRoute(new Request(`http://t/api/facts/${t}`), ctx(t))).json();
    expect(full.score.value).not.toBeNull();

    const score = await (await scoreRoute(new Request("http://t"), ctx(t))).json();
    const batch = await (await batchRoute(new Request(`http://t/api/facts?tickers=${TICKERS.join(",")}`))).json();
    const qc = await getQuickContext({ tickers: [t] });
    const book = await getPortfolioFacts("u1");
    const holding = book.holdings.find((h) => h.ticker === t)!;

    // Score: facts route = score route = batch = quick context = portfolio row.
    const total = full.score.value.total;
    expect(score.score).toBe(total);
    expect(score.grade).toBe(full.score.value.grade);
    expect(batch.facts.find((f: { ticker: string }) => f.ticker === t).score.value.total).toBe(total);
    expect(qc.facts.finavaScore.value).toBe(`${total} (${full.score.value.grade})`);
    expect(holding.score.value?.total).toBe(total);

    // Price: facts route = quick context = portfolio row.
    expect(full.price.value).toBe(PRICES[t]);
    expect(holding.price.value).toBe(PRICES[t]);
    expect(holding.marketValue.value).toBe(PRICES[t]); // 1 share: the value the totals use
    expect(qc.facts.price.value).toBe(`$${PRICES[t].toFixed(2)}`);

    // DCF: facts route fair value = what the DCF tab computes from /dcf inputs.
    const dcfRes = await dcfRoute(new Request("http://t"), ctx(t));
    if (full.dcf.value) {
      const { inputs } = await dcfRes.json();
      expect(defaultFairValue(inputs)).toBeCloseTo(full.dcf.value.fairValue, 6);
    } else {
      expect(dcfRes.status).toBe(404);
    }
  });

  it("the score is assembled once per ticker no matter how many surfaces read it", async () => {
    for (const t of TICKERS) {
      await factsRoute(new Request(`http://t/api/facts/${t}`), ctx(t));
      await scoreRoute(new Request("http://t"), ctx(t));
      await dcfRoute(new Request("http://t"), ctx(t));
    }
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(TICKERS.length);
  });
});
