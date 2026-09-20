"use client";
import useSWR from "swr";
import { authFetch } from "@/lib/authFetch";
import { useMemo } from "react";
import type { LiveRow } from "@/lib/research";

const fetcher = (url: string) =>
  authFetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

/**
 * Live market data (price, % change, market cap, P/E, avg volume, RVOL) for a
 * set of tickers, keyed by ticker. Refreshes every 30s. The map is memoised on
 * the response so consumers can use it as a stable dependency for `overlayLive`.
 */
export function useLiveBoard(tickers: string[]) {
  const key = tickers.length ? `/api/leaderboard?tickers=${tickers.join(",")}` : null;

  const { data, error, isLoading } = useSWR<{ rows: LiveRow[] }>(key, fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    dedupingInterval: 15_000,
    keepPreviousData: true,
  });

  const liveMap = useMemo(() => {
    const m = new Map<string, LiveRow>();
    (data?.rows ?? []).forEach((r) => m.set(r.ticker, r));
    return m;
  }, [data]);

  return { liveMap, error, isLoading, loaded: !!data };
}
