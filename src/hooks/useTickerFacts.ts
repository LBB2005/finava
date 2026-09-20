"use client";
// The one client read of the facts layer. Two SWR keys: a cache-only read that
// paints fast, and the full read that computes score/DCF on a miss. Callers get
// whichever is freshest. Slim is the list-row read (cache-only, batched).
import { useMemo } from "react";
import useSWR from "swr";
import { authFetch } from "@/lib/authFetch";
import type { TickerFacts, TickerFactsSlim } from "@/lib/facts/types";

const json = (url: string) =>
  authFetch(url).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
    return body;
  });

const OPTS = { revalidateOnFocus: false, shouldRetryOnError: false } as const;

export function useTickerFacts(ticker: string | null) {
  const sym = ticker ? ticker.toUpperCase() : null;
  const base = sym ? `/api/facts/${encodeURIComponent(sym)}` : null;
  const quick = useSWR<TickerFacts>(base ? `${base}?cachedOnly=1` : null, json, { ...OPTS, dedupingInterval: 60_000 });
  const full = useSWR<TickerFacts>(base, json, { ...OPTS, dedupingInterval: 300_000 });
  const data = full.data ?? quick.data;
  return {
    data,
    error: !data ? (full.error as Error | undefined) ?? (quick.error as Error | undefined) : undefined,
    isLoading: !data && (quick.isLoading || full.isLoading),
    /** The full read (score/DCF) is still running. */
    computing: !full.data && !full.error && !!base,
  };
}

export function useTickerFactsSlim(tickers: string[]) {
  const syms = useMemo(() => [...new Set(tickers.map((t) => t.toUpperCase()))].sort().slice(0, 50), [tickers]);
  const key = syms.length ? `/api/facts?tickers=${syms.join(",")}` : null;
  const r = useSWR<{ facts: TickerFactsSlim[] }>(key, json, { ...OPTS, dedupingInterval: 60_000 });
  const map = useMemo(() => new Map((r.data?.facts ?? []).map((f) => [f.ticker, f])), [r.data]);
  return { map, isLoading: r.isLoading };
}
