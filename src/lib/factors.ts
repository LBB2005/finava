/* ============================================================
   Finava · Research — real factor engine
   ------------------------------------------------------------
   Scores every S&P 500 name on the six Finava factors from REAL
   data, not placeholders:

     MOM  Momentum    ← Alpaca daily closes (price returns + trend)
     GRW  Growth      ← Polygon financials (revenue & EPS growth)
     QAL  Quality     ← Polygon financials (ROE, ROA, margins)
     VAL  Valuation   ← Polygon financials + live price (P/E, P/S, P/B, P/FCF)
     FIN  Health      ← Polygon financials (leverage, liquidity, cash gen)
     ANL  Analyst     ← Finnhub (rating skew + upside to price target)

   Each raw metric is converted to a 0–100 score by SECTOR-RELATIVE
   percentile rank — a bank is graded against banks, a utility against
   utilities — so the factor profile is comparable across very different
   business models. A factor with no usable inputs for a stock falls back
   to a neutral 50 rather than dropping the stock from the board.

   Polygon is the primary fundamentals source; EDGAR (SEC XBRL) is the
   fallback when Polygon has no filing for a ticker. Everything is
   failure-isolated: a down source nulls a metric, never 500s the board.
   ============================================================ */

import { getAnnualFinancials, getTickerDetails } from "@/lib/polygon";
import {
  getAlpacaSnapshots,
  getAlpacaCloseHistory,
  type AlpacaSnapshot,
  type DailyClose,
} from "@/lib/alpaca";
import { getRecommendationTrends } from "@/lib/finnhub";
import { getCikByTicker, getCompanyFacts, extractCurrentSharesOutstanding } from "@/lib/edgar";
import { ALL_CONSTITUENTS } from "@/lib/extraUniverse";
import type { FactorScores, Stock } from "@/lib/research";
import type { SourceStatus } from "@/lib/fetchRetry";

