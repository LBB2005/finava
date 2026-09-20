// Real factor scores for the Research board, computed across the whole
// S&P 500. Server-side, app-level API keys; signed-in callers only (see
// guardDataRoute), mirroring /api/leaderboard.
//
// The heavy upstream calls (Polygon financials, Finnhub analyst, Alpaca bars)
// are individually cached via Next's Data Cache (per-fetch `revalidate`), so a
// cold compute is expensive but warm ones are cheap. On top of that we memoise
// the fully-assembled universe in-process for a short TTL so a burst of 30s SWR
// polls re-ranks instantly instead of re-walking 500 names every time.
//
// computeFactorUniverse is failure-isolated — a down source nulls a factor
// (→ neutral 50) rather than 500-ing the board — so we only 500 on a truly
// unexpected error.

import { NextResponse } from "next/server";
import { getFactorUniverse } from "@/lib/factorUniverse";
import { guardDataRoute } from "@/lib/dataRouteGuard";

export const runtime = "nodejs";
export const maxDuration = 300; // cold compute fans out across ~500 tickers

// The 15-min memo now lives in @/lib/factorUniverse so the chat discovery scout
// shares one cache with this lens (no double cold computes). See that module.
export async function GET() {
  // A cold compute walks ~500 names across three providers for up to 300 s, so an
  // anonymous caller could pin a function and spend shared quota at will.
  const gate = await guardDataRoute("research-factors", { capacity: 10, refillPerSec: 0.2 });
  if (gate.error) return gate.error;

  try {
    const data = await getFactorUniverse();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[research/factors]", err);
    return NextResponse.json({ error: "Failed to compute factor universe" }, { status: 500 });
  }
}
