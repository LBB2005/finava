import { NextResponse } from "next/server";
import { db, serializeDoc } from "@/lib/firebase-admin";
import { apiError } from "@/lib/apiError";
import { withRoute } from "@/lib/withRoute";
import { AddMessageSchema } from "@/lib/schemas/conversation";
import { generateConversationTitle } from "@/lib/conversationTitle";

export const POST = withRoute(
  { body: AddMessageSchema },
  async ({ userId, body }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const { role, content, mode = "simple", agentTrace, durationMs, context, followups, critique, attachment, stopped } = body;

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
      createdAt: now,
    });

    await convRef.update({ updatedAt: now });

    // Once the first assistant reply lands, auto-title the chat (fire-and-forget,
    // so it never adds latency to the write). The helper self-guards: it no-ops
    // when a title already exists or the exchange isn't complete yet.
    if (role === "assistant") {
      generateConversationTitle(userId, id).catch((err) =>
        console.warn("[conversations] title generation failed", err)
      );
    }

    const msgSnap = await msgRef.get();
    return NextResponse.json(serializeDoc(msgSnap.id, msgSnap.data()!), { status: 201 });
  }
);
