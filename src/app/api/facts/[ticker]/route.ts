// src/app/api/facts/[ticker]/route.ts
// A ticker's facts: every number the stock page shows, sourced and dated.
// Public read-only market data (same posture as /api/stock/[ticker]/score).
// `?cachedOnly=1` skips the expensive score/DCF assembly for a fast first paint.
import { NextResponse } from "next/server";
import { rateLimitGuard } from "@/lib/rateLimit";
import { isValidTicker } from "@/lib/tickers";
import { getTickerFacts } from "@/lib/facts/ticker";

export const runtime = "nodejs";
// A cold score assembly includes the Grok read (up to ~30 s).
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const limited = await rateLimitGuard(req, "facts", { capacity: 30, refillPerSec: 0.5 });
  if (limited) return limited;

  const { ticker } = await params;
  const symbol = (ticker ?? "").trim().toUpperCase();
  if (!symbol || !isValidTicker(symbol)) return NextResponse.json({ error: "Invalid ticker." }, { status: 400 });

  const cachedOnly = new URL(req.url).searchParams.get("cachedOnly") === "1";
  try {
    return NextResponse.json(await getTickerFacts(symbol, { cachedOnly }));
  } catch (err) {
    console.error("[facts]", symbol, err);
    return NextResponse.json({ error: `Couldn't load facts for ${symbol}.` }, { status: 502 });
  }
}
