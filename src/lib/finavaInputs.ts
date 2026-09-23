// Assembles ScoreInputs for the deterministic Finava Score from the data libs.
// Pure extractor helpers (metricsToFundamentalInputs, surpriseAvg, ratingSkew,
// computeRelStrength) are unit-tested; assembleScoreInputs() does the I/O.

import type { ScoreInputs } from "@/lib/finavaScore";
import { getBasicFinancials, getEarnings, getPeerMetrics, getRecommendationTrends, getCandles } from "@/lib/finnhub";
import { getCikByTicker, getCompanyFacts, extractFinancialMetrics, extractFundamentalTimeSeries, extractCurrentSharesOutstanding } from "@/lib/edgar";
import { suggestedWaccFromBeta, defaultFairValue, type DcfInputs } from "@/lib/dcf";
import { getGrokSentiment } from "@/lib/sentiment/grok";
import { insiderNetFlow } from "@/lib/stockData";

type Metric = Record<string, number | undefined>;
const n = (v: number | undefined | null) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Map Finnhub `metric=all` → the fundamentals/valuation slice of ScoreInputs. */
export function metricsToFundamentalInputs(m: Metric): Partial<ScoreInputs> {
  const frac = (v: number | undefined) => (typeof v === "number" ? v / 100 : null);
  return {
    grossMargin: n(m.grossMarginTTM),
    operatingMargin: n(m.operatingMarginTTM),
    netMargin: n(m.netProfitMarginTTM),
    roe: n(m.roeTTM),
    roa: n(m.roaTTM),
    roic: n(m.roicTTM),
    debtToEquity: n(m["totalDebt/totalEquityQuarterly"]),
    currentRatio: n(m.currentRatioQuarterly),
    revenueYoY: frac(m.revenueGrowthTTMYoy),
    epsYoY: frac(m.epsGrowthTTMYoy),
    peTTM: n(m.peTTM),
    psTTM: n(m.psTTM),
    beta: n(m.beta),
  };
}

/** Average percent earnings surprise over the recent list. null when unusable. */
export function surpriseAvg(rows: Array<{ actual?: number; estimate?: number }> | null): number | null {
  if (!rows || rows.length === 0) return null;
  const s = rows
    .map((r) => (typeof r.actual === "number" && typeof r.estimate === "number" && r.estimate !== 0
      ? (r.actual - r.estimate) / Math.abs(r.estimate) : null))
    .filter((x): x is number => x != null);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}

/** Rating skew normalized to [-1, 1] from Finnhub recommendation trends (newest first). */
export function ratingSkew(rec: Array<Record<string, number>> | null): number | null {
  if (!Array.isArray(rec) || rec.length === 0) return null;
  const r = rec[0];
  const sb = r.strongBuy ?? 0, b = r.buy ?? 0, h = r.hold ?? 0, s = r.sell ?? 0, ss = r.strongSell ?? 0;
  const total = sb + b + h + s + ss;
  return total > 0 ? (2 * sb + b - s - 2 * ss) / (2 * total) : null;
}

/** 6-month relative strength: stock window-return minus benchmark window-return. */
export function computeRelStrength(stockCloses: number[], benchCloses: number[]): number | null {
  // Guard the endpoints rather than filtering mid-array: filtering would silently
  // rebase the window to the first non-zero bar and overstate the return.
  const ret = (c: number[]) => {
    if (c.length < 2) return null;
    const start = c[0], end = c[c.length - 1];
    return start > 0 && end > 0 ? end / start - 1 : null;
  };
  const a = ret(stockCloses), b = ret(benchCloses);
  return a != null && b != null ? a - b : null;
}

/** Annualized volatility from daily closes: stdev of daily log returns × √252.
 *  Feeds the confidence model (a very volatile name earns lower confidence). */
