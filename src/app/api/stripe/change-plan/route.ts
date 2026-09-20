/**
 * Update an existing Stripe subscription to a different price (plan/cadence).
 * Uses proration so upgrades charge the difference immediately and downgrades
 * credit the remainder. The webhook (customer.subscription.updated) then writes
 * the new plan to Firestore — no direct Firestore write here.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { requireAuth } from "@/lib/requireAuth";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { priceIdFor, type BillingCadence, type PlanName, PLANS } from "@/lib/plans";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { userId, error } = await requireAuth();
  if (error) return error;

  if (!stripeConfigured()) {
    return NextResponse.json({ error: "Billing not configured." }, { status: 503 });
  }

  let plan: PlanName;
  let cadence: BillingCadence;
  try {
    const body = (await req.json()) as { plan?: string; cadence?: string };
    plan = body.plan as PlanName;
    cadence = body.cadence === "annual" ? "annual" : "monthly";
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const cfg = PLANS[plan];
  if (!cfg?.stripe.purchasable) {
    return NextResponse.json({ error: "Plan not available." }, { status: 400 });
  }

  const priceId = priceIdFor(plan, cadence);
  if (!priceId) {
    return NextResponse.json({ error: `Price not configured for ${plan}/${cadence}.` }, { status: 503 });
  }

  const snap = await db.collection("userSettings").doc(userId).get();
  const subId = snap.data()?.stripeSubscriptionId as string | undefined;

  if (!subId) {
    return NextResponse.json({ error: "no_subscription" }, { status: 404 });
  }

  try {
    const sub = await stripe.subscriptions.retrieve(subId);
    const itemId = sub.items.data[0]?.id;
    if (!itemId) {
      return NextResponse.json({ error: "Subscription item not found." }, { status: 500 });
    }

    await stripe.subscriptions.update(subId, {
      items: [{ id: itemId, price: priceId }],
      // Invoice the proration NOW, and apply the change only if that payment
      // succeeds. `create_prorations` granted the higher plan immediately and
      // deferred the charge to the next invoice — which cancelling at period end
      // left uncollected — and a declining card still switched plans (past_due).
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[stripe/change-plan]", err);
    return NextResponse.json({ error: "Could not update subscription." }, { status: 502 });
  }
}
