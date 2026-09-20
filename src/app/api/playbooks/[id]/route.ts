import { NextResponse } from "next/server";
import { db, serializeDoc } from "@/lib/firebase-admin";
import { requireAuth } from "@/lib/requireAuth";
import { sanitizeFormats } from "@/lib/templates";
import { isSafeDocId } from "@/lib/docId";
import { apiError } from "@/lib/apiError";

function playbookDoc(uid: string, id: string) {
  return db.collection("users").doc(uid).collection("playbooks").doc(id);
}

const MAX_STEPS = 20;
const MAX_STEP_CHARS = 2000;
const MAX_TITLE_CHARS = 80;
const MAX_INSTRUCTIONS_CHARS = 2000;

type RouteCtx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: RouteCtx) {
  const { userId, error } = await requireAuth();
  if (error) return error;
  const { id } = await ctx.params;
  // "/" in an id addresses a different path (see docId).
  if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
  try {
    const ref = playbookDoc(userId, id);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: "Template not found" }, { status: 404 });

    const body = await req.json();
    // Build a partial update — only fields actually present in the body are touched.
    const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (typeof body.title === "string") update.title = body.title.trim().slice(0, MAX_TITLE_CHARS);
    if (typeof body.instructions === "string")
      update.instructions = body.instructions.trim().slice(0, MAX_INSTRUCTIONS_CHARS);
    if (body.formats !== undefined || body.format !== undefined)
      update.formats = sanitizeFormats(body.formats ?? body.format);
    if (Array.isArray(body.steps)) {
      update.steps = body.steps
        .filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
        .slice(0, MAX_STEPS)
        .map((s: string) => s.trim().slice(0, MAX_STEP_CHARS));
    }

    await ref.set(update, { merge: true });
    const fresh = await ref.get();
    return NextResponse.json(serializeDoc(fresh.id, fresh.data() ?? {}));
  } catch (err) {
    console.error("[playbooks PATCH]", err);
    return NextResponse.json({ error: "Failed to update template" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: RouteCtx) {
  const { userId, error } = await requireAuth();
  if (error) return error;
  const { id } = await ctx.params;
  // "/" in an id addresses a different path (see docId).
  if (!isSafeDocId(id)) return apiError("not_found", "Not found", 404);
  try {
    await playbookDoc(userId, id).delete();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[playbooks DELETE]", err);
    return NextResponse.json({ error: "Failed to delete template" }, { status: 500 });
  }
}
