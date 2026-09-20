import { createHash } from "node:crypto";
import type { UserRecord } from "firebase-admin/auth";

/**
 * Hashed ids for each sign-in identity on the account (e.g. the Google account's
 * stable `sub`). They key `trialLedger`, which deliberately OUTLIVES account
 * deletion: deleting the account wipes userSettings, and signing in again with
 * the same Google account mints a new Firebase UID — so without the ledger,
 * "delete account, sign back in" re-farmed a fresh Pro trial (and credits)
 * every time. Hashed, and holding only a date, so the ledger keeps no readable
 * identity after erasure.
 */
export function trialIdentityKeys(user: Pick<UserRecord, "providerData">): string[] {
  return (user.providerData ?? [])
    .filter((p) => p.providerId && p.uid)
    .map((p) => createHash("sha256").update(`${p.providerId}:${p.uid}`).digest("hex"));
}
