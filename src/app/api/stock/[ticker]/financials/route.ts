// Quarterly financials + TTM three-statement summary for the stock page's
// Overview (trajectory mini-charts, quarterly ledger table, TTM columns).
// Read-only public filing data (same posture as the bundle/dcf routes): EDGAR
// XBRL quarterly frames + Finnhub quarterly EPS. Missing concepts are null —
// the UI renders "—", never an invented number (Data Accuracy Rule).

import { NextResponse } from "next/server";
import {
  getCikByTicker,
  getCompanyFacts,
  extractQuarterlyFundamentals,
  extractBalanceSnapshot,
  ttmFromQuarters,
  type QuarterlyMetric,
} from "@/lib/edgar";
import { getEarnings } from "@/lib/finnhub";
import { guardDataRoute } from "@/lib/dataRouteGuard";
import { financialsMemo } from "@/lib/responseMemo";
import { isValidTicker } from "@/lib/tickers";

export interface FinancialsQuarter {
  year: number;
  quarter: number; // calendar quarter the fiscal period ends in, 1-4
  /** The fiscal period as filed — an off-calendar quarter is not Jan–Mar. */
  periodStart: string;
  periodEnd: string;
  revenue: number | null;
  revenueYoY: number | null; // fraction, e.g. 0.34
  epsDiluted: number | null;
  grossMargin: number | null; // fraction
  netIncome: number | null;
  fcf: number | null;
}

function ord(year: number, quarter: number): number {
  return year * 4 + (quarter - 1);
}

function toMap(series: QuarterlyMetric[]): Map<number, number> {
  return new Map(series.map((m) => [ord(m.year, m.quarter), m.value]));
}

/** Sum a series' last 4 quarters by end date; null unless they cover a year. */
function ttmSum(series: QuarterlyMetric[]): number | null {
  return ttmFromQuarters(series)?.value ?? null;
}

interface EarningsEntry {
  actual?: number | null;
  period?: string; // fiscal-quarter end date "2026-06-27"
}

