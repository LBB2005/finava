/**
 * Daily subscription reconciliation — the backstop for the Stripe webhook.
 *
 * The webhook is the primary writer of plan state, but a single dropped or
 * out-of-order event can leave Firestore diverged from Stripe (e.g. a user stuck
 * on a paid plan after a silent cancellation, or a past_due that never resolved).
 * This job re-reads the source of truth for every active/past_due user and
 * rewrites Firestore to match, so state converges even when a webhook is missed.
 *
 * Scheduled via vercel.json `crons`; authorized by CRON_SECRET (Vercel Cron sends
 * it as `Authorization: Bearer <CRON_SECRET>`).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import * as admin from "firebase-admin";
import { db } from "@/lib/firebase-admin";
import {
  stripe,
  stripeConfigured,
  mapSubscriptionToPlan,
  periodEndISO,
} from "@/lib/stripe";

export const runtime = "nodejs";
export const maxDuration = 300;

const FieldValue = admin.firestore.FieldValue;

function cronAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false; // fail closed when the secret isn't configured
  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Firestore patch derived from the live Stripe subscription. */
function reconcilePatch(sub: import("stripe").Stripe.Subscription): Record<string, unknown> {
  const { plan, subscriptionStatus } = mapSubscriptionToPlan(sub);
  const patch: Record<string, unknown> = {
    plan,
    subscriptionStatus,
    currentPeriodEnd: periodEndISO(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  };
  // A healthy subscription clears the past-due grace clock.
  if (subscriptionStatus !== "past_due") patch.pastDueSince = FieldValue.delete();
  return patch;
}

/** Start the grace clock for a past_due user who has none (see the webhook). */
function withGraceClock(
  patch: Record<string, unknown>,
  existing: FirebaseFirestore.DocumentData | undefined
): Record<string, unknown> {
  if (patch.subscriptionStatus === "past_due" && !existing?.pastDueSince) {
    return { ...patch, pastDueSince: new Date().toISOString() };
  }
  return patch;
}

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!stripeConfigured()) {
    return NextResponse.json({ error: "Billing not configured" }, { status: 503 });
  }

  const snap = await db
    .collection("userSettings")
    .where("subscriptionStatus", "in", ["active", "past_due"])
    .limit(500)
    .get();

  let checked = 0;
  let updated = 0;
  let errors = 0;

  for (const doc of snap.docs) {
    checked++;
    const data = doc.data();
    const subId = data.stripeSubscriptionId as string | undefined;

    try {
      if (!subId) {
        // Marked paid but no subscription id → drift; reset to Free.
        await doc.ref.set(
          { plan: "Free", subscriptionStatus: "canceled", pastDueSince: FieldValue.delete() },
          { merge: true }
        );
        updated++;
        continue;
      }

      const sub = await stripe.subscriptions.retrieve(subId);
      const patch = withGraceClock(reconcilePatch(sub), data);

      const changed =
        patch.plan !== data.plan ||
        patch.subscriptionStatus !== data.subscriptionStatus ||
        patch.currentPeriodEnd !== (data.currentPeriodEnd ?? null) ||
        // A past_due user with no grace clock yet: starting it is a change.
        (typeof patch.pastDueSince === "string" && !data.pastDueSince);

      if (changed) {
        console.warn(
          `[cron/reconcile] ${doc.id}: ${data.plan}/${data.subscriptionStatus} → ${patch.plan}/${patch.subscriptionStatus}`
        );
        await doc.ref.set(patch, { merge: true });
        updated++;
      }
    } catch (e) {
      // A retrieve 404s when the subscription no longer exists at Stripe.
      const code = (e as { code?: string; statusCode?: number }).code;
      const status = (e as { statusCode?: number }).statusCode;
      if (code === "resource_missing" || status === 404) {
        await doc.ref.set(
          {
            plan: "Free",
            subscriptionStatus: "canceled",
            stripeSubscriptionId: FieldValue.delete(),
            pastDueSince: FieldValue.delete(),
          },
          { merge: true }
        );
        updated++;
      } else {
        console.error(`[cron/reconcile] failed for ${doc.id}:`, e);
        errors++;
      }
    }
  }

  return NextResponse.json({ ok: true, checked, updated, errors });
}
