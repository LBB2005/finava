import { NextResponse } from "next/server";
import { db, serializeDoc } from "@/lib/firebase-admin";
import { apiError } from "@/lib/apiError";
import { withRoute } from "@/lib/withRoute";
import { AddMessageSchema } from "@/lib/schemas/conversation";
import { generateConversationTitle } from "@/lib/conversationTitle";
import { isSafeDocId } from "@/lib/docId";
import { userRateLimit } from "@/lib/rateLimit";

/** Shared with the title-backfill route: 10 burst, then ~3 a minute. */
const TITLE_LIMITS = { capacity: 10, refillPerSec: 0.05 };

export const POST = withRoute(
  { body: AddMessageSchema },
  async ({ userId, body }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // "/" in an id addresses a different path (see docId).
    if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
    const { role, content, mode = "simple", agentTrace, durationMs, context, followups, critique, attachment, stopped, clarify, clarifyReply } = body;

    // Verify the conversation belongs to this user
    const convRef = db.collection("users").doc(userId).collection("conversations").doc(id);
    const convSnap = await convRef.get();
    if (!convSnap.exists) {
      return apiError("not_found", "Conversation not found", 404);
    }

    const now = new Date().toISOString();
    const msgRef = await convRef.collection("messages").add({
      conversationId: id,
      role,
      content,
      mode,
      agentTrace: agentTrace ? JSON.stringify(agentTrace) : null,
      durationMs: typeof durationMs === "number" ? durationMs : null,
      context: context ?? null,
      // Stored with the message so a reload shows what the live run showed.
      ...(followups?.length ? { followups } : {}),
      ...(critique ? { critique } : {}),
      ...(attachment ? { attachment } : {}),
      ...(stopped ? { stopped: true } : {}),
      ...(clarify?.length ? { clarify } : {}),
      ...(clarifyReply ? { clarifyReply } : {}),
      createdAt: now,
    });

    await convRef.update({ updatedAt: now });

    // Once the first assistant reply lands, auto-title the chat (fire-and-forget,
    // so it never adds latency to the write). The helper self-guards: it no-ops
    // when a title already exists or the exchange isn't complete yet.
    // Titling is an unmetered model call, and a script could mint conversations
    // to trigger one each — so it's throttled per user, and only charged when the
    // chat is actually still untitled.
    if (role === "assistant" && !convSnap.data()?.title) {
      const throttled = await userRateLimit(userId, "conv-title", TITLE_LIMITS);
      if (!throttled) {
        generateConversationTitle(userId, id).catch((err) =>
          console.warn("[conversations] title generation failed", err)
        );
      }
    }

    const msgSnap = await msgRef.get();
    return NextResponse.json(serializeDoc(msgSnap.id, msgSnap.data()!), { status: 201 });
  }
);
