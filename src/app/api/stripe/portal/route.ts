/**
 * Open the Stripe Customer Portal so a user can manage their subscription,
 * update their card, view invoices, or cancel. Returns the hosted portal URL.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { requireAuth } from "@/lib/requireAuth";
import { stripe, stripeConfigured, billingBaseUrl } from "@/lib/stripe";

export const runtime = "nodejs";

export async function POST() {
  const { userId, error } = await requireAuth();
  if (error) return error;

  if (!stripeConfigured()) {
    return NextResponse.json({ error: "Billing not configured." }, { status: 503 });
  }

  const snap = await db.collection("userSettings").doc(userId).get();
  const customerId = snap.data()?.stripeCustomerId as string | undefined;
  if (!customerId) {
    // No Stripe customer yet — nothing to manage. The UI should route these
    // users to checkout instead.
    return NextResponse.json({ error: "no_customer" }, { status: 404 });
  }

  const appUrl = billingBaseUrl();
  if (!appUrl) {
    console.error("[stripe] NEXT_PUBLIC_APP_URL is not set; refusing to build return URLs");
    return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/settings?section=billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe/portal]", err);
    return NextResponse.json(
      { error: "Could not open billing portal." },
      { status: 502 }
    );
  }
}
