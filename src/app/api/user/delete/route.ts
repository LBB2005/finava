import { NextResponse } from "next/server";
import { adminAuth, db, deleteRefsInBatches } from "@/lib/firebase-admin";
import { requireAuth } from "@/lib/requireAuth";
import { plaidClient, plaidConfigured } from "@/lib/plaid";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { decryptSecret } from "@/lib/crypto";
import { normalizeMailbox } from "@/lib/email/normalize";

/**
 * Permanently delete the authenticated user's account and all associated data
 * (GDPR/CCPA right to erasure; wired to Settings → Privacy & Data → Delete).
 *
 * Order matters: external revocations (Plaid tokens, Stripe subscriptions) run
 * first and are best-effort — a third-party outage must not leave the user
 * unable to delete their data. Firestore + the Auth record are deleted last so
 * a partial failure can be retried by the still-existing user.
 */
export async function POST() {
  const { userId, error } = await requireAuth();
  if (error) return error;

  try {
    const userRef = db.collection("users").doc(userId);
    const settingsRef = db.collection("userSettings").doc(userId);

    // Captured before the Auth record disappears — needed for waitlist cleanup.
    const email = await adminAuth
      .getUser(userId)
      .then((u) => u.email ?? null)
      .catch(() => null);

    // 0. Kill outstanding sessions FIRST. An ID token already in the caller's
    //    browser stays signature-valid for up to an hour, and `userId` is just a
    //    string to every route — without this, a request racing the wipe (or a
    //    stale tab retrying) writes holdings/conversations straight back under
    //    users/{uid}, resurrecting a "deleted" account that no longer has an Auth
    //    record to sign into. revokeRefreshTokens stamps tokensValidAfterTime, so
    //    requireAuth's checkRevoked pass rejects those tokens immediately.
    //    Best-effort: an Auth outage must not block the erasure itself.
    try {
      await adminAuth.revokeRefreshTokens(userId);
    } catch (e) {
      console.warn("[user delete] token revocation failed (continuing)", e);
    }

    // 1. Revoke Plaid access tokens so they can't be reused (best-effort).
    if (plaidConfigured()) {
      const itemsSnap = await userRef.collection("plaidItems").get();
      await Promise.all(
        itemsSnap.docs.map(async (d) => {
          const { accessToken } = d.data() as { accessToken?: string };
          if (!accessToken) return;
          try {
            await plaidClient.itemRemove({ access_token: decryptSecret(accessToken) });
          } catch (e) {
            console.warn("[user delete] plaid itemRemove failed (continuing)", e);
          }
        })
      );
    }

    // 2. Cancel any active Stripe subscriptions so a deleted account is never
    //    billed again (best-effort). The customer record itself is retained for
    //    accounting/tax records, which GDPR permits.
    if (stripeConfigured()) {
      try {
        const settings = (await settingsRef.get()).data();
        const customerId = settings?.stripeCustomerId as string | undefined;
        if (customerId) {
          const subs = await stripe.subscriptions.list({ customer: customerId, limit: 10 });
          await Promise.all(subs.data.map((s) => stripe.subscriptions.cancel(s.id)));
        }
      } catch (e) {
        console.warn("[user delete] stripe cancel failed (continuing)", e);
      }
    }

    // 3. Firestore: the whole users/{uid} tree (conversations, messages,
    //    briefings, holdings, plaidItems, watchlists, …) plus the user-keyed
    //    top-level docs.
    await db.recursiveDelete(userRef);
    await settingsRef.delete();
    await db.collection("userUsage").doc(userId).delete();

    // Per-user rows in top-level collections, keyed by a userId field rather than
    // living under users/{uid}. tickerMemory holds insights derived from the
    // user's own portfolio and conversations, and has no TTL — it was being left
    // behind by account deletion.
    const memorySnap = await db.collection("tickerMemory").where("userId", "==", userId).get();
    await deleteRefsInBatches(memorySnap.docs.map((d) => d.ref));

    // Shared conversation snapshots the user published.
    const sharesSnap = await db.collection("shares").where("createdBy", "==", userId).get();
    await Promise.all(sharesSnap.docs.map((d) => db.recursiveDelete(d.ref)));

    // Waitlist entry, if their account email is on it.
    // Keyed by exact address on older signups, by mailbox (normalizeMailbox) on newer.
    if (email) {
      for (const key of new Set([email, email.toLowerCase(), normalizeMailbox(email)])) {
        await db.collection("waitlist").doc(key).delete().catch(() => {});
      }
    }

    // 4. Firebase Auth record last. Tolerate user-not-found (e.g. the dev-bypass
    //    user has no real Auth record).
    await adminAuth.deleteUser(userId).catch((e) => {
      if (e?.code !== "auth/user-not-found") throw e;
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[user delete]", err);
    return NextResponse.json({ error: "Failed to delete account" }, { status: 500 });
  }
}
