// The arithmetic the model used to do in its head, done once in code.
//
// The 13–14 Sep fact-check found the feeds right and the model's own maths
// wrong (a Pfizer CEO's $1.0M buy written as $10.3M). Every comparison an
// answer tends to make — distance from the 52-week high, a position's dollar
// downside, an insider's buy total — is computed here so the prompt can hand it
// over as a fact to quote, never a calculation to attempt. Pure; client-safe.

import { fact, missing, type Fact } from "./types";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** SEC EDGAR's Form 4 index for a symbol (EDGAR resolves tickers in the CIK field). */
export function form4Url(ticker: string): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker.toUpperCase())}&type=4&owner=include&count=40`;
}

/** SEC EDGAR's periodic-filings index (10-K, 10-Q) for a symbol. */
export function edgarFilingsUrl(ticker: string): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker.toUpperCase())}&type=10-&owner=include&count=40`;
}

/** Percent distance of `value` from `reference` (−10 = 10% below). */
export function pctChange(value: number | null | undefined, reference: number | null | undefined): number | null {
  if (!finite(value) || !finite(reference) || reference === 0) return null;
  return (value / reference - 1) * 100;
}

export interface PositionShock {
  /** The price fall, as a positive percent (10 = −10%). */
  shockPct: number;
  /** Dollar change in the position, negative. */
  loss: number;
  valueAfter: number;
}

export const SHOCKS_PCT = [10, 20, 30] as const;

/** A position's dollar downside if its price falls 10/20/30%. */
export function positionShocks(marketValue: number | null | undefined): PositionShock[] {
  if (!finite(marketValue)) return [];
  return SHOCKS_PCT.map((shockPct) => {
    const loss = -marketValue * (shockPct / 100);
    return { shockPct, loss, valueAfter: marketValue + loss };
  });
}

/** Today's weight minus the weight at cost, in percentage points. Weights are fractions. */
export function weightChangePts(weightNow: number | null | undefined, weightAtCost: number | null | undefined): number | null {
  if (!finite(weightNow) || !finite(weightAtCost)) return null;
  return (weightNow - weightAtCost) * 100;
}

// ── Insider transactions ─────────────────────────────────────────────────────

/** One row of Finnhub's /stock/insider-transactions. */
export interface InsiderRow {
  name?: string;
  /** Signed share change. */
  change?: number;
  share?: number;
  transactionPrice?: number;
  transactionDate?: string;
  /** Form 4 code: P open-market purchase, S open-market sale. */
  transactionCode?: string;
}

export interface InsiderTrade {
  name: string;
  shares: number;
  price: number;
  value: number;
  date: string;
}

export interface InsiderSummary {
  buys: { count: number; value: number };
  sells: { count: number; value: number };
  largestBuy: InsiderTrade | null;
  /** The dates the rows actually cover. Null when no row is dated. */
  window: { from: string; to: string } | null;
  undatedExcluded: number;
}

/** Open-market buy and sell totals (shares × price) over the dated rows. */
export function insiderSummary(rows: InsiderRow[]): InsiderSummary {
  const dated = rows.filter((r) => typeof r.transactionDate === "string" && r.transactionDate);
  const dates = dated.map((r) => r.transactionDate!).sort();
  const trade = (r: InsiderRow): InsiderTrade => {
    const shares = Math.abs(finite(r.change) ? r.change : 0);
    const price = finite(r.transactionPrice) ? r.transactionPrice : 0;
    return { name: r.name ?? "Unnamed insider", shares, price, value: shares * price, date: r.transactionDate! };
  };
  const buys = dated.filter((r) => r.transactionCode === "P").map(trade).filter((t) => t.value > 0);
  const sells = dated.filter((r) => r.transactionCode === "S").map(trade).filter((t) => t.value > 0);
  const sum = (ts: InsiderTrade[]) => ts.reduce((a, t) => a + t.value, 0);
  return {
    buys: { count: buys.length, value: sum(buys) },
    sells: { count: sells.length, value: sum(sells) },
    largestBuy: buys.reduce<InsiderTrade | null>((best, t) => (!best || t.value > best.value ? t : best), null),
    window: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    undatedExcluded: rows.length - dated.length,
  };
}

export interface InsiderFacts {
  ticker: string;
  buyTotal: Fact<number>;
  sellTotal: Fact<number>;
  buyCount: Fact<number>;
  sellCount: Fact<number>;
  largestBuy: Fact<InsiderTrade>;
}

export const INSIDER_SOURCE = "Finnhub insider transactions (SEC Form 4)";

/** A Finnhub insider-transactions payload as facts. `raw` null = the feed failed. */
export function insiderFacts(rawTicker: string, raw: { data?: InsiderRow[] } | null, asOf: string): InsiderFacts {
  const ticker = rawTicker.trim().toUpperCase();
  const url = form4Url(ticker);
  if (!raw) {
    const gone = <T,>() => ({ ...missing<T>(INSIDER_SOURCE, "Insider feed unavailable right now", asOf), url });
    return { ticker, buyTotal: gone(), sellTotal: gone(), buyCount: gone(), sellCount: gone(), largestBuy: gone() };
  }
  const s = insiderSummary(Array.isArray(raw.data) ? raw.data : []);
  const period = s.window ? `${s.window.from} to ${s.window.to}` : undefined;
  const note = s.undatedExcluded ? `${s.undatedExcluded} undated rows excluded` : undefined;
  const meta = { source: INSIDER_SOURCE, asOf, period, url, note };
  return {
    ticker,
    buyTotal: fact(s.buys.value, { ...meta, unit: "USD" }),
    sellTotal: fact(s.sells.value, { ...meta, unit: "USD" }),
    buyCount: fact(s.buys.count, meta),
    sellCount: fact(s.sells.count, meta),
    largestBuy: s.largestBuy
      ? fact(s.largestBuy, { ...meta, unit: "USD", asOf: s.largestBuy.date })
      : { ...missing<InsiderTrade>(INSIDER_SOURCE, "No open-market purchases in the rows returned", asOf), url },
  };
}
