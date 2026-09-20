import { NextResponse } from "next/server";
import { db, serializeDoc } from "@/lib/firebase-admin";
import { apiError } from "@/lib/apiError";
import { withRoute } from "@/lib/withRoute";
import { UpdateHoldingSchema } from "@/lib/schemas/portfolio";
import { isSafeDocId } from "@/lib/docId";

function holdingDoc(uid: string, id: string) {
  return db.collection("users").doc(uid).collection("holdings").doc(id);
}

export const PATCH = withRoute(
  { body: UpdateHoldingSchema },
  async ({ userId, body }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // "/" in an id addresses a different path (see docId).
    if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
    const { shares, avgCost, companyName, sector } = body;

    const docRef = holdingDoc(userId, id);
    const snap = await docRef.get();
    if (!snap.exists) {
      return apiError("not_found", "Holding not found", 404);
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (shares !== undefined) updates.shares = shares;
    if (avgCost !== undefined) updates.avgCost = avgCost;
    if (companyName !== undefined) updates.companyName = companyName;
    if (sector !== undefined) updates.sector = sector;

    await docRef.update(updates);
    const updated = await docRef.get();
    return NextResponse.json(serializeDoc(updated.id, updated.data()!));
  }
);

export const DELETE = withRoute(
  {},
  async ({ userId }, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // "/" in an id addresses a different path (see docId).
    if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
    const docRef = holdingDoc(userId, id);
    const snap = await docRef.get();
    if (!snap.exists) {
      return apiError("not_found", "Holding not found", 404);
    }
    await docRef.delete();
    return NextResponse.json({ ok: true });
  }
);
