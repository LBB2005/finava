// DCF base inputs, read from the facts layer so this and every other surface use
// the one input path (beta-tuned WACC, split-safe shares). The DCF tab recomputes
// locally as the user drags sliders; those tweaks never leave the browser.
import { NextResponse } from "next/server";
import { guardDataRoute } from "@/lib/dataRouteGuard";
import { isValidTicker } from "@/lib/tickers";
import { getTickerFacts } from "@/lib/facts/ticker";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const gate = await guardDataRoute("stock-dcf", { capacity: 20, refillPerSec: 0.5 });
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
    const { dcf } = await getTickerFacts(symbol);
    if (!dcf.value) {
      return NextResponse.json({ error: `DCF is unavailable for ${symbol} (${dcf.note ?? "insufficient data"}).` }, { status: 404 });
    }
    return NextResponse.json({ ticker: symbol, inputs: dcf.value.inputs });
  } catch (err) {
    console.error("[stock dcf]", symbol, err);
    return NextResponse.json({ error: "Failed to build DCF inputs." }, { status: 500 });
  }
}
