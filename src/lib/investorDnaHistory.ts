/**
 * Investor DNA: each position's holding window, measured from daily closes.
 *
 * The window starts at the real purchase date (`acquiredAt`) when a source
 * provides one, otherwise the day the holding was added to Finava. On that
 * fallback the position is priced from that day's close, not from `avgCost`,
 * so the stock and the benchmark always cover the same window.
 *
 * No price history means `null`, never an estimate. There is no point-in-time
 * factor store yet, so `entryFactors` is always `null` and the engine labels
 * every trait "based on current factors".
 */

import { normalizeTicker, type DnaHolding, type PositionHistory } from "@/lib/investorDna";
import type { Stock } from "@/lib/research";

export const BENCHMARK = "SPY";

/** GICS sector → SPDR sector ETF. */
export const SECTOR_ETF: Record<string, string> = {
  "Information Technology": "XLK",
  "Financials": "XLF",
  "Health Care": "XLV",
  "Energy": "XLE",
  "Consumer Discretionary": "XLY",
  "Industrials": "XLI",
  "Consumer Staples": "XLP",
  "Utilities": "XLU",
  "Materials": "XLB",
  "Real Estate": "XLRE",
  "Communication Services": "XLC",
};

/** Daily bars: `t` in epoch seconds (ascending), `c` closes. */
export interface DailyCloses {
  t: number[];
  c: number[];
}

export interface HistoryDeps {
  dailyCloses: (ticker: string, fromSec: number, toSec: number) => Promise<DailyCloses>;
  now?: Date;
}

const PAD_SEC = 7 * 86_400;
const FETCH_CONCURRENCY = 6;

/** The close in effect at `atSec`: the last bar at or before it, else the first after. */
function closeAt(s: DailyCloses | null, atSec: number): number | null {
  if (!s || s.c.length === 0) return null;
  let idx = -1;
  for (let i = 0; i < s.t.length; i++) {
    if (s.t[i] <= atSec) idx = i;
    else break;
  }
  const v = s.c[idx === -1 ? 0 : idx];
  return Number.isFinite(v) && v > 0 ? v : null;
}

function lastClose(s: DailyCloses | null): number | null {
  if (!s || s.c.length === 0) return null;
  const v = s.c[s.c.length - 1];
  return Number.isFinite(v) && v > 0 ? v : null;
}

const pctChange = (from: number | null, to: number | null) =>
  from !== null && to !== null && from > 0 ? ((to - from) / from) * 100 : null;

/** Resolve a holding window per covered stock position, keyed by the holding's ticker. */
export async function resolvePositionHistory(
  holdings: DnaHolding[],
  universe: Stock[],
  deps: HistoryDeps,
): Promise<Record<string, PositionHistory>> {
  const nowSec = Math.floor((deps.now ?? new Date()).getTime() / 1000);
  const byTicker = new Map(universe.map((s) => [normalizeTicker(s.ticker), s]));

  const positions = holdings.flatMap((h) => {
    if (!(h.shares > 0)) return [];
    const stock = byTicker.get(normalizeTicker(h.ticker));
    const start = h.acquiredAt ?? h.createdAt;
    const startMs = start ? Date.parse(start) : NaN;
    if (!stock || !start || !Number.isFinite(startMs)) return [];
    return [{ h, stock, start, startSec: Math.floor(startMs / 1000), basis: h.acquiredAt ? "purchase" as const : "added" as const }];
  });
  if (positions.length === 0) return {};

  const fromSec = Math.min(...positions.map((p) => p.startSec)) - PAD_SEC;
  const symbols = [...new Set([
    BENCHMARK,
    ...positions.map((p) => p.stock.ticker),
    ...positions.map((p) => SECTOR_ETF[p.stock.sector]).filter(Boolean),
  ])];

  const series = new Map<string, DailyCloses | null>();
  for (let i = 0; i < symbols.length; i += FETCH_CONCURRENCY) {
    await Promise.all(symbols.slice(i, i + FETCH_CONCURRENCY).map(async (sym) => {
      try {
        series.set(sym, await deps.dailyCloses(sym, fromSec, nowSec));
      } catch {
        series.set(sym, null);
      }
    }));
  }

  const spy = series.get(BENCHMARK) ?? null;
  const out: Record<string, PositionHistory> = {};
  for (const p of positions) {
    const own = series.get(p.stock.ticker) ?? null;
    const end = lastClose(own);
    const entry = p.basis === "purchase" ? (p.h.avgCost > 0 ? p.h.avgCost : null) : closeAt(own, p.startSec);
    const etf = SECTOR_ETF[p.stock.sector] ?? null;
    const etfSeries = etf ? series.get(etf) ?? null : null;
    out[p.h.ticker] = {
      windowStart: p.start,
      basis: p.basis,
      returnPct: pctChange(entry, end),
      spyReturnPct: pctChange(closeAt(spy, p.startSec), lastClose(spy)),
      sectorEtf: etf,
      sectorReturnPct: etfSeries ? pctChange(closeAt(etfSeries, p.startSec), lastClose(etfSeries)) : null,
      entryFactors: null,
    };
  }
  return out;
}
