/**
 * A tiny per-instance memo for finished route responses, bounded by entries and
 * TTL, evicting least-recently-used first.
 *
 * For upstream payloads Next's fetch cache can't hold: SEC companyfacts files are
 * 5–10 MB for large filers, over the 2 MB fetch-cache limit, so every request
 * re-downloaded one from SEC (10 req/s per IP — an IP block there takes out
 * financials, DCF and scores site-wide). Memoising the small finished response
 * instead of the raw file keeps memory bounded.
 */
export function createResponseMemo<T>(opts: { ttlMs: number; maxEntries: number }) {
  const entries = new Map<string, { at: number; value: T }>();
  return {
    get(key: string): T | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at > opts.ttlMs) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key); // refresh recency
      entries.set(key, hit);
      return hit.value;
    },
    set(key: string, value: T): void {
      entries.delete(key);
      if (entries.size >= opts.maxEntries) entries.delete(entries.keys().next().value!);
      entries.set(key, { at: Date.now(), value });
    },
    clear(): void {
      entries.clear();
    },
    get size(): number {
      return entries.size;
    },
  };
}

/** Finished /api/stock/[ticker]/financials bodies. Filings change quarterly. */
export const financialsMemo = createResponseMemo<unknown>({ ttlMs: 6 * 60 * 60 * 1000, maxEntries: 300 });
