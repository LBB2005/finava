// Raw source payloads → the non-derived facts. Pure: no I/O, so every rule about
// sources, as-of and missing-value notes is tested here without mocks.
import type { TickerSnapshot } from "@/lib/finnhub";
import {
  extractBalanceSnapshot, extractQuarterlyFundamentals, ttmFromQuarters,
  extractCurrentSharesOutstanding, type BalanceSnapshot, type TtmTotal,
} from "@/lib/edgar";
import type { NextEarnings } from "@/agents/sub-agents/earnings-agent";
import { extractDcfBase, type DcfBase } from "@/lib/finavaInputs";
import { fact, missing, type Fact, type TickerFacts } from "./types";

export type SourceName = "quote" | "metric" | "edgar" | "earnings" | "target" | "derived";
export type SourceError = "timeout" | "error";
export type Loaded<T> = { value: T; at: number } | null;

export const SRC = {
  quote: "Finnhub quote",
  metric: "Finnhub basic financials",
  edgarTtm: "SEC EDGAR (last four quarters)",
  edgarBalance: "SEC EDGAR balance sheet",
  edgarShares: "SEC EDGAR cover page",
  earnings: "Finnhub earnings calendar",
  target: "Finnhub price target",
  pe: "Computed: price ÷ EPS (TTM)",
  marketCap: "Computed: price × shares outstanding",
  evEbitda: "Computed: enterprise value ÷ EBITDA (TTM)",
  fcf: "Computed: operating cash flow − capex (TTM)",
  score: "Finava Score v2 (15 factors)",
  dcf: "Finava DCF on SEC EDGAR filings",
} as const;

export interface EdgarSnapshot {
  hasFilings: boolean;
  balance: BalanceSnapshot | null;
  revenueTTM: TtmTotal | null;
  netIncomeTTM: TtmTotal | null;
  ocfTTM: TtmTotal | null;
  capexTTM: TtmTotal | null;
  shares: { shares: number; asOf: string } | null;
  dcfBase: DcfBase | null;
}

/** Small, cacheable extract of a companyfacts payload (never cache the multi-MB JSON). */
export function snapshotEdgar(companyFacts: unknown): EdgarSnapshot {
  if (!companyFacts) {
    return { hasFilings: false, balance: null, revenueTTM: null, netIncomeTTM: null, ocfTTM: null, capexTTM: null, shares: null, dcfBase: null };
  }
  const q = extractQuarterlyFundamentals(companyFacts, 8);
  return {
    hasFilings: true,
    balance: extractBalanceSnapshot(companyFacts),
    revenueTTM: ttmFromQuarters(q.revenue),
    netIncomeTTM: ttmFromQuarters(q.netIncome),
    ocfTTM: ttmFromQuarters(q.operatingCashFlow),
    capexTTM: ttmFromQuarters(q.capex),
    shares: extractCurrentSharesOutstanding(companyFacts),
    dcfBase: extractDcfBase(companyFacts),
  };
}

export interface FastSources {
  quote: Loaded<TickerSnapshot>;
  metric: Loaded<Record<string, unknown>>;
  edgar: Loaded<EdgarSnapshot>;
  earnings: Loaded<NextEarnings | null>;
  target: Loaded<{ targetMean?: number | null; numberOfAnalysts?: number | null }>;
  errors: Partial<Record<SourceName, SourceError>>;
}

export type FastFacts = Omit<TickerFacts, "ticker" | "score" | "dcf" | "dropped">;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (ms: number) => new Date(ms).toISOString();

/** Why a source-backed value is absent, in user-facing words. */
export function absentNote(err: SourceError | undefined, fallback: string): string {
  if (err === "timeout") return "Not retrieved in time";
  if (err === "error") return "Source unavailable right now";
  return fallback;
}

