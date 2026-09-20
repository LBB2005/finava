import { NextResponse } from "next/server";
import { getSnapshots } from "@/lib/finnhub";
import { guardDataRoute } from "@/lib/dataRouteGuard";
import { MAX_BATCH_TICKERS, parseTickersParam } from "@/lib/tickers";

export async function GET(req: Request) {
  const gate = await guardDataRoute("quotes");
  if (gate.error) return gate.error;

  const { searchParams } = new URL(req.url);
  const tickers = parseTickersParam(searchParams.get("tickers") ?? "");

  if (!tickers.length) return NextResponse.json([]);

  if (tickers.length > MAX_BATCH_TICKERS) {
    return NextResponse.json(
      { error: `Too many tickers — max ${MAX_BATCH_TICKERS} per request.` },
      { status: 400 }
    );
  }

  if (!process.env.FINNHUB_API_KEY) {
    return NextResponse.json(
      { error: "Quote service not configured (FINNHUB_API_KEY missing)." },
      { status: 503 }
    );
  }

  try {
    const snapshots = await getSnapshots(tickers);
    return NextResponse.json(snapshots);
  } catch (err) {
    console.error("[quotes]", err);
    return NextResponse.json({ error: "Failed to fetch quotes" }, { status: 500 });
  }
}
