/**
 * Create a Stripe Checkout Session for a subscription and return its hosted URL.
 * The client redirects the browser to that URL; Stripe handles all card UI.
 *
 * The subscription/plan is NOT granted here — only the webhook
 * (`checkout.session.completed` → `customer.subscription.*`) writes plan state.
 */
import { NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { requireAuth } from "@/lib/requireAuth";
import { stripe, stripeConfigured, getOrCreateCustomer, billingBaseUrl } from "@/lib/stripe";
import { PLANS, priceIdFor, type BillingCadence, type PlanName } from "@/lib/plans";

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
  if (!cfg) {
    return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
  }
  if (!cfg.stripe.purchasable) {
    // Quant — exists in Stripe but not sellable yet (waitlist).
    return NextResponse.json(
      { error: "plan_not_purchasable", plan },
      { status: 400 }
    );
  }

  const priceId = priceIdFor(plan, cadence);
  if (!priceId) {
    return NextResponse.json(
      { error: `Price not configured for ${plan}/${cadence}.` },
      { status: 503 }
    );
  }

  // Best-effort email (dev-user has no Firebase record — fine, email is optional).
  let email: string | null = null;
  try {
    email = (await adminAuth.getUser(userId)).email ?? null;
  } catch {
    /* no-op */
  }

  const appUrl = billingBaseUrl();
  if (!appUrl) {
    console.error("[stripe] NEXT_PUBLIC_APP_URL is not set; refusing to build return URLs");
    return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });
  }

  try {
    const customerId = await getOrCreateCustomer(userId, email);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      // Carry the uid on the subscription too, so the webhook can map back even
      // if the customer-id write hadn't landed yet.
      subscription_data: { metadata: { firebaseUid: userId } },
      allow_promotion_codes: true,
      success_url: `${appUrl}/settings?section=billing&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/settings?section=billing&checkout=cancel`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe/checkout]", err);
    return NextResponse.json(
      { error: "Could not start checkout." },
      { status: 502 }
    );
  }
}