export function quoteFacts(q: Loaded<TickerSnapshot>, errors: FastSources["errors"]): Pick<FastFacts, "price" | "change1d"> {
  if (!q) {
    const note = absentNote(errors.quote, "No quote returned");
    const asOf = new Date().toISOString();
    return { price: missing(SRC.quote, note, asOf), change1d: missing(SRC.quote, note, asOf) };
  }
  return {
    price: fact(num(q.value.price), { source: SRC.quote, asOf: q.value.asOf, unit: "USD" }),
    change1d: fact(num(q.value.changePct), { source: SRC.quote, asOf: q.value.asOf, unit: "%" }),
  };
}

export function buildFastFacts(_ticker: string, s: FastSources): FastFacts {
  const now = new Date().toISOString();
  const { price, change1d } = quoteFacts(s.quote, s.errors);

  // ── Finnhub basic financials ──
  const m = s.metric?.value ?? null;
  const mAsOf = s.metric ? iso(s.metric.at) : now;
  const mNote = absentNote(s.errors.metric, "Not reported by the source");
  const fromMetric = (v: number | null, unit?: string, period?: string): Fact<number> =>
    m ? fact(v, { source: SRC.metric, asOf: mAsOf, unit, period, missingNote: "Not reported by the source" }) : missing(SRC.metric, mNote, mAsOf);
  const epsTTM = fromMetric(m ? num(m.epsTTM) ?? num(m.epsBasicExclExtraItemsTTM) : null, "USD", "TTM");
  const beta = fromMetric(m ? num(m.beta) : null);
  const dividendYield = fromMetric(m ? num(m.dividendYieldIndicatedAnnual) ?? num(m.currentDividendYieldTTM) : null, "%");
  const lo = m ? num(m["52WeekLow"]) : null;
  const hi = m ? num(m["52WeekHigh"]) : null;
  const range52w: Fact<{ low: number; high: number }> = m
    ? fact(lo != null && hi != null ? { low: lo, high: hi } : null, { source: SRC.metric, asOf: mAsOf, unit: "USD", missingNote: "Not reported by the source" })
    : missing(SRC.metric, mNote, mAsOf);

  // ── SEC EDGAR ──
  const e = s.edgar?.value ?? null;
  const eFetched = s.edgar ? iso(s.edgar.at) : now;
  const eNote = !s.edgar ? absentNote(s.errors.edgar, "Filings unavailable") : !e?.hasFilings ? "No SEC filings for this symbol" : null;
  const ttm = (t: TtmTotal | null | undefined, why: string): Fact<number> =>
    eNote ? missing(SRC.edgarTtm, eNote, eFetched)
      : t ? fact(t.value, { source: SRC.edgarTtm, asOf: t.to, unit: "USD", period: `${t.from} to ${t.to}` })
      : missing(SRC.edgarTtm, why, eFetched);
  const revenueTTM = ttm(e?.revenueTTM, "Last four quarters not consecutive in filings");
  const netIncomeTTM = ttm(e?.netIncomeTTM, "Last four quarters not consecutive in filings");
  let fcfTTM: Fact<number>;
  if (eNote) fcfTTM = missing(SRC.fcf, eNote, eFetched);
  else if (!e?.ocfTTM) fcfTTM = missing(SRC.fcf, "Operating cash flow not available for the last four quarters", eFetched);
  else if (!e.capexTTM) fcfTTM = missing(SRC.fcf, "Capital expenditure not tagged in filings", eFetched);
  else fcfTTM = fact(e.ocfTTM.value - e.capexTTM.value, { source: SRC.fcf, asOf: e.ocfTTM.to, unit: "USD", period: `${e.ocfTTM.from} to ${e.ocfTTM.to}` });
  const bal = (v: number | null | undefined): Fact<number> =>
    eNote ? missing(SRC.edgarBalance, eNote, eFetched)
      : fact(v ?? null, { source: SRC.edgarBalance, asOf: e?.balance?.asOf ?? eFetched, unit: "USD", missingNote: "Not tagged on the latest balance sheet" });
  const cashAndSTI = bal(e?.balance?.cashAndShortTermInvestments);
  const debt = bal(e?.balance?.totalDebt);

  // ── Shares & market cap: filings first, Finnhub second ──
  const finnhubShares = m && num(m.shareOutstanding) != null ? (m.shareOutstanding as number) * 1e6 : null;
  const sharesOut: Fact<number> = e?.shares
    ? fact(e.shares.shares, { source: SRC.edgarShares, asOf: e.shares.asOf, unit: "shares" })
    : finnhubShares != null
      ? fact(finnhubShares, { source: SRC.metric, asOf: mAsOf, unit: "shares" })
      : missing(SRC.edgarShares, eNote ?? "Share count not reported", eFetched);
  const finnhubCap = m && num(m.marketCapitalization) != null ? (m.marketCapitalization as number) * 1e6 : null;
  const marketCap: Fact<number> = price.value != null && sharesOut.value != null
    ? fact(price.value * sharesOut.value, { source: SRC.marketCap, asOf: price.asOf, unit: "USD" })
    : finnhubCap != null
      ? fact(finnhubCap, { source: SRC.metric, asOf: mAsOf, unit: "USD" })
      : missing(SRC.marketCap, "Needs a price and a share count", now);

  // ── Derived multiples ──
  let pe: Fact<number>;
  if (price.value == null || epsTTM.value == null) pe = missing(SRC.pe, "Needs both a price and EPS (TTM)", price.asOf);
  else if (epsTTM.value <= 0) pe = missing(SRC.pe, "Loss-making over the last twelve months; P/E not meaningful", price.asOf);
  else pe = fact(price.value / epsTTM.value, { source: SRC.pe, asOf: price.asOf, unit: "x", period: "TTM" });

  const ebitdaPerShare = m ? num(m.ebitdPerShareTTM) : null;
  let evEbitda: Fact<number>;
  if (marketCap.value == null || debt.value == null || cashAndSTI.value == null || ebitdaPerShare == null || sharesOut.value == null) {
    evEbitda = missing(SRC.evEbitda, "Needs market cap, debt, cash and EBITDA", now);
  } else if (ebitdaPerShare <= 0) {
    evEbitda = missing(SRC.evEbitda, "EBITDA is negative; EV/EBITDA not meaningful", now);
  } else {
    const ev = marketCap.value + debt.value - cashAndSTI.value;
    evEbitda = fact(ev / (ebitdaPerShare * sharesOut.value), { source: SRC.evEbitda, asOf: marketCap.asOf, unit: "x", period: "TTM" });
  }

  // ── Calendar & Street ──
  const nextEarnings: TickerFacts["nextEarnings"] = !s.earnings
    ? missing(SRC.earnings, absentNote(s.errors.earnings, "No earnings date scheduled"), now)
    : s.earnings.value
      ? fact(
          { date: s.earnings.value.date, estimated: s.earnings.value.estimated, ...(s.earnings.value.epsEstimate != null ? { epsEst: s.earnings.value.epsEstimate } : {}) },
          { source: SRC.earnings, asOf: iso(s.earnings.at) }
        )
      : missing(SRC.earnings, "No earnings date in the next 120 days", iso(s.earnings.at));

  const tv = s.target?.value;
  const tMean = tv ? num(tv.targetMean) : null;
  const streetTarget: Fact<number> = !s.target
    ? missing(SRC.target, absentNote(s.errors.target, "No Street target"), now)
    : tMean != null && tMean > 0
      ? fact(tMean, { source: SRC.target, asOf: iso(s.target.at), unit: "USD", note: num(tv?.numberOfAnalysts) != null ? `Mean of ${tv!.numberOfAnalysts} analysts` : undefined })
      : missing(SRC.target, "No analyst price target for this symbol", iso(s.target.at));

  return {
    price, change1d, marketCap, sharesOut, pe, evEbitda, epsTTM, range52w,
    revenueTTM, netIncomeTTM, fcfTTM, cashAndSTI, debt, beta, dividendYield, nextEarnings, streetTarget,
  };
}
