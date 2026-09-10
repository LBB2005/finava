import { NextResponse } from "next/server";
import { adminAuth, db } from "@/lib/firebase-admin";
import { requireAuth } from "@/lib/requireAuth";
import { resolvePlan, capabilitiesFor } from "@/lib/entitlements";
import { TRIAL_DAYS } from "@/lib/plans";
import { sanitizeAppearance } from "@/lib/appearance";

const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * Stamp a 3-day no-card trial on first authenticated read, exactly once. Guarded
 * by `trialInitialized` so it can't be re-farmed by deleting `trialEndsAt`, and
 * skipped entirely for users who already have a paid subscription.
 */
async function ensureTrial(
  userId: string,
  settings: FirebaseFirestore.DocumentData | undefined
): Promise<void> {
  if (settings?.trialInitialized === true) return;
  const plan = settings?.plan as string | undefined;
  const status = settings?.subscriptionStatus as string | undefined;
  const hasPaid = plan && plan !== "Free" && status && PAID_STATUSES.has(status);
  if (hasPaid) return;

  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString();
  await db
    .collection("userSettings")
    .doc(userId)
    .set({ trialEndsAt, trialInitialized: true }, { merge: true });
}

export async function GET() {
  const { userId, error } = await requireAuth();
  if (error) return error;
  try {
    const [firebaseUser, settingsDoc, convSnap, briefingSnap] = await Promise.all([
      adminAuth.getUser(userId),
      db.collection("userSettings").doc(userId).get(),
      db.collection("users").doc(userId).collection("conversations").select().get(),
      db.collection("users").doc(userId).collection("briefings").select().get(),
    ]);

    const settings = settingsDoc.exists ? settingsDoc.data() : {};

    // First-touch trial provisioning, then resolve the effective entitlement.
    await ensureTrial(userId, settings);
    const ent = await resolvePlan(userId);

    return NextResponse.json({
      uid: userId,
      name: firebaseUser.displayName ?? null,
      email: firebaseUser.email ?? null,
      photoURL: firebaseUser.photoURL ?? null,
      createdAt: firebaseUser.metadata.creationTime ?? null,
      // Server-authoritative plan + billing state (only the Stripe webhook and
      // the trial stamp above ever write these).
      plan: ent.plan,
      planSource: ent.source,
      subscriptionStatus: ent.subscriptionStatus,
      trialEndsAt: ent.trialEndsAt,
      currentPeriodEnd: (settings?.currentPeriodEnd as string | undefined) ?? null,
      cancelAtPeriodEnd: (settings?.cancelAtPeriodEnd as boolean | undefined) ?? false,
      capabilities: capabilitiesFor(ent.plan),
      allowDataTraining: (settings?.allowDataTraining as boolean) ?? true,
      locationMetadata: (settings?.locationMetadata as boolean) ?? true,
      allowInvestorDNA: (settings?.allowInvestorDNA as boolean) ?? true,
      notifyWeeklyBriefing: (settings?.notifyWeeklyBriefing as boolean) ?? true,
      notifyProductUpdates: (settings?.notifyProductUpdates as boolean) ?? false,
      appearance: settings?.appearance ?? null,
      stats: {
        conversations: convSnap.size,
        briefings: briefingSnap.size,
      },
    });
  } catch (err) {
    console.error("[user GET]", err);
    return NextResponse.json({ error: "Failed to load user" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const { userId, error } = await requireAuth();
  if (error) return error;
  try {
    const body = await request.json() as Record<string, unknown>;
    const settingsUpdate: Record<string, unknown> = {};

    // NOTE: `plan` is deliberately NOT client-writable — it is server-authoritative
    // and only the Stripe webhook (+ trial stamp) may set it. Otherwise a user
    // could self-upgrade to a paid tier with a PATCH.
    for (const key of [
      "allowDataTraining",
      "locationMetadata",
      "allowInvestorDNA",
      "notifyWeeklyBriefing",
      "notifyProductUpdates",
    ]) {
      if (key in body) settingsUpdate[key] = body[key];
    }

    // Appearance prefs are device display settings — whitelist each key to its
    // allowed value before storing, since they drive CSS attributes client-side.
    if ("appearance" in body) {
      const clean = sanitizeAppearance(body.appearance);
      if (Object.keys(clean).length > 0) settingsUpdate.appearance = clean;
    }

    if (typeof body.displayName === "string") {
      await adminAuth.updateUser(userId, { displayName: body.displayName });
    }

    if (Object.keys(settingsUpdate).length > 0) {
      await db.collection("userSettings").doc(userId).set(settingsUpdate, { merge: true });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[user PATCH]", err);
    return NextResponse.json({ error: "Failed to update user" }, { status: 500 });
  }
}
