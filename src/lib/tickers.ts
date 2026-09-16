/**
 * Ticker symbol validation shared by API routes.
 *
 * Letters first, then letters/digits/dot/dash (BRK.B, BF-B, RDS.A). Keeps junk
 * out of Firestore docs and the agent cache, where an invalid symbol would
 * otherwise be stored and re-fetched forever.
 */
export const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export function isValidTicker(symbol: string): boolean {
  return TICKER_RE.test(symbol);
}

/** Max tickers accepted by batch quote endpoints in a single request. */
export const MAX_BATCH_TICKERS = 50;

/**
 * Parse a comma-separated `tickers` query param into validated upper-case
 * symbols. Invalid symbols are dropped rather than rejected so one bad entry
 * in a watchlist doesn't take down the whole quote refresh.
 */
export function parseTickersParam(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t && isValidTicker(t));
}

// ── Free-text ticker extraction ──────────────────────────────────────────────

const TICKER_BLOCKLIST = new Set([
  "AI", "US", "PE", "YTD", "CEO", "CFO", "CTO", "COO", "AND", "THE", "FOR",
  "ETF", "IPO", "SEC", "FCF", "EPS", "RSI", "DCF", "SMA", "EMA", "MACD",
  "GDP", "CPI", "FED", "IMF", "USD", "EUR", "GBP", "BTC", "ETH", "NFT",
  "LTM", "TTM", "NTM", "LBO", "DCF", "IRR", "NPV", "ROE", "ROA", "ROI",
  "WACC", "EBIT", "EBITDA", "GAAP", "CAGR", "OTC", "NYSE", "NASDAQ",
  "ATH", "ATL", "AUM", "NAV", "VIX", "SPX", "TBD", "N/A", "NA",
]);

/**
 * Extract likely stock ticker symbols from a block of text.
 * Matches 2-5 uppercase letter sequences (with optional leading $).
 * Filters common English abbreviations and financial terms.
 *
 * Lives here rather than in `agentMemory` (which imports firebase-admin at
 * module load) so client components and the Auto-mode router can call it.
 */
export function extractTickers(text: string): string[] {
  const matches = text.match(/\b\$?([A-Z]{2,5})\b/g) ?? [];
  return [
    ...new Set(
      matches
        .map((t) => t.replace(/^\$/, ""))
        .filter((t) => !TICKER_BLOCKLIST.has(t))
    ),
  ];
}
