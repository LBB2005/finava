// src/app/api/watchlists/[id]/route.ts
import { NextResponse } from "next/server";
import { db, serializeDoc } from "@/lib/firebase-admin";
import { apiError } from "@/lib/apiError";
import { withRoute } from "@/lib/withRoute";
import { toWatchlist } from "@/lib/watchlist";
import { UpdateWatchlistSchema } from "@/lib/schemas/watchlist";
import { isSafeDocId } from "@/lib/docId";

function docFor(uid: string, id: string) {
  return db.collection("users").doc(uid).collection("watchlists").doc(id);
}

export const PATCH = withRoute(
  { body: UpdateWatchlistSchema },
  async ({ userId, body }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // "/" in an id addresses a different path (see docId).
    if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);

    const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) data.name = body.name;
    if (body.tickers !== undefined) data.tickers = body.tickers;

    const docRef = docFor(userId, id);
    const existing = await docRef.get();
    if (!existing.exists) {
      return apiError("not_found", "Watchlist not found", 404);
    }
    await docRef.update(data);
    const snap = await docRef.get();
    return NextResponse.json(toWatchlist(serializeDoc(snap.id, snap.data()!)));
  }
);

export const DELETE = withRoute(
  {},
  async ({ userId }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // "/" in an id addresses a different path (see docId).
    if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
    const docRef = docFor(userId, id);
    const existing = await docRef.get();
    if (!existing.exists) {
      return apiError("not_found", "Watchlist not found", 404);
    }
    await docRef.delete();
    return NextResponse.json({ ok: true });
  }
);
