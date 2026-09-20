import type { CandleResponse } from "@/lib/finnhub";

// ── Trading host guard ────────────────────────────────────────────────────────
// The trading API host (paper vs live) is set by ALPACA_BASE_URL. ALL Alpaca
// trading currently runs against ONE shared brokerage account, so order
// MUTATIONS (e.g. cancel) must never reach the live host — a misconfigured
// ALPACA_BASE_URL would otherwise let any entitled user cancel real-money orders
// on the firm account. Mutating routes call isPaperTradingHost() and refuse
// unless the configured host is the paper sandbox.
export const ALPACA_TRADING_BASE =
  process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets";

/**
 * True only when the configured trading host is Alpaca's paper sandbox. An exact
 * hostname match — a substring test also accepted e.g.
 * "https://api.alpaca.markets/?paper-api.alpaca.markets", i.e. the LIVE host.
 */
export function isPaperTradingHost(base: string = ALPACA_TRADING_BASE): boolean {
  try {
    return new URL(base).hostname === "paper-api.alpaca.markets";
  } catch {
    return false;
  }
}

// Alpaca market-data API is always served from data.alpaca.markets, regardless of
// whether trading uses the paper or live host. Keys are the same as the trading API.
const DATA_BASE = "https://data.alpaca.markets";
const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_API_SECRET;
// Free Alpaca accounts only have access to the IEX feed; paid plans may set "sip".
const FEED = process.env.ALPACA_DATA_FEED ?? "iex";

const FETCH_TIMEOUT_MS = 10_000;

// Map a Finnhub-style resolution (1,5,15,30,60,D,W,M) to an Alpaca timeframe.
function resolutionToAlpaca(resolution: string): string {
  switch (resolution) {
    case "D": return "1Day";
    case "W": return "1Week";
    case "M": return "1Month";
    case "60": return "1Hour";
    default: {
      const n = parseInt(resolution, 10);
      return Number.isFinite(n) && n > 0 ? `${n}Min` : "1Day";
    }
  }
}

interface AlpacaBar {
  t: string; // RFC3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function hasAlpacaData(): boolean {
  return Boolean(KEY && SECRET);
}

// Fetch OHLCV bars from Alpaca and reshape into the Finnhub candle format so every
// caller (technical agent, risk agent, backtest) keeps working unchanged.
export async function getAlpacaBars(
  ticker: string,
  resolution: string,
  fromTs: number,
  toTs: number
): Promise<CandleResponse> {
  if (!KEY || !SECRET) {
    return { s: "no_data", c: [], o: [], h: [], l: [], v: [], t: [] };
  }

  const timeframe = resolutionToAlpaca(resolution);
  const start = new Date(fromTs * 1000).toISOString();
  const end = new Date(toTs * 1000).toISOString();

  const headers = {
    "APCA-API-KEY-ID": KEY,
    "APCA-API-SECRET-KEY": SECRET,
  };

  const bars: AlpacaBar[] = [];
  let pageToken: string | undefined;
  // Cap pages so a malformed next_page_token can never loop forever.
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      timeframe,
      start,
      end,
      limit: "10000",
      adjustment: "split",
      feed: FEED,
    });
    if (pageToken) params.set("page_token", pageToken);

    const res = await fetch(
      `${DATA_BASE}/v2/stocks/${encodeURIComponent(ticker)}/bars?${params}`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), next: { revalidate: 30 } }
    );
    if (!res.ok) throw new Error(`Alpaca bars ${res.status}: ${ticker}`);

    const data = (await res.json()) as { bars?: AlpacaBar[]; next_page_token?: string | null };
    if (Array.isArray(data.bars)) bars.push(...data.bars);

    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }

  if (bars.length === 0) {
    return { s: "no_data", c: [], o: [], h: [], l: [], v: [], t: [] };
  }

  return {
    s: "ok",
    c: bars.map((b) => b.c),
    o: bars.map((b) => b.o),
    h: bars.map((b) => b.h),
    l: bars.map((b) => b.l),
    v: bars.map((b) => b.v),
    t: bars.map((b) => Math.floor(new Date(b.t).getTime() / 1000)),
  };
}

// ── Batched, multi-symbol helpers for the research leaderboard ────────────────
// These hit Alpaca's *multi-symbol* endpoints so the whole universe (~75 names)
// costs 1–3 requests instead of one-per-ticker — Finnhub's /quote can't scale to
// that at free-tier rate limits. Prices are IEX (free feed): for liquid S&P 500
// names they track consolidated to within pennies, which is fine for a board.

const AUTH_HEADERS = () => ({
  "APCA-API-KEY-ID": KEY ?? "",
  "APCA-API-SECRET-KEY": SECRET ?? "",
});

export interface AlpacaSnapshot {
  price: number | null;
  prevClose: number | null;
  changePct: number | null;
  dayVolume: number | null;
  /** Today's official opening print. Optional: only the executor needs it, to
      measure slippage against the price the whole market could have had. */
  open?: number | null;
}

