// Live market-data overlay for the research leaderboard.
//
// Mirrors src/app/api/quotes/route.ts: server-side, app-level API keys, signed-in
// callers only (see guardDataRoute). getBoardData is failure-isolated —
// a down source nulls its column rather than 500-ing the whole board, so we only
// 500 on a truly unexpected error.

import { NextResponse } from "next/server";
import { getBoardData } from "@/lib/leaderboardData";
import { ALL_CONSTITUENTS } from "@/lib/extraUniverse";
import { guardDataRoute } from "@/lib/dataRouteGuard";
import { MAX_BATCH_TICKERS, parseTickersParam } from "@/lib/tickers";

// One call covers the full ~500-ticker universe, so the request itself is heavy;
// keep the sustained rate well below the quotes route.
const LIMITS = { capacity: 10, refillPerSec: 0.2 };

// The board never legitimately needs more than the scannable universe.
const MAX_TICKERS = 600;

const BOARD_TICKERS: ReadonlySet<string> = new Set(ALL_CONSTITUENTS.map((c) => c.ticker));

export async function GET(req: Request) {
  const gate = await guardDataRoute("leaderboard", LIMITS);
  if (gate.error) return gate.error;

  const { searchParams } = new URL(req.url);
  const requested = parseTickersParam(searchParams.get("tickers") ?? "");

  if (requested.length > MAX_TICKERS) {
    return NextResponse.json(
      { error: `Too many tickers — max ${MAX_TICKERS} per request.` },
      { status: 400 }
    );
  }

  // Each symbol costs a Finnhub metrics call (cached an hour, per symbol), so a
  // client-chosen list of never-seen symbols is an uncached fan-out: 600 of them
  // drained the shared per-minute key in one request and blanked market data for
  // every user. Board names are the pre-warmed set and pass freely; anything else
  // (a watchlist's small caps) is bounded to one quote batch per request.
  const onBoard = requested.filter((t) => BOARD_TICKERS.has(t));
  const offBoard = requested.filter((t) => !BOARD_TICKERS.has(t)).slice(0, MAX_BATCH_TICKERS);
  const tickers = requested.length ? [...onBoard, ...offBoard] : [...BOARD_TICKERS];

  try {
    const rows = await getBoardData(tickers);
    return NextResponse.json({ rows });
  } catch (err) {
    console.error("[leaderboard]", err);
    return NextResponse.json(
      { error: "Failed to fetch leaderboard data" },
      { status: 500 }
    );
  }
}
