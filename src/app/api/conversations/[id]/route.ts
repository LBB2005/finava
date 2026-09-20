import { NextResponse } from "next/server";
import { db, serializeDoc, deleteRefsInBatches } from "@/lib/firebase-admin";
import { apiError } from "@/lib/apiError";
import { withRoute } from "@/lib/withRoute";
import { UpdateConversationSchema } from "@/lib/schemas/conversation";
import { isSafeDocId } from "@/lib/docId";

function convDoc(uid: string, id: string) {
  return db.collection("users").doc(uid).collection("conversations").doc(id);
}

// Hard ceiling on a single transcript load; far above any real conversation.
const MAX_MESSAGES = 1000;

export const GET = withRoute(
  {},
  async ({ userId }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // "/" in an id addresses a different path (see docId).
    if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
    const docRef = convDoc(userId, id);
    const snap = await docRef.get();
    if (!snap.exists) {
      return apiError("not_found", "Not found", 404);
    }
    const msgSnap = await docRef
      .collection("messages")
      .orderBy("createdAt")
      .limit(MAX_MESSAGES)
      .get();
    const messages = msgSnap.docs.map((m) => serializeDoc(m.id, m.data()));
    return NextResponse.json({ ...serializeDoc(snap.id, snap.data()!), messages });
  }
);

export const DELETE = withRoute(
  {},
  async ({ userId }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // "/" in an id addresses a different path (see docId).
    if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
    const docRef = convDoc(userId, id);
    // Delete all messages first, then the conversation doc itself.
    const msgSnap = await docRef.collection("messages").get();
    await deleteRefsInBatches([...msgSnap.docs.map((m) => m.ref), docRef]);
    return NextResponse.json({ ok: true });
  }
);

export const PATCH = withRoute(
  { body: UpdateConversationSchema },
  async ({ userId, body }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // "/" in an id addresses a different path (see docId).
    if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
    const { title, archived } = body;
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (archived !== undefined) updates.archived = archived;
    const docRef = convDoc(userId, id);
    await docRef.update(updates);
    const snap = await docRef.get();
    return NextResponse.json(serializeDoc(snap.id, snap.data()!));
  }
);