// ── small utilities ───────────────────────────────────────────────────────────
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function ratio(a: number | null, b: number | null): number | null {
  return a != null && b != null && b > 0 ? a / b : null;
}
function growth(curr: number | null, prev: number | null): number | null {
  // Only meaningful when the prior base is positive — growth off a negative or
  // zero base is not interpretable as a percentage.
  return curr != null && prev != null && prev > 0 ? curr / prev - 1 : null;
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── fundamentals shape (source-agnostic) ───────────────────────────────────────
interface Fundamentals {
  // Annual series, newest-first (index 0 = latest fiscal year).
  revenue: number[];
  eps: number[];
  // Latest-period balance-sheet / income snapshot.
  netIncome: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  equity: number | null;
  assets: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  longTermDebt: number | null;
  operatingCashFlow: number | null;
  /** Weighted average diluted shares for the LAST FISCAL YEAR. Stated in the
   *  shares of that year — pre-split after a split. Never multiply by today's price. */
  dilutedShares: number | null;
  /** Shares outstanding as of the latest filing's cover page: a current count. */
  currentShares: number | null;
}

const EMPTY_FUND: Fundamentals = {
  revenue: [], eps: [], netIncome: null, grossProfit: null, operatingIncome: null,
  equity: null, assets: null, currentAssets: null, currentLiabilities: null,
  longTermDebt: null, operatingCashFlow: null, dilutedShares: null, currentShares: null,
};

// ── Polygon parser ──────────────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
function fval(stmt: any, key: string): number | null {
  return num(stmt?.[key]?.value);
}

function parsePolygon(data: any): Fundamentals | null {
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  if (results.length === 0) return null;
  const inc = (r: any) => r?.financials?.income_statement ?? {};
  const latest = results[0];
  const incL = inc(latest);
  const bal = latest?.financials?.balance_sheet ?? {};
  const cf = latest?.financials?.cash_flow_statement ?? {};

  const revenue = results.map((r) => fval(inc(r), "revenues")).filter((v): v is number => v != null);
  const eps = results
    .map((r) => fval(inc(r), "diluted_earnings_per_share") ?? fval(inc(r), "basic_earnings_per_share"))
    .filter((v): v is number => v != null);

  return {
    revenue,
    eps,
    netIncome: fval(incL, "net_income_loss") ?? fval(incL, "net_income_loss_attributable_to_parent"),
    grossProfit: fval(incL, "gross_profit"),
    operatingIncome: fval(incL, "operating_income_loss"),
    equity: fval(bal, "equity_attributable_to_parent") ?? fval(bal, "equity"),
    assets: fval(bal, "assets"),
    currentAssets: fval(bal, "current_assets"),
    currentLiabilities: fval(bal, "current_liabilities"),
    longTermDebt: fval(bal, "long_term_debt"),
    operatingCashFlow: fval(cf, "net_cash_flow_from_operating_activities"),
    dilutedShares: fval(incL, "diluted_average_shares") ?? fval(incL, "basic_average_shares"),
    currentShares: null, // Polygon financials are per fiscal year; see fetchCapInputs
  };
}

// ── EDGAR fallback parser ─────────────────────────────────────────────────────
// Pull a clean annual (10-K) series for a GAAP concept, newest fiscal year first.
function edgarAnnual(us: any, ...keys: string[]): number[] {
  for (const key of keys) {
    const units =
      us?.[key]?.units?.USD ??
      us?.[key]?.units?.shares ??
      us?.[key]?.units?.["USD/shares"] ??
      [];
    const annual = (units as any[]).filter(
      (u) => u.form === "10-K" && (!u.frame || /^CY\d{4}$/.test(u.frame) || u.frame.endsWith("I"))
    );
    if (!annual.length) continue;
    const byYear = new Map<number, number>();
    for (const e of annual) byYear.set(new Date(e.end).getFullYear(), e.val); // later filings overwrite
    return Array.from(byYear.entries())
      .sort((a, b) => b[0] - a[0]) // newest first
      .map(([, v]) => v)
      .filter((v) => typeof v === "number" && Number.isFinite(v));
  }
  return [];
}

function parseEdgar(facts: any): Fundamentals | null {
  const us = facts?.facts?.["us-gaap"];
  if (!us) return null;
  const first = (a: number[]) => (a.length ? a[0] : null);
  return {
    revenue: edgarAnnual(us, "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"),
    eps: edgarAnnual(us, "EarningsPerShareDiluted", "EarningsPerShareBasic"),
    netIncome: first(edgarAnnual(us, "NetIncomeLoss")),
    grossProfit: first(edgarAnnual(us, "GrossProfit")),
    operatingIncome: first(edgarAnnual(us, "OperatingIncomeLoss")),
    equity: first(edgarAnnual(us, "StockholdersEquity")),
    assets: first(edgarAnnual(us, "Assets")),
    currentAssets: first(edgarAnnual(us, "AssetsCurrent")),
    currentLiabilities: first(edgarAnnual(us, "LiabilitiesCurrent")),
    longTermDebt: first(edgarAnnual(us, "LongTermDebtNoncurrent", "LongTermDebt")),
    operatingCashFlow: first(edgarAnnual(us, "NetCashProvidedByUsedInOperatingActivities")),
    dilutedShares: first(edgarAnnual(us, "WeightedAverageNumberOfDilutedSharesOutstanding")),
    currentShares: extractCurrentSharesOutstanding(facts)?.shares ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Fundamentals plus a typed provenance so downstream can tell "we couldn't reach
// the API" (failed) apart from "the API says this ticker has no filings"
// (unavailable) — instead of collapsing both to a null → neutral-50 score.
interface FundamentalsResult {
  status: SourceStatus;
  data: Fundamentals | null;
}

async function fetchFundamentals(ticker: string): Promise<FundamentalsResult> {
  // `reached` stays true only while every source we tried answered without a
  // transport error. A thrown fetch (post-retry 429/5xx/network) flips it false;
  // an empty-but-successful response leaves it true (authoritative "no data").
  let reached = true;
  try {
    const f = parsePolygon(await getAnnualFinancials(ticker));
    if (f && f.revenue.length) return { status: "ok", data: f };
  } catch { reached = false; /* couldn't reach Polygon — fall through to EDGAR */ }
  try {
    const cik = await getCikByTicker(ticker);
    if (cik) {
      const f = parseEdgar(await getCompanyFacts(cik));
      if (f && f.revenue.length) return { status: "ok", data: f };
    }
    // cik == null: SEC's ticker file loaded and this ticker isn't in it → no filings.
  } catch { reached = false; /* couldn't reach EDGAR */ }
  return { status: reached ? "unavailable" : "failed", data: null };
}

// ── market capitalisation ────────────────────────────────────────────────────
/** A computed cap this far from the feed's means our share count is wrong. */
const CAP_DISAGREEMENT = 3;

export interface MarketCapInputs {
  price: number | null;
  /** Current shares outstanding (cover page / feed) — split-adjusted by definition. */
  currentShares: number | null;
  /** Weighted average shares from the last annual filing. Kept only to be ignored. */
  filingShares: number | null;
  /** The data feed's own market cap, when it has one. */
  feedCap: number | null;
}

/**
 * Market cap from a CURRENT share count and the current price.
 *
 * Multiplying the last 10-K's weighted-average share count by today's price is
 * wrong for any issuer that split since: BKNG's FY2025 filing reports 32.6M
 * shares against a post-split price, which produced a $5.7B cap and a P/E near 1,
 * and a value score of 98. When no current count is available we return null —
 * "Unavailable" is the honest answer; a plausible wrong number is not.
 */
export function resolveMarketCap({ price, currentShares, filingShares, feedCap }: MarketCapInputs): number | null {
  void filingShares; // deliberately unused: see above
  if (price == null || currentShares == null || currentShares <= 0) return feedCap ?? null;
  const computed = price * currentShares;
  if (feedCap != null && feedCap > 0) {
    const ratio = computed / feedCap;
    if (ratio > CAP_DISAGREEMENT || ratio < 1 / CAP_DISAGREEMENT) {
      console.warn(
        `[factors] market cap disagreement: computed ${computed.toExponential(3)} vs feed ${feedCap.toExponential(3)} — using the feed`
      );
      return feedCap;
    }
  }
  return computed;
}

/** Current shares + the feed's cap, from one Polygon reference call per ticker. */
async function fetchCapInputs(ticker: string): Promise<{ currentShares: number | null; feedCap: number | null }> {
  try {
    const details = await getTickerDetails(ticker);
    const r = (details as { results?: Record<string, unknown> })?.results ?? {};
    return {
      currentShares: num(r.share_class_shares_outstanding) ?? num(r.weighted_shares_outstanding),
      feedCap: num(r.market_cap),
    };
  } catch {
    return { currentShares: null, feedCap: null }; // EDGAR's cover-page count still applies
  }
}

// ── analyst (Finnhub) ─────────────────────────────────────────────────────────
// Rating skew only (one call/ticker). We deliberately skip the separate
// price-target endpoint: at S&P 500 scale a second per-ticker call doubles the
// free-tier rate-limit pressure for a marginal signal. The buy/sell skew is the
// stronger, more widely-covered indicator.
interface AnalystRaw {
  skew: number | null; // -1 (all sell) … +1 (all strong buy)
  // Same failed/unavailable provenance as fundamentals: a rate-limited Finnhub
  // call (failed) must not read as "no analysts cover this name" (unavailable).
  status: SourceStatus;
}

async function fetchAnalyst(ticker: string): Promise<AnalystRaw> {
  try {
    const rec = await getRecommendationTrends(ticker);
    if (Array.isArray(rec) && rec.length) {
      const r = rec[0] as Record<string, number>; // latest period first
      const sb = r.strongBuy ?? 0, b = r.buy ?? 0, h = r.hold ?? 0, s = r.sell ?? 0, ss = r.strongSell ?? 0;
      const total = sb + b + h + s + ss;
      if (total > 0) return { skew: (2 * sb + b - s - 2 * ss) / (2 * total), status: "ok" }; // normalise to [-1, 1]
    }
    return { skew: null, status: "unavailable" }; // responded, but no coverage for this ticker
  } catch { /* rate-limited or network → we don't know */ }
  return { skew: null, status: "failed" };
}

// ── momentum (from daily closes) ───────────────────────────────────────────────
interface MomentumRaw {
  ret12_1: number | null; // 12-month return excluding the most recent month
  ret6: number | null;
  ret3: number | null;
  vs200: number | null; // price vs 200-day moving average
}

function momentum(closes: DailyClose[] | undefined): MomentumRaw {
  if (!closes || closes.length < 30) return { ret12_1: null, ret6: null, ret3: null, vs200: null };
  const c = closes.map((x) => x.c).filter((x) => x > 0);
  const n = c.length;
  const last = c[n - 1];
  const ago = (d: number) => (n - 1 - d >= 0 ? c[n - 1 - d] : null);

  const p21 = ago(21), p252 = ago(252);
  const ret12_1 = n >= 252 && p21 && p252 ? p21 / p252 - 1 : null;
  const p126 = ago(126);
  const ret6 = n >= 126 && p126 ? last / p126 - 1 : null;
  const p63 = ago(63);
  const ret3 = n >= 63 && p63 ? last / p63 - 1 : null;
  const ma200 = n >= 200 ? c.slice(-200).reduce((a, b) => a + b, 0) / 200 : null;
  const vs200 = ma200 && ma200 > 0 ? last / ma200 - 1 : null;

  return { ret12_1, ret6, ret3, vs200 };
}

// Real backward-looking price moves for the Board's Movers section.
// Uses the same close history fetched for the momentum factor, so no
// extra API calls — just a different window on the same data.
import type { HorizonKey } from "@/lib/research";
function computeMv(closes: DailyClose[] | undefined): Record<HorizonKey, number> {
  if (!closes || closes.length < 2) return { week: 0, month: 0, year: 0 };
  const c = closes.map((x) => x.c).filter((x) => x > 0);
  const n = c.length;
  const last = c[n - 1];
  const ago = (d: number) => (n - 1 - d >= 0 ? c[n - 1 - d] : null);
  const pct = (p: number | null) => (p && p > 0 ? (last / p - 1) * 100 : 0);
  return {
    week: pct(ago(5)),
    month: pct(ago(21)),
    year: pct(ago(252)),
  };
}

// ── sector-relative percentile engine ──────────────────────────────────────────
type Dir = 1 | -1; // 1 = higher is better, -1 = lower is better (e.g. valuation, leverage)

interface SubMetric {
  weight: number;
  dir: Dir;
  raw: (number | null)[]; // one value per stock (index-aligned), null = no data
}

// Rank each sub-metric to a 0–100 percentile WITHIN its sector, then take a
// weighted average of whatever sub-metrics a stock actually has. No usable
// sub-metric → neutral 50.
function scoreFactor(subs: SubMetric[], sectors: string[]): number[] {
  const n = sectors.length;
  const pcts = subs.map((sm) => sectorPercentile(sm.raw, sectors, sm.dir));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let acc = 0, wsum = 0;
    subs.forEach((sm, si) => {
      const p = pcts[si][i];
      if (p != null) { acc += p * sm.weight; wsum += sm.weight; }
    });
    out[i] = wsum > 0 ? Math.round(acc / wsum) : 50;
  }
  return out;
}

function sectorPercentile(raw: (number | null)[], sectors: string[], dir: Dir): (number | null)[] {
  const out = new Array<number | null>(raw.length).fill(null);
  const bySector = new Map<string, number[]>();
  raw.forEach((v, i) => {
    if (v != null && Number.isFinite(v)) {
      (bySector.get(sectors[i]) ?? bySector.set(sectors[i], []).get(sectors[i])!).push(i);
    }
  });
  for (const idxs of bySector.values()) {
    // Sort so the BEST value lands last (rank m-1 → percentile 100).
    const sorted = [...idxs].sort((a, b) => (dir === 1 ? raw[a]! - raw[b]! : raw[b]! - raw[a]!));
    const m = sorted.length;
    sorted.forEach((idx, rank) => {
      out[idx] = m === 1 ? 100 : Math.round((rank / (m - 1)) * 100);
    });
  }
  return out;
}

// ── orchestrator ────────────────────────────────────────────────────────────
export interface FactorUniverse {
  stocks: Stock[];
  asOf: string;
  coverage: {
    total: number;
    fundamentals: number;
    analyst: number;
    momentum: number;
    priced: number;
    // How many names fell back to neutral scores because a source could not be
    // reached (transient), NOT because the data genuinely doesn't exist. Lets a
    // caller distinguish "the board is thin right now" from "these names have no
    // filings" — the whole point of threading SourceStatus through.
    fundamentalsFailed: number;
    analystFailed: number;
  };
}

export async function computeFactorUniverse(): Promise<FactorUniverse> {
  // S&P 500 plus a curated set of popular non-S&P names + major ADRs the engine
  // can score the same way — so real retail holdings (and Research) aren't limited
  // to index members. ETFs are handled separately in the DNA layer.
  const list = ALL_CONSTITUENTS;
  const tickers = list.map((c) => c.ticker);
  const sectors = list.map((c) => c.sector);

  const [snaps, closeHist, funds, analysts, capInputs] = await Promise.all([
    getAlpacaSnapshots(tickers).catch(() => new Map<string, AlpacaSnapshot>()),
    getAlpacaCloseHistory(tickers).catch(() => new Map<string, DailyClose[]>()),
    mapPool(tickers, 12, fetchFundamentals),
    mapPool(tickers, 8, fetchAnalyst),
    mapPool(tickers, 12, fetchCapInputs),
  ]);

  const price = (i: number) => snaps.get(tickers[i])?.price ?? null;
  const fund = (i: number) => funds[i].data ?? EMPTY_FUND;
  const mom = tickers.map((t) => momentum(closeHist.get(t)));

  // Per-stock raw sub-metrics (index-aligned).
  const marketCap = tickers.map((_, i) =>
    resolveMarketCap({
      price: price(i),
      // The feed's current count first, then the latest filing's cover page.
      currentShares: capInputs[i].currentShares ?? fund(i).currentShares,
      filingShares: fund(i).dilutedShares,
      feedCap: capInputs[i].feedCap,
    })
  );

  // GROWTH
  const growthScore = scoreFactor([
    { weight: 0.4, dir: 1, raw: tickers.map((_, i) => growth(fund(i).revenue[0] ?? null, fund(i).revenue[1] ?? null)) },
    { weight: 0.3, dir: 1, raw: tickers.map((_, i) => growth(fund(i).eps[0] ?? null, fund(i).eps[1] ?? null)) },
    { weight: 0.3, dir: 1, raw: tickers.map((_, i) => {
      const r = fund(i).revenue; // 3-year revenue CAGR
      return r.length >= 4 && r[3] > 0 ? Math.pow(r[0] / r[3], 1 / 3) - 1 : null;
    }) },
  ], sectors);

  // QUALITY
  const qualityScore = scoreFactor([
    { weight: 0.3, dir: 1, raw: tickers.map((_, i) => ratio(fund(i).netIncome, fund(i).equity)) },          // ROE
    { weight: 0.2, dir: 1, raw: tickers.map((_, i) => ratio(fund(i).netIncome, fund(i).assets)) },           // ROA
    { weight: 0.2, dir: 1, raw: tickers.map((_, i) => ratio(fund(i).grossProfit, fund(i).revenue[0] ?? null)) }, // gross margin
    { weight: 0.3, dir: 1, raw: tickers.map((_, i) => ratio(fund(i).operatingIncome, fund(i).revenue[0] ?? null)) }, // op margin
  ], sectors);

  // VALUATION — lower multiple = cheaper = better (dir -1). Loss-making / no-data → excluded.
  const valueScore = scoreFactor([
    { weight: 0.35, dir: -1, raw: tickers.map((_, i) => ratio(marketCap[i], fund(i).netIncome)) },              // P/E
    { weight: 0.25, dir: -1, raw: tickers.map((_, i) => ratio(marketCap[i], fund(i).revenue[0] ?? null)) },     // P/S
    { weight: 0.2,  dir: -1, raw: tickers.map((_, i) => ratio(marketCap[i], fund(i).equity)) },                 // P/B
    { weight: 0.2,  dir: -1, raw: tickers.map((_, i) => ratio(marketCap[i], fund(i).operatingCashFlow)) },      // P/FCF (OCF proxy)
  ], sectors);

  // HEALTH
  const healthScore = scoreFactor([
    { weight: 0.4,  dir: -1, raw: tickers.map((_, i) => ratio(fund(i).longTermDebt, fund(i).equity)) },           // debt / equity (lower better)
    { weight: 0.35, dir: 1,  raw: tickers.map((_, i) => ratio(fund(i).currentAssets, fund(i).currentLiabilities)) }, // current ratio
    { weight: 0.25, dir: 1,  raw: tickers.map((_, i) => ratio(fund(i).operatingCashFlow, fund(i).assets)) },      // cash generation
  ], sectors);

  // MOMENTUM
  const momScore = scoreFactor([
    { weight: 0.35, dir: 1, raw: mom.map((m) => m.ret12_1) },
    { weight: 0.25, dir: 1, raw: mom.map((m) => m.ret6) },
    { weight: 0.2,  dir: 1, raw: mom.map((m) => m.ret3) },
    { weight: 0.2,  dir: 1, raw: mom.map((m) => m.vs200) },
  ], sectors);

  // ANALYST — buy/sell rating skew, sector-relative.
  const analystScore = scoreFactor([
    { weight: 1, dir: 1, raw: analysts.map((a) => a.skew) },
  ], sectors);

  const stocks: Stock[] = list.map((c, i) => {
    const f: FactorScores = {
      mom: momScore[i],
      growth: growthScore[i],
      quality: qualityScore[i],
      analyst: analystScore[i],
      value: valueScore[i],
      health: healthScore[i],
    };
    const p = price(i);
    // Surface the cap + TTM P/E we already computed for the value factor so the
    // Screen lens (cap/PE filters) and the chat scout (grounded fit table) can use
    // real numbers. P/E is null for loss-makers (ni ≤ 0) — applyScreen treats it as
    // "no value", which is the right behaviour for a "cheap" screen.
    const cap = marketCap[i];
    const ni = fund(i).netIncome;
    const peVal = cap != null && ni != null && ni > 0 ? cap / ni : null;
    return {
      ticker: c.ticker,
      name: c.name,
      sector: c.sector,
      price: p ?? 0,
      chg: snaps.get(c.ticker)?.changePct ?? 0,
      f,
      mv: computeMv(closeHist.get(c.ticker)), // real 5/21/252-day price moves for Movers
      marketCap: cap,
      pe: peVal,
      live: p != null,
      // Provenance of the fundamentals behind `f`: "ok" = real inputs, "unavailable"
      // = no filings on record, "failed" = source unreachable (scores are a neutral
      // placeholder, not a judgement). The UI can flag "failed" instead of implying
      // the neutral 50 is real data.
      fundStatus: funds[i].status,
    };
  });

  const coverage = {
    total: list.length,
    fundamentals: funds.filter((r) => r.status === "ok").length,
    analyst: analysts.filter((a) => a.status === "ok").length,
    momentum: mom.filter((m) => m.ret3 != null).length,
    priced: tickers.filter((_, i) => price(i) != null).length,
    fundamentalsFailed: funds.filter((r) => r.status === "failed").length,
    analystFailed: analysts.filter((a) => a.status === "failed").length,
  };

  return { stocks, asOf: new Date().toISOString(), coverage };
}
