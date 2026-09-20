"use client";
import useSWR from "swr";
import { authFetch } from "@/lib/authFetch";
import type { Quote } from "@/types/portfolio";
import { MAX_BATCH_TICKERS } from "@/lib/tickers";

// The API caps each request at MAX_BATCH_TICKERS, so larger lists are fetched
// in chunks and stitched back together.
const fetcher = async (key: string): Promise<Quote[]> => {
  const tickers = key.replace("quotes:", "").split(",").filter(Boolean);
  const chunks: string[][] = [];
  for (let i = 0; i < tickers.length; i += MAX_BATCH_TICKERS) {
    chunks.push(tickers.slice(i, i + MAX_BATCH_TICKERS));
  }
  const results = await Promise.all(
    chunks.map((chunk) =>
      authFetch(`/api/quotes?tickers=${chunk.join(",")}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Quote[]>;
      })
    )
  );
  return results.flat();
};

export function useQuotes(tickers: string[]) {
  const key = tickers.length > 0 ? `quotes:${tickers.join(",")}` : null;

  const { data, error, isLoading } = useSWR<Quote[]>(key, fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
  });

  const quoteMap = new Map<string, Quote>();
  (data ?? []).forEach((q) => quoteMap.set(q.ticker, q));

  return { quoteMap, error, isLoading };
}
