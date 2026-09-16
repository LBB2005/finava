// Cache-only score headlines for list rows (watchlist, board, portfolio).
// Never computes: a name nobody has opened reads "Not scored yet".
import { NextResponse } from "next/server";
import { rateLimitGuard } from "@/lib/rateLimit";
import { parseTickersParam, MAX_BATCH_TICKERS } from "@/lib/tickers";
import { getTickerFactsSlim } from "@/lib/facts/ticker";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const limited = await rateLimitGuard(req, "facts-batch", { capacity: 30, refillPerSec: 1 });
  if (limited) return limited;

  const raw = new URL(req.url).searchParams.get("tickers") ?? "";
  const tickers = [...new Set(parseTickersParam(raw))].slice(0, MAX_BATCH_TICKERS);
  if (tickers.length === 0) return NextResponse.json({ error: "No valid tickers." }, { status: 400 });

  try {
    return NextResponse.json({ facts: await getTickerFactsSlim(tickers) });
  } catch (err) {
    console.error("[facts batch]", err);
    return NextResponse.json({ error: "Couldn't load scores." }, { status: 502 });
  }
}
