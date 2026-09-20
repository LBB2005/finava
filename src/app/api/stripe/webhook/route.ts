/**
 * Stripe webhook — the ONLY writer of plan/subscription state into Firestore.
 *
 * - Verifies the signature against the RAW request body (Next.js App Router:
 *   `await req.text()` gives the raw bytes; no bodyParser config needed).
 * - Idempotent: each `event.id` is recorded in `stripeEvents/{id}` AFTER its
 *   handler succeeds, so duplicate deliveries short-circuit while a mid-handler
 *   failure still retries cleanly (Stripe retries on any non-2xx).
 * - Maps Stripe subscription status + price id → our plan name + status.
 */
import type Stripe from "stripe";
import * as admin from "firebase-admin";
import { db } from "@/lib/firebase-admin";
import {
  stripe,
  stripeConfigured,
  mapSubscriptionToPlan,
  periodEndISO,
} from "@/lib/stripe";

export const runtime = "nodejs";

const FieldValue = admin.firestore.FieldValue;

export async function POST(req: Request) {
  if (!stripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    return new Response("Billing not configured", { status: 503 });
  }

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "bad signature";
    console.error("[stripe/webhook] signature verification failed:", msg);
    return new Response(`Webhook error: ${msg}`, { status: 400 });
  }

  // ── Idempotency (read side): if this event was already recorded, an earlier
  // delivery fully processed it — short-circuit without re-running the handler.
  // The record is written only AFTER a successful handler (below), so a delivery
  // that failed mid-handler left no record and Stripe's retry re-runs cleanly. ──
  const eventRef = db.collection("stripeEvents").doc(event.id);
  const alreadyProcessed = await eventRef.get();
  if (alreadyProcessed.exists) {
    return new Response("Duplicate, ignored", { status: 200 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const uid = await resolveUid({
          firebaseUid:
            (session.client_reference_id as string | null) ??
            (session.metadata?.firebaseUid as string | undefined),
          customerId: asId(session.customer),
        });
        if (!uid) break;

        // Paid now supersedes any running trial.
        const dated: Record<string, unknown> = { trialEndsAt: null };
        const subId = asId(session.subscription);
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          Object.assign(dated, subscriptionPatch(sub));
        }
        const applied = await applySubscriptionEvent(uid, event.created, dated, {
          // The Stripe ids carry no entitlement and are what resolveUid indexes
          // on, so they land even when the entitlement half is stale — dropping
          // them would leave later events unable to find this user.
          always: {
            stripeCustomerId: asId(session.customer),
            stripeSubscriptionId: asId(session.subscription),
          },
        });
        if (!applied) {
          console.log(`[stripe/webhook] ignored stale checkout completion for ${uid}`);
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const uid = await resolveUid({
          firebaseUid: sub.metadata?.firebaseUid,
          customerId: asId(sub.customer),
        });
        if (!uid) break;
        const patch: Record<string, unknown> = {
          stripeSubscriptionId: sub.id,
          ...subscriptionPatch(sub),
        };
        const pastDue = patch.subscriptionStatus === "past_due";
        // A healthy subscription clears any past-due grace clock.
        if (!pastDue) patch.pastDueSince = FieldValue.delete();
        // A past_due update STARTS the clock when nothing has yet. Leaving that
        // to invoice.payment_failed alone meant a failure delivered after this
        // (later-stamped) update was dropped as stale, and with no pastDueSince
        // the 7-day grace never expired.
        const applied = await applySubscriptionEvent(
          uid,
          event.created,
          (existing) =>
            pastDue && !existing.pastDueSince
              ? { ...patch, pastDueSince: new Date(event.created * 1000).toISOString() }
              : patch,
          { advanceClock: true }
        );
        if (!applied) {
          console.log(`[stripe/webhook] ignored stale ${event.type} for ${uid}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const uid = await resolveUid({
          firebaseUid: sub.metadata?.firebaseUid,
          customerId: asId(sub.customer),
        });
        if (!uid) break;
        const applied = await applySubscriptionEvent(
          uid,
          event.created,
          {
            plan: "Free",
            subscriptionStatus: "canceled",
            stripeSubscriptionId: FieldValue.delete(),
            currentPeriodEnd: FieldValue.delete(),
            cancelAtPeriodEnd: FieldValue.delete(),
            pastDueSince: FieldValue.delete(),
          },
          { advanceClock: true }
        );
        if (!applied) {
          console.log(`[stripe/webhook] ignored stale subscription.deleted for ${uid}`);
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const uid = await resolveUid({ customerId: asId(invoice.customer) });
        if (!uid) break;
        const patch: Record<string, unknown> = {
          subscriptionStatus: "active",
          // Payment recovered → clear the past-due grace clock.
          pastDueSince: FieldValue.delete(),
        };
        const subId = invoiceSubscriptionId(invoice);
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          patch.currentPeriodEnd = periodEndISO(sub);
        }
        const applied = await applySubscriptionEvent(uid, event.created, patch);
        if (!applied) {
          console.log(`[stripe/webhook] ignored stale invoice.paid for ${uid}`);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const uid = await resolveUid({ customerId: asId(invoice.customer) });
        if (!uid) break;
        // Start (or preserve) the past-due grace clock from the FIRST failure, so
        // entitlements can bound how long a failing card keeps paid access. The
        // existing stamp is read off the snapshot the guard already fetched.
        const applied = await applySubscriptionEvent(uid, event.created, (existing) => ({
          subscriptionStatus: "past_due",
          pastDueSince:
            (existing.pastDueSince as string | undefined) ??
            new Date(event.created * 1000).toISOString(),
        }));
        if (!applied) {
          console.log(`[stripe/webhook] ignored stale invoice.payment_failed for ${uid}`);
        }
        break;
      }

      default:
        // Unhandled event types are acknowledged so Stripe stops retrying.
        break;
    }
  } catch (err) {
    console.error(`[stripe/webhook] handler error (${event.type}):`, err);
    // 500 → Stripe will retry. The idempotency record is written only AFTER a
    // handler succeeds (below), so the retry re-runs the handler rather than
    // short-circuiting as an already-processed duplicate. Safe: every write is
    // an idempotent `set(..., { merge: true })`.
    return new Response("Handler error", { status: 500 });
  }

  // ── Idempotency (write side): record only after the handler succeeded. Use
  // `create` so a concurrent double-delivery that finished first is detected
  // (ALREADY_EXISTS) rather than silently overwritten — both ran, both idempotent. ──
  try {
    await eventRef.create({
      type: event.type,
      receivedAt: new Date().toISOString(),
    });
  } catch (e) {
    // ALREADY_EXISTS (gRPC code 6) → a concurrent delivery recorded it first.
    if ((e as { code?: number }).code === 6) {
      return new Response("Duplicate, ignored", { status: 200 });
    }
    // The subscription write already landed; don't fail the request over a
    // bookkeeping write (a 500 would only re-run the safe handler).
    console.error("[stripe/webhook] idempotency write failed:", e);
  }

  return new Response("ok", { status: 200 });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalize a Stripe id-or-expanded-object field to its string id (or null). */
function asId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

/** Extract the subscription id from an invoice across API-version shapes. */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const direct = (invoice as unknown as { subscription?: string | { id: string } })
    .subscription;
  if (direct) return asId(direct);
  const line = invoice.lines?.data?.[0] as
    | { subscription?: string | { id: string } }
    | undefined;
  return line?.subscription ? asId(line.subscription) : null;
}

/** The Firestore patch derived from a subscription object. */
function subscriptionPatch(sub: Stripe.Subscription): Record<string, unknown> {
  const { plan, subscriptionStatus } = mapSubscriptionToPlan(sub);
  return {
    plan,
    subscriptionStatus,
    currentPeriodEnd: periodEndISO(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
  };
}

/** A patch, or a builder for one given the settings doc as it stands today. */
type DatedPatch =
  | Record<string, unknown>
  | ((existing: Record<string, unknown>) => Record<string, unknown>);

/**
 * Apply an entitlement patch, but ONLY if this event is at least as recent as
 * the last subscription-lifecycle event applied for this user.
 *
 * Stripe does not guarantee delivery order and retries for ~3 days, so a delayed
 * OLDER event can arrive after a newer one. Left unguarded that means a retried
 * `invoice.paid` from before a cancellation writes `subscriptionStatus: "active"`
 * over a `deleted` that already downgraded the user — resurrecting paid access
 * for someone who no longer has a subscription. Every branch that writes plan or
 * status therefore goes through here.
 *
 * TWO ROLES, DELIBERATELY SPLIT:
 *
 *  - `advanceClock: true` — the `customer.subscription.*` events, which define
 *    what "current" means and stamp `lastSubscriptionEventAt`.
 *  - default (false) — invoice and checkout events, which RESPECT the clock but
 *    must not SET it. An `invoice.paid` and its `customer.subscription.updated`
 *    are seconds apart and can arrive either way round; if the invoice stamped
 *    the clock it would reject the update that actually carries the plan, and a
 *    fix for a resurrection bug would have become an upgrade-never-applies bug.
 *
 * `always` is for fields that carry no entitlement (the Stripe ids resolveUid
 * indexes on) and so are written even when the dated half is skipped.
 *
 * Returns false when the dated half was skipped as stale.
 *
 * (Read-then-set rather than a transaction: Stripe delivers a given
 * subscription's events sequentially, so the out-of-order case this guards is
 * time-separated retries, not concurrent writes.)
 */
async function applySubscriptionEvent(
  uid: string,
  eventCreated: number,
  dated: DatedPatch,
  opts: { advanceClock?: boolean; always?: Record<string, unknown> } = {}
): Promise<boolean> {
  const ref = db.collection("userSettings").doc(uid);
  const existing = (await ref.get()).data() ?? {};
  const fresh = eventCreated >= ((existing.lastSubscriptionEventAt as number | undefined) ?? 0);

  const patch: Record<string, unknown> = { ...opts.always };
  if (fresh) {
    Object.assign(patch, typeof dated === "function" ? dated(existing) : dated);
    if (opts.advanceClock) patch.lastSubscriptionEventAt = eventCreated;
  }

  // A stale event with nothing unconditional to write does not touch Firestore.
  if (Object.keys(patch).length > 0) await ref.set(patch, { merge: true });
  return fresh;
}

/**
 * Resolve our Firebase uid from event data. Order: explicit firebaseUid →
 * lookup by stored stripeCustomerId → read it off the Stripe customer metadata.
 */
async function resolveUid(opts: {
  firebaseUid?: string | null;
  customerId?: string | null;
}): Promise<string | null> {
  if (opts.firebaseUid) return opts.firebaseUid;

  if (opts.customerId) {
    const q = await db
      .collection("userSettings")
      .where("stripeCustomerId", "==", opts.customerId)
      .limit(1)
      .get();
    if (!q.empty) return q.docs[0].id;

    try {
      const customer = await stripe.customers.retrieve(opts.customerId);
      if (!customer.deleted) {
        const uid = customer.metadata?.firebaseUid;
        if (uid) return uid;
      }
    } catch (e) {
      console.error("[stripe/webhook] customer lookup failed:", e);
    }
  }

  console.warn("[stripe/webhook] could not resolve uid for event");
  return null;
}
