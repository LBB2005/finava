import { NextResponse } from "next/server";
import { MAX_PLAID_ITEMS, plaidClient, plaidConfigured, plaidItemLimitReached } from "@/lib/plaid";
import { requireAuth } from "@/lib/requireAuth";
import { requireEntitlement } from "@/lib/entitlements";
import { db } from "@/lib/firebase-admin";
import { rebuildHoldings } from "@/lib/plaidSync";
import { encryptSecret } from "@/lib/crypto";

/**
 * Exchanges a Plaid Link public_token for a long-lived access_token, stores the
 * Item server-side in Firestore, then runs an initial holdings sync.
 *
 * The access_token is a secret and never leaves the server.
 */
export async function POST(req: Request) {
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
    const { public_token, institution } = await req.json();
    if (!public_token || typeof public_token !== "string") {
      return NextResponse.json({ error: "public_token is required" }, { status: 400 });
    }

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    // Persist the Item server-side (admin SDK → never exposed to client).
    const now = new Date().toISOString();
    await db
      .collection("users")
      .doc(userId)
      .collection("plaidItems")
      .doc(itemId)
      .set({
        itemId,
        // Encrypted at rest (AES-256-GCM) — the raw token never touches Firestore.
        accessToken: encryptSecret(accessToken),
        institutionName: institution?.name ?? null,
        institutionId: institution?.institution_id ?? null,
        createdAt: now,
        lastSyncedAt: now,
      });

    // Replace the whole book with the Plaid book (across all linked items).
    const summary = await rebuildHoldings(userId);

    await db
      .collection("users")
      .doc(userId)
      .collection("plaidItems")
      .doc(itemId)
      .update({ lastSyncedAt: new Date().toISOString() });

    return NextResponse.json({ ok: true, institution: institution?.name ?? null, ...summary });
  } catch (err: unknown) {
    const detail =
      typeof err === "object" && err !== null && "response" in err
        ? (err as { response?: { data?: unknown } }).response?.data
        : undefined;
    console.error("[plaid exchange]", detail ?? err);
    return NextResponse.json({ error: "Failed to link account" }, { status: 500 });
  }
}
