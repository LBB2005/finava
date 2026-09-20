import type { NextResponse } from "next/server";
import { requireAuth } from "@/lib/requireAuth";
import { userRateLimit, type RateLimitOptions } from "@/lib/rateLimit";

/**
 * Gate for the market-data routes (quotes, facts, the stock bundle, candles, …).
 *
 * The data they serve is public, but every uncached call spends a SHARED upstream
 * quota — Finnhub's per-minute key, SEC EDGAR's 10 req/s, Alpaca — and the score
 * compute can also spend model money (Grok sentiment). While these routes were
 * anonymous, one crafted request could drain the Finnhub key and blank market
 * data for every user, and a per-IP limit couldn't stop it: a single request was
 * already over the global budget. Only signed-in pages call them, so they now
 * require a session (which also puts them behind the private-beta gate) and are
 * rate-limited per USER rather than per IP.
 */
export async function guardDataRoute(
  route: string,
  opts?: RateLimitOptions
): Promise<{ userId: string; error?: never } | { userId?: never; error: NextResponse }> {
  const auth = await requireAuth();
  if (auth.error) return { error: auth.error };
  const limited = await userRateLimit(auth.userId, route, opts);
  if (limited) return { error: limited };
  return { userId: auth.userId };
}
