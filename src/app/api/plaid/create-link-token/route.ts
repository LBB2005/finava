import { NextResponse } from "next/server";
import { CountryCode, Products } from "plaid";
import { MAX_PLAID_ITEMS, plaidClient, plaidConfigured, plaidItemLimitReached } from "@/lib/plaid";
import { db } from "@/lib/firebase-admin";
import { requireAuth } from "@/lib/requireAuth";
import { requireEntitlement } from "@/lib/entitlements";

/**
 * Creates a short-lived Plaid Link token scoped to the Investments product.
 * The client uses it to open Plaid Link; nothing here touches the user's data.
 */
export async function POST() {
  const { userId, error } = await requireAuth();
  if (error) return error;
  const gate = await requireEntitlement(userId, "plaidLinking");
  if (gate) return gate;

  if (!plaidConfigured()) {
    return NextResponse.json(
      { error: "Plaid is not configured (missing PLAID_CLIENT_ID/PLAID_SECRET)" },
      { status: 503 }
    );
  }

  // Plaid bills per Item: cap the connections one user can create (see MAX_PLAID_ITEMS).
  const itemCount = (
    await db.collection("users").doc(userId).collection("plaidItems").count().get()
  ).data().count;
  if (plaidItemLimitReached(itemCount)) {
    return NextResponse.json(
      { error: "connection_limit", message: `You can link up to ${MAX_PLAID_ITEMS} brokerage connections. Disconnect one first.` },
      { status: 409 }
    );
  }

  try {
    const res = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: "Finava",
      products: [Products.Investments],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    return NextResponse.json({ link_token: res.data.link_token });
  } catch (err: unknown) {
    const detail =
      typeof err === "object" && err !== null && "response" in err
        ? (err as { response?: { data?: unknown } }).response?.data
        : undefined;
    console.error("[plaid create-link-token]", detail ?? err);
    return NextResponse.json({ error: "Failed to create link token" }, { status: 500 });
  }
}