export function annualizedVolatility(closes: number[]): number | null {
  const rets: number[] = [];
  for (let k = 1; k < closes.length; k++) {
    if (closes[k - 1] > 0 && closes[k] > 0) rets.push(Math.log(closes[k] / closes[k - 1]));
  }
  if (rets.length < 20) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

/** Filing-derived DCF ingredients. Pure; cached by the facts layer per ticker. */
export interface DcfBase {
  baseFcf: number | null;
  fcfIsProxy: boolean;
  sharesEdgar: number | null;
  sharesAsOf: string | null;
  /**
   * Total debt − cash, in USD. NULL when either component is unavailable.
   *
   * You cannot net against an unknown: this was `(totalDebt ?? 0) - (cash ?? 0)`,
   * so a filing with cash but no debt figure produced phantom NET CASH and
   * inflated the fair value of exactly the companies whose filings are thinnest.
   * Both components are kept so the UI can say which one was missing.
   */
  netDebt: number | null;
  totalDebt: number | null;
  cash: number | null;
  historicalGrowth: number | null;
  fcfConversion: number | null;
  revenueCagr3y: number | null;
}

const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Everything the DCF needs from SEC companyfacts. `null` facts → an all-null base. */
export function extractDcfBase(companyFacts: unknown): DcfBase {
  if (!companyFacts) {
    return { baseFcf: null, fcfIsProxy: true, sharesEdgar: null, sharesAsOf: null, netDebt: null, totalDebt: null, cash: null, historicalGrowth: null, fcfConversion: null, revenueCagr3y: null };
  }
  const mm = extractFinancialMetrics(companyFacts);
  const series = extractFundamentalTimeSeries(companyFacts, 6);
  const ocf = numOrNull(mm.operatingCashFlow);
  const capex = numOrNull(mm.capex);
  const baseFcf = ocf != null ? (capex != null ? ocf - capex : ocf) : null;
  const netIncome = numOrNull(mm.netIncome);
  const rev = series.revenue;
  const historicalGrowth = rev.length >= 2 && rev[0].value > 0 && rev.at(-1)!.value > 0
    ? Math.pow(rev.at(-1)!.value / rev[0].value, 1 / (rev.length - 1)) - 1 : null;
  const revenueCagr3y = rev.length >= 4 && rev.at(-4)!.value > 0 && rev.at(-1)!.value > 0
    ? Math.pow(rev.at(-1)!.value / rev.at(-4)!.value, 1 / 3) - 1 : null;
  // Cover-page count, not the annual weighted average: the latter is pre-split
  // until the next 10-K (see extractCurrentSharesOutstanding).
  const cur = extractCurrentSharesOutstanding(companyFacts);
  const totalDebt = numOrNull(mm.totalDebt);
  const cash = numOrNull(mm.cash);
  return {
    baseFcf,
    fcfIsProxy: capex == null,
    sharesEdgar: cur?.shares ?? numOrNull(mm.sharesOutstanding),
    sharesAsOf: cur?.asOf ?? null,
    // Both components required — see the DcfBase.netDebt note.
    netDebt: totalDebt != null && cash != null ? totalDebt - cash : null,
    totalDebt,
    cash,
    historicalGrowth,
    fcfConversion: baseFcf != null && netIncome != null && netIncome > 0 ? baseFcf / netIncome : null,
    revenueCagr3y,
  };
}

/** The one place DCF inputs are finished: beta-tuned WACC, shares with a mcap÷price fallback. */
export function finishDcfInputs(
  base: DcfBase,
  market: { price: number | null; beta: number | null; marketCapMillions: number | null; currency: string | null }
): DcfInputs {
  let shares = base.sharesEdgar;
  if ((shares == null || shares <= 0) && market.marketCapMillions != null && market.price != null && market.price > 0) {
    shares = (market.marketCapMillions * 1e6) / market.price;
  }
  return {
    baseFcf: base.baseFcf,
    fcfIsProxy: base.fcfIsProxy,
    sharesOutstanding: shares != null && shares > 0 ? shares : null,
    netDebt: base.netDebt,
    historicalGrowth: base.historicalGrowth,
    suggestedWacc: suggestedWaccFromBeta(market.beta),
    currentPrice: market.price,
    currency: market.currency ?? "USD",
  };
}

/** DCF bundle for callers outside the facts layer. Same path as facts.dcf. */
async function computeDcfBundle(
  symbol: string,
  price: number | null
): Promise<{ dcfFair: number | null; fcfConversion: number | null; revenueCagr3y: number | null }> {
  const cik = await getCikByTicker(symbol);
  if (!cik) return { dcfFair: null, fcfConversion: null, revenueCagr3y: null };
  const [facts, metricRaw] = await Promise.all([
    getCompanyFacts(cik),
    getBasicFinancials(symbol).catch(() => null),
  ]);
  const m = (metricRaw as { metric?: Metric } | null)?.metric ?? {};
  const base = extractDcfBase(facts);
  const inputs = finishDcfInputs(base, { price, beta: n(m.beta), marketCapMillions: n(m.marketCapitalization), currency: "USD" });
  return { dcfFair: defaultFairValue(inputs), fcfConversion: base.fcfConversion, revenueCagr3y: base.revenueCagr3y };
}

export interface PrecomputedScoreParts {
  /** Canonical DCF parts from the facts layer; skips the internal DCF fetch. */
  dcf?: { dcfFair: number | null; fcfConversion: number | null; revenueCagr3y: number | null };
  /** Canonical P/E (price ÷ EPS TTM). `undefined` keeps Finnhub's peTTM. */
  peTTM?: number | null;
}

/** Full assembly. Failure-isolated per source; missing fields stay null (excluded).
 *  `newsSentiment` (0–100) is supplied by the caller from the stock bundle's news read;
 *  X/social comes from Grok here. */
export async function assembleScoreInputs(
  symbol: string,
  price: number | null,
  insiderTrades: Array<{ shares: number }> | null,
  newsSentiment: number | null,
  companyName?: string,
  pre: PrecomputedScoreParts = {}
): Promise<ScoreInputs> {
  const base: ScoreInputs = {
    revenueYoY: null, epsYoY: null, revenueCagr3y: null,
    grossMargin: null, operatingMargin: null, netMargin: null,
    roe: null, roa: null, roic: null,
    debtToEquity: null, currentRatio: null, fcfConversion: null,
    price, dcfFair: null, peTTM: null, peerPe: null, psTTM: null, peerPs: null,
    ratingSkew: null, targetUpsidePct: null, estimateRevisionPct: null, earningsSurprisePct: null,
    trendVs200: null, ret3m: null, relStrength6m: null,
    newsSentiment, xSentiment: null, insiderFlow: null,
    beta: null, annualizedVol: null,
  };

  const day = 86_400, now = Math.floor(Date.now() / 1000);
  const [metricRaw, earningsRaw, recRaw, peerRaw, grok, stockC, benchC, dcf] = await Promise.all([
    getBasicFinancials(symbol).catch(() => null),
    getEarnings(symbol).catch(() => null),
    getRecommendationTrends(symbol).catch(() => null),
    getPeerMetrics(symbol).catch(() => ({ peerPe: null, peerPs: null })),
    getGrokSentiment(symbol, companyName).catch(() => null),
    getCandles(symbol, "D", now - 300 * day, now).catch(() => null),
    getCandles("SPY", "D", now - 300 * day, now).catch(() => null),
    pre.dcf
      ? Promise.resolve(pre.dcf)
      : computeDcfBundle(symbol, price).catch(() => ({ dcfFair: null, fcfConversion: null, revenueCagr3y: null })),
  ]);

  const m = (metricRaw as { metric?: Metric } | null)?.metric ?? {};
  Object.assign(base, metricsToFundamentalInputs(m));
  // One P/E everywhere: the facts layer's price ÷ EPS. peerPe stays on Finnhub's
  // basis, so the peer ratio mixes bases by a fraction of a percent (accepted).
  if (pre.peTTM !== undefined) base.peTTM = pre.peTTM;
  base.peerPe = peerRaw.peerPe;
  base.peerPs = peerRaw.peerPs;
  base.earningsSurprisePct = surpriseAvg(earningsRaw as Array<{ actual?: number; estimate?: number }> | null);
  base.ratingSkew = ratingSkew(recRaw as Array<Record<string, number>> | null);
  base.dcfFair = dcf.dcfFair;
  base.fcfConversion = dcf.fcfConversion;
  base.revenueCagr3y = dcf.revenueCagr3y;

  // Insider flow normalized against absolute share count (Finnhub reports millions).
  const sharesAbs = n(m.sharesOutstanding) != null ? (m.sharesOutstanding as number) * 1e6 : null;
  base.insiderFlow = insiderNetFlow(insiderTrades, sharesAbs);

  // X/social sentiment: map Grok polarity [-1,1] → [0,100]. Exclude when degraded / no posts.
  if (grok && !grok.degraded && grok.foundPosts > 0) {
    base.xSentiment = Math.max(0, Math.min(100, 50 + grok.score * 50));
  }

  // Momentum from candle closes.
  const closes = (stockC as { c?: number[] } | null)?.c ?? [];
  if (closes.length >= 200) {
    const last = closes[closes.length - 1];
    const ma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
    base.trendVs200 = ma200 > 0 ? last / ma200 - 1 : null;
    const p63 = closes[closes.length - 64];
    base.ret3m = p63 && p63 > 0 ? last / p63 - 1 : null;
  }
  const benchCloses = (benchC as { c?: number[] } | null)?.c ?? [];
  if (closes.length >= 126 && benchCloses.length >= 126) {
    base.relStrength6m = computeRelStrength(closes.slice(-126), benchCloses.slice(-126));
  }
  base.annualizedVol = annualizedVolatility(closes);

  return base;
}