// Latest price + prior close + today's (IEX) volume for many symbols in ONE call.
// GET /v2/stocks/snapshots?symbols=...  →  { "AAPL": { latestTrade, dailyBar, prevDailyBar }, ... }
export async function getAlpacaSnapshots(
  tickers: string[]
): Promise<Map<string, AlpacaSnapshot>> {
  const out = new Map<string, AlpacaSnapshot>();
  if (!KEY || !SECRET || tickers.length === 0) return out;

  const params = new URLSearchParams({ symbols: tickers.join(","), feed: FEED });
  const res = await fetch(`${DATA_BASE}/v2/stocks/snapshots?${params}`, {
    headers: AUTH_HEADERS(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    next: { revalidate: 30 },
  });
  if (!res.ok) throw new Error(`Alpaca snapshots ${res.status}`);

  const data = (await res.json()) as Record<
    string,
    {
      latestTrade?: { p?: number };
      dailyBar?: { c?: number; v?: number; o?: number };
      prevDailyBar?: { c?: number };
    }
  >;

  for (const [sym, snap] of Object.entries(data)) {
    const price = snap.latestTrade?.p ?? snap.dailyBar?.c ?? null;
    const prevClose = snap.prevDailyBar?.c ?? null;
    const changePct =
      price != null && prevClose != null && prevClose > 0
        ? ((price - prevClose) / prevClose) * 100
        : null;
    out.set(sym.toUpperCase(), {
      price: typeof price === "number" && price > 0 ? price : null,
      prevClose: typeof prevClose === "number" ? prevClose : null,
      changePct,
      dayVolume: typeof snap.dailyBar?.v === "number" ? snap.dailyBar.v : null,
      open: typeof snap.dailyBar?.o === "number" ? snap.dailyBar.o : null,
    });
  }
  return out;
}

// Trailing N-session average daily (IEX) volume per symbol, for relative-volume.
// Multi-symbol bars: GET /v2/stocks/bars?symbols=...&timeframe=1Day  →
//   { bars: { "AAPL": [ {t,v,...}, ... ] }, next_page_token }
// The IEX scale cancels in today÷avg, so the RVOL ratio is meaningful even
// though IEX absolute volume undercounts consolidated.
export async function getAlpacaAvgVolumes(
  tickers: string[],
  sessions = 10
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!KEY || !SECRET || tickers.length === 0) return out;

  // ~2 calendar days per trading day, plus slack for holidays/weekends.
  const startMs = Date.now() - (sessions + 6) * 2 * 86_400 * 1000;
  const start = new Date(startMs).toISOString();
  const byTicker: Record<string, number[]> = {};
  let pageToken: string | undefined;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      symbols: tickers.join(","),
      timeframe: "1Day",
      start,
      limit: "10000",
      adjustment: "split",
      feed: FEED,
    });
    if (pageToken) params.set("page_token", pageToken);

    const res = await fetch(`${DATA_BASE}/v2/stocks/bars?${params}`, {
      headers: AUTH_HEADERS(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      next: { revalidate: 900 },
    });
    if (!res.ok) throw new Error(`Alpaca bars(multi) ${res.status}`);

    const data = (await res.json()) as {
      bars?: Record<string, { v: number }[]>;
      next_page_token?: string | null;
    };
    for (const [sym, bars] of Object.entries(data.bars ?? {})) {
      (byTicker[sym.toUpperCase()] ??= []).push(...bars.map((b) => b.v));
    }
    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }

  for (const [sym, vols] of Object.entries(byTicker)) {
    // Drop the most recent (current, partial) session, then average the prior N.
    const prior = vols.slice(0, -1).slice(-sessions);
    if (prior.length === 0) continue;
    const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (avg > 0) out.set(sym, avg);
  }
  return out;
}

export interface DailyClose {
  t: number; // Unix seconds
  c: number; // adjusted close
}

// Adjusted daily close history for many symbols, for momentum factors.
// Uses the same multi-symbol bars endpoint as getAlpacaAvgVolumes, so a full
// year of closes for the whole S&P 500 costs only a handful of paginated calls
// rather than one request per ticker. Split-adjusted so returns aren't distorted
// by stock splits. Cached 15min (revalidate) — momentum barely moves intraday.
export async function getAlpacaCloseHistory(
  tickers: string[],
  calendarDays = 400
): Promise<Map<string, DailyClose[]>> {
  const out = new Map<string, DailyClose[]>();
  if (!KEY || !SECRET || tickers.length === 0) return out;

  const start = new Date(Date.now() - calendarDays * 86_400 * 1000).toISOString();
  const byTicker: Record<string, DailyClose[]> = {};
  let pageToken: string | undefined;

  for (let page = 0; page < 40; page++) {
    const params = new URLSearchParams({
      symbols: tickers.join(","),
      timeframe: "1Day",
      start,
      limit: "10000",
      adjustment: "split",
      feed: FEED,
    });
    if (pageToken) params.set("page_token", pageToken);

    const res = await fetch(`${DATA_BASE}/v2/stocks/bars?${params}`, {
      headers: AUTH_HEADERS(),
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: 900 },
    });
    if (!res.ok) throw new Error(`Alpaca bars(history) ${res.status}`);

    const data = (await res.json()) as {
      bars?: Record<string, { t: string; c: number }[]>;
      next_page_token?: string | null;
    };
    for (const [sym, bars] of Object.entries(data.bars ?? {})) {
      (byTicker[sym.toUpperCase()] ??= []).push(
        ...bars.map((b) => ({ t: Math.floor(new Date(b.t).getTime() / 1000), c: b.c }))
      );
    }
    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }

  for (const [sym, closes] of Object.entries(byTicker)) {
    // Bars arrive ascending; keep them sorted defensively across pages.
    closes.sort((a, b) => a.t - b.t);
    if (closes.length) out.set(sym, closes);
  }
  return out;
}
