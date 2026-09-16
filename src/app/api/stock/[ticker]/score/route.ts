// src/app/api/stock/[ticker]/score/route.ts
// The canonical Finava Score for one ticker, read from the facts layer (the
// 15-factor engine). Kept for callers of this path; the stock page reads
// /api/facts/[ticker] directly. A score we can't compute is null with a note.
import { NextResponse } from "next/server";
import { rateLimitGuard } from "@/lib/rateLimit";
import { getTickerFacts } from "@/lib/facts/ticker";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const limited = await rateLimitGuard(req, "stock-score", { capacity: 20, refillPerSec: 0.5 });
  if (limited) return limited;

  const { ticker } = await params;
  const symbol = (ticker ?? "").trim().toUpperCase();
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
