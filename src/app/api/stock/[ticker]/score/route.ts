// The canonical Finava Score for one ticker, read from the facts layer (the
// 15-factor engine). Kept for callers of this path; the stock page reads
// /api/facts/[ticker] directly. A score we can't compute is null with a note.
import { NextResponse } from "next/server";
import { guardDataRoute } from "@/lib/dataRouteGuard";
import { isValidTicker } from "@/lib/tickers";
import { getTickerFacts } from "@/lib/facts/ticker";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const gate = await guardDataRoute("stock-score", { capacity: 20, refillPerSec: 0.5 });
  if (gate.error) return gate.error;

  const { ticker } = await params;
  const symbol = (ticker ?? "").trim().toUpperCase();
  // The symbol goes into provider URLs (Finnhub query, Polygon path) and a shared
  // cache key, so it must be a ticker and nothing else — `%26`/`%2F` decode here.
  if (symbol && !isValidTicker(symbol)) {
    return NextResponse.json({ error: "Invalid ticker symbol." }, { status: 400 });
  }
  if (!symbol) return NextResponse.json({ error: "Missing ticker." }, { status: 400 });

  try {
    const { score } = await getTickerFacts(symbol);
    const v = score.value;
    return NextResponse.json({
      ticker: symbol,
      score: v?.total ?? null,
      grade: v?.grade ?? null,
      pillars: v?.pillars ?? [],
      confidence: v?.confidence ?? null,
      asOf: score.asOf,
      version: v?.version ?? null,
      note: score.note ?? null,
    });
  } catch (err) {
    console.error("[stock score]", symbol, err);
    return NextResponse.json({ error: `Couldn't compute the score for ${symbol}.` }, { status: 502 });
  }
}
