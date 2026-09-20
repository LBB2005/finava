"use client";
import useSWR from "swr";
import { authFetch } from "@/lib/authFetch";
import type { StockBundle, ChartRange } from "@/lib/stockData";
import type { CandleResponse } from "@/lib/finnhub";

const jsonFetcher = (url: string) =>
  authFetch(url).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(body?.error ?? `HTTP ${r.status}`) as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    return body;
  });

/** The full per-ticker bundle for first paint. Signed-in callers only (the
 *  route spends shared provider quota); authFetch covers the dev bypass too. */
export function useStockBundle(ticker: string | null) {
  const key = ticker ? `/api/stock/${encodeURIComponent(ticker)}` : null;
  const { data, error, isLoading, mutate } = useSWR<StockBundle>(key, jsonFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  return { bundle: data ?? null, error: error as (Error & { status?: number }) | undefined, isLoading, mutate };
}

/** Candles for a specific range. The default range comes baked into the bundle,
 *  so we only fetch here when the user switches to a non-default timeframe. */
export function useStockCandles(ticker: string | null, range: ChartRange | null) {
  const key =
    ticker && range
      ? `/api/stock/${encodeURIComponent(ticker)}/candles?range=${range}`
      : null;
  const { data, error, isLoading } = useSWR<{ range: ChartRange; candles: CandleResponse | null }>(
    key,
    jsonFetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  return { candles: data?.candles ?? null, error, isLoading };
}
