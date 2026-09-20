/**
 * Stripe client + helpers. SERVER-ONLY — never import this from a client component
 * (it reads STRIPE_SECRET_KEY and talks to the Stripe API).
 */
import Stripe from "stripe";
import { db } from "@/lib/firebase-admin";
import { planForPriceId, type PlanName } from "@/lib/plans";

// A single shared client. apiVersion is intentionally omitted so we use the
// version pinned by the installed `stripe` package (avoids a brittle literal
// that drifts on every SDK bump).
//
// The Stripe constructor throws on an empty key — which would crash at module
// evaluation during `next build` (page-data collection) in any env without the
// key set. We fall back to a syntactically-valid placeholder so construction
// never throws; every route guards real usage behind `stripeConfigured()`, so
// the placeholder client is never actually called.
export const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || "sk_test_unconfigured_placeholder"
);

/** True when Stripe is configured — lets routes 503 cleanly in unconfigured envs. */
export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Get the Stripe customer id for a user, creating one if needed.
 *
 * Order of resolution:
 *   1. `userSettings/{uid}.stripeCustomerId` if already stored.
 *   2. Search Stripe by `metadata.firebaseUid` (survives a race where the webhook
 *      created the customer but our Firestore write hadn't landed yet).
 *   3. Create a fresh customer, tagging it with `firebaseUid` so the webhook can
 *      always map back to us.
 *
 * The resolved id is persisted to `userSettings` for next time.
 */
export async function getOrCreateCustomer(
  userId: string,
  email: string | null | undefined
): Promise<string> {
  const ref = db.collection("userSettings").doc(userId);
  const snap = await ref.get();
  const existing = snap.data()?.stripeCustomerId as string | undefined;
  if (existing) return existing;

  // Guard against duplicate customers from a prior race.
  const found = await stripe.customers.search({
    query: `metadata['firebaseUid']:'${userId}'`,
    limit: 1,
  });
  let customerId = found.data[0]?.id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: email ?? undefined,
      metadata: { firebaseUid: userId },
    });
    customerId = customer.id;
  }

  await ref.set({ stripeCustomerId: customerId }, { merge: true });
  return customerId;
}

/**
 * Map a Stripe Subscription to our plan + status.
 *
 * - active / trialing / past_due → the plan implied by its price id (past_due
 *   keeps the plan so the grace period in resolvePlan() can apply).
 * - canceled / unpaid / incomplete_expired → Free.
 */
export function mapSubscriptionToPlan(sub: Stripe.Subscription): {
  plan: PlanName;
  subscriptionStatus: Stripe.Subscription.Status;
} {
  const priceId = sub.items.data[0]?.price?.id ?? "";
  const mapped = planForPriceId(priceId);
  const status = sub.status;

  const isLapsed =
    status === "canceled" ||
    status === "unpaid" ||
    status === "incomplete_expired";

  const plan: PlanName = isLapsed ? "Free" : mapped?.plan ?? "Free";
  return { plan, subscriptionStatus: status };
}

/**
 * ISO string for a subscription's current period end (or null).
 * `current_period_end` lives on the subscription item in recent API versions and
 * on the subscription object in older ones — check both so this is version-proof.
 */
export function periodEndISO(sub: Stripe.Subscription): string | null {
  const fromItem = sub.items?.data?.[0]?.current_period_end ?? null;
  const fromSub =
    (sub as unknown as { current_period_end?: number }).current_period_end ?? null;
  const end = fromItem ?? fromSub;
  return end ? new Date(end * 1000).toISOString() : null;
}

/**
 * Absolute base URL for Stripe success/cancel/return links, or null when it
 * can't be trusted. Only NEXT_PUBLIC_APP_URL is used — never a request header,
 * which would let a crafted Host send a paying customer to another site. The
 * localhost fallback is for local dev only: in a deployed build an unset value
 * used to send customers to http://localhost:3000 after paying.
 */
export function billingBaseUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? null : "http://localhost:3000";
}
