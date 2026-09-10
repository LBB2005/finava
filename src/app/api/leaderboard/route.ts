// Live market-data overlay for the research leaderboard.
//
// Mirrors src/app/api/quotes/route.ts: server-side, app-level API keys, no user
// auth required (works under the dev bypass). getBoardData is failure-isolated —
// a down source nulls its column rather than 500-ing the whole board, so we only
// 500 on a truly unexpected error.

import { NextResponse } from "next/server";
import { getBoardData } from "@/lib/leaderboardData";
import { ALL_CONSTITUENTS } from "@/lib/extraUniverse";
import { rateLimitGuard } from "@/lib/rateLimit";
import { parseTickersParam } from "@/lib/tickers";

// One call covers the full ~500-ticker universe, so the request itself is heavy;
// keep the sustained rate well below the quotes route.
const LIMITS = { capacity: 10, refillPerSec: 0.2 };

// The board never legitimately needs more than the scannable universe.
const MAX_TICKERS = 600;

export async function GET(req: Request) {
  const limited = await rateLimitGuard(req, "leaderboard", LIMITS);
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const requested = parseTickersParam(searchParams.get("tickers") ?? "");

  if (requested.length > MAX_TICKERS) {
    return NextResponse.json(
      { error: `Too many tickers — max ${MAX_TICKERS} per request.` },
      { status: 400 }
    );
  }

  // Default to the full scannable universe when the client sends no explicit list.
  const tickers = requested.length ? requested : ALL_CONSTITUENTS.map((c) => c.ticker);

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
