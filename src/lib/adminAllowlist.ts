/**
 * Admin / tester allowlist — the ONE place that answers "is this account an admin?".
 *
 * Two env lists, either of which grants full access:
 *   ADMIN_UIDS   — Firebase UIDs. Exact, but a UID only exists after first sign-in.
 *   ADMIN_EMAILS — Google account emails. Lets a tester be allowlisted BEFORE they
 *                  have ever signed in (the chicken-and-egg the UID list can't solve,
 *                  since the beta gate blocks the very sign-in that mints the UID).
 *
 * Email matches require a VERIFIED email. Firebase email/password signup does not
 * verify ownership, so an unverified match would let anyone claim a tester slot by
 * registering that address.
 *
 * SERVER-ONLY (uses the Admin SDK). There is deliberately NO client copy: the client
 * asks GET /api/auth/access, so the list never ships in the public JS bundle.
 *
 * firebase-admin is imported lazily, and only on the email path: importing it eagerly
 * would initialize the SDK (and demand service-account env) in every consumer of the
 * cheap synchronous checks below.
 */

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** UIDs listed directly in ADMIN_UIDS. */
export function adminUids(): Set<string> {
  return new Set(envList("ADMIN_UIDS"));
}

/**
 * UIDs listed in OWNER_UIDS — the operators allowed to run the admin tools
 * (tester-plan assignment, the waitlist email blast, the Finava Live harness).
 *
 * Deliberately a SEPARATE grant from the tester allowlist above. ADMIN_UIDS /
 * ADMIN_EMAILS decide who may USE the product during the beta; folding the admin
 * tools into the same list made every tester an operator, able to lift their own
 * plan cap, mail the whole waitlist, or drive the trading harness. UID-only (an
 * operator is never granted by email) and fail-closed: unset means nobody.
 */
export function ownerUids(): Set<string> {
  return new Set(envList("OWNER_UIDS"));
}

/** Is this UID an operator (OWNER_UIDS)? Sync, no I/O. */
export function isOwnerUid(userId: string): boolean {
  return ownerUids().has(userId);
}

/** Emails listed in ADMIN_EMAILS, lowercased for case-insensitive comparison. */
export function adminEmails(): Set<string> {
  return new Set(envList("ADMIN_EMAILS").map((e) => e.toLowerCase()));
}

/**
 * Does this (email, verified) pair match the email allowlist? Cheap and synchronous
 * — use it wherever a decoded token is already in hand.
 */
export function isAdminEmail(
  email: string | undefined,
  emailVerified: boolean | undefined
): boolean {
  if (!email || !emailVerified) return false;
  return adminEmails().has(email.toLowerCase());
}

// Email -> UID resolution is a network call, so memoize it. Short TTL so edits to
// ADMIN_EMAILS (and testers signing in for the first time) take effect without a
// redeploy, and so a removed tester loses access promptly.
const EMAIL_UID_TTL_MS = 60_000;
let emailUidCache: { at: number; key: string; uids: Set<string> } | null = null;

/** UIDs of the accounts behind ADMIN_EMAILS. Skips emails with no (verified) account. */
async function adminEmailUids(): Promise<Set<string>> {
  const emails = [...adminEmails()];
  const key = emails.join(",");
  if (
    emailUidCache &&
    emailUidCache.key === key &&
    Date.now() - emailUidCache.at < EMAIL_UID_TTL_MS
  ) {
    return emailUidCache.uids;
  }

  const { adminAuth } = await import("@/lib/firebase-admin");
  const uids = new Set<string>();
  await Promise.all(
    emails.map(async (email) => {
      try {
        const user = await adminAuth.getUserByEmail(email);
        // Same verification rule as isAdminEmail — an unverified account must not
        // inherit a tester slot just by holding the address.
        if (user.emailVerified) uids.add(user.uid);
      } catch {
        // auth/user-not-found: allowlisted but hasn't signed in yet. Not an error —
        // they resolve on a later pass, once the account exists.
      }
    })
  );

  emailUidCache = { at: Date.now(), key, uids };
  return uids;
}

/**
 * Is this UID an admin/tester? Checks ADMIN_UIDS first (no I/O), then resolves
 * ADMIN_EMAILS to UIDs (cached).
 */
export async function isAdminUid(userId: string): Promise<boolean> {
  if (adminUids().has(userId)) return true;
  if (adminEmails().size === 0) return false;
  return (await adminEmailUids()).has(userId);
}

/** Test seam: drop the memoized email->UID resolution. */
export function __resetAdminAllowlistCache(): void {
  emailUidCache = null;
}
