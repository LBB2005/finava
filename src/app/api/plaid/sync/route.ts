import { NextResponse } from "next/server";
import { plaidConfigured } from "@/lib/plaid";
import { requireAuth } from "@/lib/requireAuth";
import { requireEntitlement } from "@/lib/entitlements";
import { db } from "@/lib/firebase-admin";
import { rebuildHoldings } from "@/lib/plaidSync";

/**
 * Re-pulls holdings for every Plaid Item the user has linked and rebuilds the
 * book (reflecting buys/sells since last sync). Backs the "Refresh" action.
 */
export async function POST() {
  const { userId, error } = await requireAuth();
  if (error) return error;
  // Linking is gated at Analyst+, so refreshing must be too — otherwise a user
  // who links and then downgrades keeps pulling brokerage data for free.
  const gate = await requireEntitlement(userId, "plaidLinking");
  if (gate) return gate;

  if (!plaidConfigured()) {
    return NextResponse.json(
      { error: "Plaid is not configured (missing PLAID_CLIENT_ID/PLAID_SECRET)" },
      { status: 503 }
    );
  }

  try {
    const itemsCol = db.collection("users").doc(userId).collection("plaidItems");
    const snap = await itemsCol.get();

    if (snap.empty) {
      return NextResponse.json({ ok: true, items: 0, imported: 0 });
    }

    const summary = await rebuildHoldings(userId);

    const now = new Date().toISOString();
    await Promise.all(snap.docs.map((d) => d.ref.update({ lastSyncedAt: now })));

    return NextResponse.json({ ok: true, items: snap.size, ...summary });
  } catch (err: unknown) {
    const detail =
      typeof err === "object" && err !== null && "response" in err
        ? (err as { response?: { data?: unknown } }).response?.data
        : undefined;
    console.error("[plaid sync]", detail ?? err);
    return NextResponse.json({ error: "Failed to sync holdings" }, { status: 500 });
  }
}
