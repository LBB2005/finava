import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { apiError } from "@/lib/apiError";
import { withRoute } from "@/lib/withRoute";
import { generateConversationTitle } from "@/lib/conversationTitle";
import { isSafeDocId } from "@/lib/docId";
import { userRateLimit } from "@/lib/rateLimit";

/**
 * Backfill an auto-title for an existing untitled conversation. Called when the
 * user opens an old chat that predates auto-titling (see useOpenConversation).
 * Idempotent: the helper no-ops when a title already exists or the exchange is
 * incomplete.
 */
export const POST = withRoute(
  {},
  async ({ userId }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // "/" in an id addresses a different path (see docId).
    if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
    const convRef = db
      .collection("users")
      .doc(userId)
      .collection("conversations")
      .doc(id);
    const snap = await convRef.get();
    if (!snap.exists) {
      return apiError("not_found", "Conversation not found", 404);
    }

    // An unmetered model call; throttled per user (same bucket as auto-titling).
    if (!snap.data()?.title) {
      const throttled = await userRateLimit(userId, "conv-title", { capacity: 10, refillPerSec: 0.05 });
      if (throttled) return throttled;
    }
    await generateConversationTitle(userId, id);

    const after = (await convRef.get()).data()?.title ?? null;
    return NextResponse.json({ ok: true, title: after });
  }
);
