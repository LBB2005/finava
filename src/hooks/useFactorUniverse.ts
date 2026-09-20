"use client";
import useSWR from "swr";
import { authFetch } from "@/lib/authFetch";
import type { Stock } from "@/lib/research";

interface FactorResponse {
  stocks: Stock[];
  asOf: string;
  coverage: { total: number; fundamentals: number; analyst: number; momentum: number; priced: number };
}

const fetcher = (url: string) =>
  authFetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

/**
 * The full S&P 500 scored on all six Finava factors from real data (Polygon
 * fundamentals, Alpaca momentum, Finnhub analyst). Computed server-side and
 * memoised there; we refresh every 5 minutes so analyst coverage fills in as
 * the upstream cache warms. Returns null until real scores arrive — callers
 * must render a loading or unavailable state rather than substituting rows.
 */
export function useFactorUniverse() {
  const { data, error, isLoading, mutate } = useSWR<FactorResponse>(
    "/api/research/factors",
    fetcher,
    {
      refreshInterval: 5 * 60 * 1000,
      revalidateOnFocus: false,
      dedupingInterval: 60_000,
      keepPreviousData: true,
    }
  );

  return {
    universe: data?.stocks ?? null,
    coverage: data?.coverage ?? null,
    asOf: data?.asOf ?? null,
    error,
    isLoading,
    loaded: !!data,
    retry: () => mutate(),
  };
}
