// Aggregated per-ticker bundle for the stock research page.
//
// Mirrors src/app/api/quotes/route.ts: server-side, app-level API keys, signed-in
// callers only (see guardDataRoute). Each field is failure-isolated in
// getStockBundle — one failing source nulls its field rather than 500-ing.

import { NextResponse } from "next/server";
import { getStockBundle } from "@/lib/stockData";
import { guardDataRoute } from "@/lib/dataRouteGuard";
import { isValidTicker } from "@/lib/tickers";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const gate = await guardDataRoute("stock", { capacity: 20, refillPerSec: 0.5 });
  if (gate.error) return gate.error;

  const { ticker } = await params;
  const symbol = (ticker ?? "").trim().toUpperCase();

  if (!symbol) {
    return NextResponse.json({ error: "Missing ticker." }, { status: 400 });
  }

  if (!isValidTicker(symbol)) {
    return NextResponse.json({ error: "Invalid ticker symbol." }, { status: 400 });
  }

  if (!process.env.FINNHUB_API_KEY) {
    return NextResponse.json(
      { error: "Stock service not configured (FINNHUB_API_KEY missing)." },
      { status: 503 }
    );
  }

  try {
    const bundle = await getStockBundle(symbol);

    // No quote AND no profile ⇒ unknown symbol. Everything else can be partially
    // null and still render a useful page.
    if (!bundle.quote && !bundle.profile) {
      return NextResponse.json(
        { error: `Couldn't find ${symbol}.` },
        { status: 404 }
      );
    }

    return NextResponse.json(bundle);
  } catch (err) {
    console.error("[stock]", symbol, err);
    return NextResponse.json(
      { error: "Failed to load stock data." },
      { status: 500 }
    );
  }
}