/** Map Finnhub EPS actuals onto calendar quarters by their period end date. */
function epsByQuarter(earnings: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(earnings)) return out;
  for (const e of earnings as EarningsEntry[]) {
    if (typeof e?.actual !== "number" || typeof e?.period !== "string") continue;
    const d = new Date(e.period);
    if (Number.isNaN(d.getTime())) continue;
    const q = Math.ceil((d.getUTCMonth() + 1) / 3);
    out.set(ord(d.getUTCFullYear(), q), e.actual);
  }
  return out;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const gate = await guardDataRoute("stock-financials", {
    capacity: 20,
    refillPerSec: 0.5,
  });
  if (gate.error) return gate.error;

  const { ticker } = await params;
  const symbol = (ticker ?? "").trim().toUpperCase();
  // The symbol goes into provider URLs (Finnhub query, Polygon path) and a shared
  // cache key, so it must be a ticker and nothing else — `%26`/`%2F` decode here.
  if (symbol && !isValidTicker(symbol)) {
    return NextResponse.json({ error: "Invalid ticker symbol." }, { status: 400 });
  }
  if (!symbol) return NextResponse.json({ error: "Missing ticker." }, { status: 400 });

  // Served from memory when fresh: the companyfacts file behind this is too big
  // for Next's fetch cache, so every miss is a multi-megabyte SEC download.
  const memoised = financialsMemo.get(symbol);
  if (memoised) return NextResponse.json(memoised);

  let cik: string | null;
  try {
    cik = await getCikByTicker(symbol);
  } catch {
    // SEC unreachable is an outage, not "this company has no filings".
    return NextResponse.json(
      { error: "SEC filings are unavailable right now. Try again shortly." },
      { status: 503 }
    );
  }
  if (!cik) {
    // ETFs / foreign issuers have no XBRL facts — no statement data.
    return NextResponse.json(
      { error: `Financial statements are unavailable for ${symbol} (no SEC filings).` },
      { status: 404 }
    );
  }

  try {
    const [facts, earnings] = await Promise.all([
      getCompanyFacts(cik),
      getEarnings(symbol).catch(() => null),
    ]);

    // 12 quarters extracted so the 8 shown can each compute YoY.
    const q = extractQuarterlyFundamentals(facts, 12);
    const revenue = toMap(q.revenue);
    const grossProfit = toMap(q.grossProfit);
    const costOfRevenue = toMap(q.costOfRevenue);
    const netIncome = toMap(q.netIncome);
    const ocf = toMap(q.operatingCashFlow);
    const capex = toMap(q.capex);
    const eps = epsByQuarter(earnings);

    // Revenue anchors the ledger rows; without any revenue quarters there is
    // nothing to build (404 → UI shows the unavailable state).
    if (q.revenue.length === 0) {
      return NextResponse.json(
        { error: `No quarterly filings found for ${symbol}.` },
        { status: 404 }
      );
    }

    let fcfIsProxy = false;
    const quarters: FinancialsQuarter[] = q.revenue.slice(-8).map((m) => {
      const o = ord(m.year, m.quarter);
      const rev = m.value;
      const priorRev = revenue.get(o - 4);
      const gp =
        grossProfit.get(o) ??
        (costOfRevenue.get(o) != null ? rev - costOfRevenue.get(o)! : null);
      const cf = ocf.get(o);
      let fcf: number | null = null;
      if (cf != null) {
        const cx = capex.get(o);
        if (cx != null) fcf = cf - cx;
        else {
          fcf = cf;
          fcfIsProxy = true;
        }
      }
      return {
        year: m.year,
        quarter: m.quarter,
        periodStart: m.start,
        periodEnd: m.end,
        revenue: rev,
        revenueYoY: priorRev != null && priorRev > 0 ? rev / priorRev - 1 : null,
        epsDiluted: eps.get(o) ?? null,
        grossMargin: gp != null && rev > 0 ? gp / rev : null,
        netIncome: netIncome.get(o) ?? null,
        fcf,
      };
    });

    // ── TTM three-statement summary ───────────────────────────────────────────
    const revenueTTM = ttmSum(q.revenue);
    const grossProfitTTM = ttmSum(q.grossProfit);
    const operatingIncomeTTM = ttmSum(q.operatingIncome);
    const netIncomeTTM = ttmSum(q.netIncome);
    const ocfTTM = ttmSum(q.operatingCashFlow);
    const capexTTM = ttmSum(q.capex);
    const buybacksTTM = ttmSum(q.buybacks);
    const fcfTTM = ocfTTM != null ? ocfTTM - (capexTTM ?? 0) : null;

    // EPS TTM = the 4 most recent quarterly actuals, and only when they are four
    // CONSECUTIVE quarters — a gap would silently sum the wrong window.
    const epsOrds = Array.from(eps.entries()).sort((a, b) => a[0] - b[0]).slice(-4);
    const epsContiguous =
      epsOrds.length === 4 && epsOrds[3][0] - epsOrds[0][0] === 3;
    const epsTTM = epsContiguous ? epsOrds.reduce((a, [, v]) => a + v, 0) : null;

    const balance = extractBalanceSnapshot(facts);
    // Net cash is the whole liquid pile against debt, not just the cash line.
    const liquid = balance.cashAndShortTermInvestments ?? balance.cash;
    const netCash = liquid != null && balance.totalDebt != null ? liquid - balance.totalDebt : null;
    const bookValuePerShare =
      balance.equity != null && balance.sharesOutstanding
        ? balance.equity / balance.sharesOutstanding
        : null;

    const body = {
      ticker: symbol,
      quarters,
      fcfIsProxy,
      ttmPeriod: ttmFromQuarters(q.revenue)
        ? { from: ttmFromQuarters(q.revenue)!.from, to: ttmFromQuarters(q.revenue)!.to }
        : null,
      ttm: {
        income: {
          revenue: revenueTTM,
          grossProfit: grossProfitTTM,
          operatingIncome: operatingIncomeTTM,
          netIncome: netIncomeTTM,
          epsDiluted: epsTTM,
        },
        balance: {
          // Two explicitly different things: cash on hand, and cash plus the
          // current marketable securities most people mean by "the cash pile".
          cash: balance.cash,
          cashAndShortTermInvestments: balance.cashAndShortTermInvestments,
          totalDebt: balance.totalDebt,
          netCash,
          totalAssets: balance.totalAssets,
          bookValuePerShare,
          asOf: balance.asOf,
        },
        cashflow: {
          operatingCF: ocfTTM,
          capex: capexTTM,
          fcf: fcfTTM,
          buybacks: buybacksTTM,
          fcfMargin: fcfTTM != null && revenueTTM ? fcfTTM / revenueTTM : null,
        },
      },
      asOf: new Date().toISOString(),
    };
    financialsMemo.set(symbol, body);
    return NextResponse.json(body);
  } catch (err) {
    console.error("[stock financials]", symbol, err);
    return NextResponse.json(
      { error: `Couldn't load financials for ${symbol}.` },
      { status: 502 }
    );
  }
}
