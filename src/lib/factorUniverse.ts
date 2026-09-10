// Shared, in-process memo of the computed factor universe.
//
// `computeFactorUniverse()` fans out across ~500 tickers (a 12-wide Polygon
// fundamentals pool + 8-wide Finnhub/Alpaca analyst+price pools) — a cold run is
// expensive. Both the Research board (/api/research/factors) and the chat
// discovery scout need the same 503-name scored universe, so they MUST share one
// cache, or a Discover request could trigger a second cold compute alongside a
// Research poll and double the upstream burst.
//
// This lifts the cache/inflight/TTL memo that used to live in the factors route
// into one place. Concurrent cold callers collapse onto a single computation.

import { computeFactorUniverse, type FactorUniverse } from "@/lib/factors";

const TTL_MS = 15 * 60 * 1000;

// Kept on globalThis so the memo survives Next's dev HMR module reloads (otherwise
// every edit would drop the cache and re-trigger a cold 500-name compute).
const g = globalThis as typeof globalThis & {
  __factorUniverse?: { at: number; data: FactorUniverse } | null;
  __factorUniverseInflight?: Promise<FactorUniverse> | null;
};

/**
 * The factor universe, memoised for 15 minutes. Returns a warm cache instantly;
 * collapses concurrent cold requests onto a single `computeFactorUniverse()` call.
 */
export async function getFactorUniverse(): Promise<FactorUniverse> {
  const cache = g.__factorUniverse;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!g.__factorUniverseInflight) {
    g.__factorUniverseInflight = computeFactorUniverse()
      .then((data) => {
        g.__factorUniverse = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        g.__factorUniverseInflight = null;
      });
  }
  return g.__factorUniverseInflight;
}
