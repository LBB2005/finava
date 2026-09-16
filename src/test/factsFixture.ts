// A complete, plausible TickerFacts for tests. Every field sourced and dated.
import { computeFinavaScore, type ScoreInputs } from "@/lib/finavaScore";
import { grade } from "@/lib/research";
import { peerPremiumPct } from "@/lib/facts/signals";
import { fact, SCORE_VERSION, DCF_VERSION, TERMINAL_GROWTH, type TickerFacts } from "@/lib/facts/types";

export const FIXTURE_ASOF = "2026-09-15T20:00:00.000Z";

export function scoreInputs(over: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    revenueYoY: 0.11, epsYoY: 0.14, revenueCagr3y: 0.09, grossMargin: 45, operatingMargin: 30, netMargin: 25,
    roe: 28, roa: 18, roic: 22, debtToEquity: 1.1, currentRatio: 1.3, fcfConversion: 1.05,
    price: 200, dcfFair: 215, peTTM: 30, peerPe: 26, psTTM: 7, peerPs: 6,
    ratingSkew: 0.6, targetUpsidePct: null, estimateRevisionPct: null, earningsSurprisePct: 0.04,
    trendVs200: 0.08, ret3m: 0.06, relStrength6m: 0.04, newsSentiment: 62, xSentiment: 58, insiderFlow: 0.2,
    beta: 1.2, annualizedVol: 0.24, ...over,
  };
}

export function tickerFactsFixture(
  ticker = "NVDA",
  over: Partial<TickerFacts> = {},
  inputs: ScoreInputs = scoreInputs()
): TickerFacts {
  const at = (source: string, unit?: string) => ({ source, asOf: FIXTURE_ASOF, unit });
  const r = computeFinavaScore(inputs);
  return {
    ticker,
    price: fact(182.5, at("Finnhub quote", "USD")),
    change1d: fact(1.79, at("Finnhub quote", "%")),
    marketCap: fact(4.46e12, at("Computed: price × shares outstanding", "USD")),
    sharesOut: fact(24.4e9, at("SEC EDGAR cover page", "shares")),
    pe: fact(51.26, at("Computed: price ÷ EPS (TTM)", "x")),
    evEbitda: fact(40.1, at("Computed: enterprise value ÷ EBITDA (TTM)", "x")),
    epsTTM: fact(3.56, at("Finnhub basic financials", "USD")),
    range52w: fact({ low: 86.6, high: 195.6 }, at("Finnhub basic financials", "USD")),
    revenueTTM: fact(165e9, at("SEC EDGAR (last four quarters)", "USD")),
    netIncomeTTM: fact(86e9, at("SEC EDGAR (last four quarters)", "USD")),
    fcfTTM: fact(72e9, at("Computed: operating cash flow − capex (TTM)", "USD")),
    cashAndSTI: fact(56e9, at("SEC EDGAR balance sheet", "USD")),
    debt: fact(8.5e9, at("SEC EDGAR balance sheet", "USD")),
    beta: fact(1.2, at("Finnhub basic financials")),
    dividendYield: fact(0.02, at("Finnhub basic financials", "%")),
    nextEarnings: fact({ date: "2026-11-18", estimated: true }, at("Finnhub earnings calendar")),
    streetTarget: fact(225, { ...at("Finnhub price target", "USD"), note: "Mean of 40 analysts" }),
    score: fact(
      { total: r.score, grade: grade(r.score), pillars: r.pillars, confidence: r.confidence, coverage: r.coverage, peerPremiumPct: peerPremiumPct(inputs), version: SCORE_VERSION },
      at("Finava Score v2 (15 factors)")
    ),
    dcf: fact(
      {
        fairValue: inputs.dcfFair ?? 215, wacc: 0.1, growth: 0.08, terminal: TERMINAL_GROWTH, version: DCF_VERSION,
        inputs: { baseFcf: 72e9, fcfIsProxy: false, sharesOutstanding: 24.4e9, netDebt: -47.5e9, historicalGrowth: 0.3, suggestedWacc: 0.1, currentPrice: 182.5, currency: "USD" },
      },
      at("Finava DCF on SEC EDGAR filings", "USD")
    ),
    dropped: [],
    ...over,
  };
}
