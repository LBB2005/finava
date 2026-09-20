"use client";
import useSWR from "swr";
import { authFetch } from "@/lib/authFetch";

export interface OgResult {
  image: string | null;
  domain: string | null;
}

/** Resolve accurate per-article thumbnails + publisher domains for the given
 *  news URLs via /api/og-image. Returns a map keyed by the original URL; entries
 *  fill in as the scrape completes (the UI falls back to the Finnhub image and a
 *  favicon until then). */
export function useNewsImages(urls: string[]): Record<string, OgResult> {
  const key = urls.length ? `ogimg:${urls.join("|")}` : null;
  const { data } = useSWR<Record<string, OgResult>>(
    key,
    async () => {
      const res = await authFetch("/api/og-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      if (!res.ok) return {};
      const body = await res.json().catch(() => ({}));
      return (body?.results ?? {}) as Record<string, OgResult>;
    },
    { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 600_000 }
  );
  return data ?? {};
}
