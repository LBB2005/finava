/**
 * Beta-tester plan assignment.
 *
 * Every allowlisted account resolves to Quant with no caps (see
 * `entitlements.resolvePlan`), which is what made the credit system untestable:
 * the only people who could try the product were the only people who could never
 * hit a limit. 0 of 50 testers would pay, and none of them had ever seen what
 * they would be paying for.
 *
 * So an admin can put an allowlisted tester on a REAL plan: `betaPlan` in their
 * `userSettings` doc, which `resolvePlan` honours ahead of the admin shortcut.
 * They then live inside that plan's allowances and per-run caps exactly as a
 * paying subscriber would.
 *
 * Two deliberate limits:
 *   - the target must already be on the admin allowlist (ADMIN_UIDS /
 *     ADMIN_EMAILS). This grants a plan without Stripe, so it is confined to
 *     accounts an admin already trusted.
 *   - Stripe stays the source of truth for paying customers: this writes
 *     `betaPlan`, never `plan`/`subscriptionStatus`, so a real subscription can
 *     never be created, upgraded or clobbered from here.
 *
 * SERVER-ONLY (Firestore + Admin SDK).
 */
import { db } from "@/lib/firebase-admin";
import { isAdminUid } from "@/lib/adminAllowlist";
import { forgetTesterPlan } from "@/lib/entitlements";
import { PLAN_ORDER, type PlanName } from "@/lib/plans";

export interface TesterPlanTarget {
  /** Firebase UID. Provide this or `email`. */
  uid?: string;
  email?: string;
}

export type TesterPlanOutcome =
  | { ok: true; uid: string; plan: PlanName | null }
  | { ok: false; status: 400 | 404 | 403; error: string };

/** Is `plan` one of the real tiers? Narrows an untrusted body value. */
export function isPlanName(value: unknown): value is PlanName {
  return typeof value === "string" && (PLAN_ORDER as string[]).includes(value);
}

/** Resolve a target to a UID. An email that has never signed in has no account yet. */
async function resolveUid(target: TesterPlanTarget): Promise<
  { uid: string } | { error: "no_target" | "no_account" }
> {
  if (target.uid) return { uid: target.uid };
  if (!target.email) return { error: "no_target" };
  try {
    const { adminAuth } = await import("@/lib/firebase-admin");
    const user = await adminAuth.getUserByEmail(target.email);
    return { uid: user.uid };
  } catch {
    return { error: "no_account" };
  }
}

/**
 * Put an allowlisted tester on `plan`, or pass null to hand them their normal
 * full admin access back.
 */
export async function assignTesterPlan(
  target: TesterPlanTarget,
  plan: PlanName | null
): Promise<TesterPlanOutcome> {
  const resolved = await resolveUid(target);
  if ("error" in resolved) {
    return resolved.error === "no_target"
      ? { ok: false, status: 400, error: "Provide a uid or an email." }
      : {
          ok: false,
          status: 404,
          error: "No account for that email yet — the tester has to sign in once first.",
        };
  }
  const { uid } = resolved;

  if (!(await isAdminUid(uid))) {
    return {
      ok: false,
      status: 403,
      error:
        "That account is not on the tester allowlist. Add it to ADMIN_UIDS / ADMIN_EMAILS first — " +
        "a plan is never granted outside Stripe to an account nobody vouched for.",
    };
  }

  await db
    .collection("userSettings")
    .doc(uid)
    .set(
      {
        betaPlan: plan,
        betaPlanSetAt: plan ? new Date().toISOString() : null,
      },
      { merge: true }
    );
  // resolvePlan memoizes the assignment for a minute; drop it so the admin sees
  // the change on their very next request instead of wondering if it worked.
  forgetTesterPlan(uid);

  return { ok: true, uid, plan };
}

/** The plan currently assigned to a tester, or null when they have none. */
export async function readTesterPlan(
  target: TesterPlanTarget
): Promise<TesterPlanOutcome> {
  const resolved = await resolveUid(target);
  if ("error" in resolved) {
    return resolved.error === "no_target"
      ? { ok: false, status: 400, error: "Provide a uid or an email." }
      : { ok: false, status: 404, error: "No account for that email yet." };
  }
  // Same rule as assignTesterPlan: this only answers for allowlisted testers, so
  // it can't double as an "is this email registered, and what's its UID" oracle.
  if (!(await isAdminUid(resolved.uid))) {
    return { ok: false, status: 403, error: "That account is not on the tester allowlist." };
  }
  const snap = await db.collection("userSettings").doc(resolved.uid).get();
  const stored = snap.data()?.betaPlan;
  return { ok: true, uid: resolved.uid, plan: isPlanName(stored) ? stored : null };
}
