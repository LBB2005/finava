import { fetchWithRetry } from "@/lib/fetchRetry";

const BASE = "https://api.polygon.io";
const KEY = process.env.POLYGON_API_KEY;

async function polyFetch(path: string, revalidate = 30) {
  const sep = path.includes("?") ? "&" : "?";
  // Retry transient 429/5xx/network blips before giving up (see fetchWithRetry).
  const res = await fetchWithRetry(`${BASE}${path}${sep}apiKey=${KEY}`, { next: { revalidate } });
  if (!res.ok) throw new Error(`Polygon ${res.status}: ${path}`);
  return res.json();
}

export interface TickerSnapshot {
  ticker: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  timestamp: number;
}

export async function getSnapshots(tickers: string[]): Promise<TickerSnapshot[]> {
  if (!tickers.length) return [];
  const data = await polyFetch(
    `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(",")}`
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data.tickers ?? []).map((t: any) => ({
    ticker: t.ticker,
    price: t.day?.c ?? t.lastTrade?.p ?? 0,
    change: t.todaysChange ?? 0,
    changePct: t.todaysChangePerc ?? 0,
    volume: t.day?.v ?? 0,
    timestamp: t.updated ?? Date.now(),
  }));
}

export async function getAggregates(
  ticker: string,
  multiplier: number,
  timespan: string,
  from: string,
  to: string
) {
  return polyFetch(
    `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=500`
  );
}

export async function getTickerDetails(ticker: string) {
  return polyFetch(`/v3/reference/tickers/${encodeURIComponent(ticker)}`);
}

export async function getNews(tickers: string[], limit = 20) {
  const tickerParam = tickers.map((t) => `ticker=${encodeURIComponent(t)}`).join("&");
  return polyFetch(`/v2/reference/news?${tickerParam}&limit=${limit}&order=desc&sort=published_utc`);
}

export async function getFinancials(ticker: string) {
  return polyFetch(`/vX/reference/financials?ticker=${encodeURIComponent(ticker)}&timeframe=annual&limit=4`);
}

// Annual financials for factor scoring. Cached 1h — these come from 10-K/10-Q
// filings and never change intraday, so a short TTL would re-hammer the API on
// every research-page refresh across the whole S&P 500.
export async function getAnnualFinancials(ticker: string) {
  return polyFetch(`/vX/reference/financials?ticker=${encodeURIComponent(ticker)}&timeframe=annual&limit=4`, 3600);
}

export async function getOptionsSnapshot(ticker: string) {
  return polyFetch(`/v3/snapshot/options/${encodeURIComponent(ticker)}?limit=250`);
}

export async function getMarketSnapshot() {
  // SPY + major sector ETFs for macro context
  const etfs = ["SPY", "QQQ", "IWM", "XLK", "XLF", "XLV", "XLE", "XLY", "XLI", "XLP"];
  return getSnapshots(etfs);
}
