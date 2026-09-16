/**
 * Entitlement resolution — the ONE place that answers "what can this user do?".
 *
 * Plan is SERVER-AUTHORITATIVE: only the Stripe webhook writes `plan`/subscription
 * state into `userSettings`. Everything that gates a feature or a quota resolves
 * through `resolvePlan()` here, so the rules live in exactly one function.
 *
 * SERVER-ONLY (reads Firestore). Do not import from client components.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { isAdminUid } from "@/lib/adminAllowlist";
import {
  PLANS,
  PLAN_ORDER,
  DEFAULT_PLAN,
  TRIAL_PLAN,
  planConfig,
  planGranting,
  type Capability,
  type PlanConfig,
  type PlanName,
} from "@/lib/plans";

export type EntitlementSource =
  | "admin" // ADMIN_UIDS / ADMIN_EMAILS — full access
  | "beta_plan" // allowlisted tester an admin put on a real plan (W3-4)
  | "dev" // dev-bypass user in non-production
  | "subscription" // active/grace paid plan
  | "trial" // inside the 3-day no-card trial
  | "free"; // default floor

export interface ResolvedEntitlement {
  plan: PlanName;
  source: EntitlementSource;
  config: PlanConfig;
  trialEndsAt: string | null;
  subscriptionStatus: string | null;
  /**
   * True when we couldn't read Firestore. Callers decide how to treat it:
   * usage checks fail OPEN (allow), capability checks fail CLOSED (deny).
   */
  degraded: boolean;
}

/** Statuses that should still grant the paid plan (past_due = grace period). */
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

/** How long a `past_due` (failing card) keeps paid access before dropping to Free. */
const PAST_DUE_GRACE_DAYS = 7;

/**
 * True when a past_due grace window has elapsed. Lenient on a missing/invalid
 * `pastDueSince`: we don't cut off a paying user just because the start wasn't
 * recorded — the subscription reconciliation cron is the backstop for a
 * genuinely-lapsed account.
 */
function pastDueGraceExpired(pastDueSince: string | null): boolean {
  if (!pastDueSince) return false;
  const started = Date.parse(pastDueSince);
  if (Number.isNaN(started)) return false;
  return Date.now() > started + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

function entitlement(
  plan: PlanName,
  source: EntitlementSource,
  extra: Partial<ResolvedEntitlement> = {}
): ResolvedEntitlement {
  return {
    plan,
    source,
    config: PLANS[plan],
    trialEndsAt: null,
    subscriptionStatus: null,
    degraded: false,
    ...extra,
  };
}

/**
 * A tester's assigned plan, memoized.
 *
 * The admin path used to answer with no Firestore read at all, and during the
 * private beta every signed-in account is an admin — so an uncached read here
 * would add a round trip to every `resolvePlan()` call (and there are several per
 * request). The TTL is short enough that assigning or clearing a plan takes
 * effect while the admin is still watching, and long enough that a normal
 * request pays for at most one read.
 */
const BETA_PLAN_TTL_MS = 60_000;
const betaPlanCache = new Map<string, { at: number; plan: PlanName | null }>();

async function adminBetaPlan(userId: string): Promise<PlanName | null> {
  const hit = betaPlanCache.get(userId);
  if (hit && Date.now() - hit.at < BETA_PLAN_TTL_MS) return hit.plan;
  let plan: PlanName | null = null;
  try {
    const stored = (await db.collection("userSettings").doc(userId).get()).data()?.betaPlan;
    if (typeof stored === "string" && PLANS[stored as PlanName]) plan = stored as PlanName;
  } catch {
    // Unreadable settings never cost an admin their access — the allowlist is
    // the grant, and it doesn't depend on Firestore being up.
    return null;
  }
  betaPlanCache.set(userId, { at: Date.now(), plan });
  return plan;
}

/** Test seam / admin-write seam: drop a memoized tester-plan assignment. */
export function forgetTesterPlan(userId?: string): void {
  if (userId) betaPlanCache.delete(userId);
  else betaPlanCache.clear();
}

/**
 * Resolve a user's effective entitlement.
 *
 * Precedence (highest wins):
 *   1. dev-bypass user → Quant (full access), before any Firestore read so local
 *      dev works with no doc.
 *   2. Allowlisted admin (UID or verified email) → Quant, UNLESS an admin has put
 *      them on a real plan for beta testing (`betaPlan`), in which case they live
 *      inside that plan's allowances and caps like any subscriber.
 *   3. Active paid subscription (status active|trialing|past_due) → that plan.
 *      Paid ALWAYS beats trial.
 *   4. Trial still running (trialEndsAt in the future) → Pro-level.
 *   5. Else → Free.
 */
export async function resolvePlan(userId: string): Promise<ResolvedEntitlement> {
  // 1. Dev bypass — no Firestore needed.
  if (userId === "dev-user" && process.env.NODE_ENV !== "production") {
    return entitlement("Quant", "dev");
  }
  // 2. Admin. Full access, unless an admin assigned this tester a real plan so
  //    they can see the product the way a paying customer does (W3-4).
  if (await isAdminUid(userId)) {
    const betaPlan = await adminBetaPlan(userId);
    return betaPlan
      ? entitlement(betaPlan, "beta_plan")
      : entitlement("Quant", "admin");
  }

  let data: FirebaseFirestore.DocumentData | undefined;
  try {
    const snap = await db.collection("userSettings").doc(userId).get();
    data = snap.data();
  } catch (e) {
    console.error("[entitlements] settings read failed (degraded):", e);
    // Degraded: return Free but flag it so callers can fail open/closed per-context.
    return entitlement(DEFAULT_PLAN, "free", { degraded: true });
  }

  const storedPlan = (data?.plan as PlanName | undefined) ?? DEFAULT_PLAN;
  const subscriptionStatus = (data?.subscriptionStatus as string | undefined) ?? null;
  const trialEndsAt = (data?.trialEndsAt as string | undefined) ?? null;
  const pastDueSince = (data?.pastDueSince as string | undefined) ?? null;

  // 3. Active paid subscription. A past_due (failing-card) subscription keeps
  //    paid access only within the grace window — not indefinitely.
  if (
    storedPlan !== "Free" &&
    subscriptionStatus &&
    PAID_STATUSES.has(subscriptionStatus) &&
    !(subscriptionStatus === "past_due" && pastDueGraceExpired(pastDueSince))
  ) {
    return entitlement(storedPlan, "subscription", {
      subscriptionStatus,
      trialEndsAt,
    });
  }

  // 4. Trial in progress.
  if (trialEndsAt && Date.parse(trialEndsAt) > Date.now()) {
    return entitlement(TRIAL_PLAN, "trial", { trialEndsAt, subscriptionStatus });
  }

  // 5. Free floor.
  return entitlement(DEFAULT_PLAN, "free", { subscriptionStatus, trialEndsAt });
}

/**
 * Capability gate. Returns null when granted, or a 403 NextResponse when not.
 * FAILS CLOSED on a degraded read — a Firestore blip must never hand someone
 * brokerage access they have not paid for.
 *
 * Call right after requireAuth() in a gated route:
 *   const gate = await requireEntitlement(userId, "plaidLinking");
 *   if (gate) return gate;
 */
export async function requireEntitlement(
  userId: string,
  capability: Capability
): Promise<NextResponse | null> {
  const ent = await resolvePlan(userId);

  if (ent.degraded) {
    return NextResponse.json(
      { error: "entitlement_unavailable", capability },
      { status: 503 }
    );
  }

  if (ent.config.capabilities[capability]) return null;

  return NextResponse.json(
    {
      error: "entitlement_required",
      capability,
      plan: ent.plan,
      upgradeTo: planGranting(capability),
    },
    { status: 403 }
  );
}

/** The JSON-safe capability map for a resolved entitlement (for the client UI). */
export function capabilitiesFor(plan: PlanName): Record<Capability, boolean> {
  return PLANS[plan].capabilities;
}

/** Max watchlists for a user (Infinity for paid tiers). */
export async function getWatchlistLimit(userId: string): Promise<number> {
  const ent = await resolvePlan(userId);
  return ent.config.watchlistLimit;
}

/**
 * Enforce the watchlist count cap. Returns a 403 when the user is at/over their
 * limit, or null when they may create another. `currentCount` is the number of
 * watchlists they already have.
 */
export async function assertWatchlistQuota(
  userId: string,
  currentCount: number
): Promise<NextResponse | null> {
  const ent = await resolvePlan(userId);
  const limit = ent.config.watchlistLimit;
  if (currentCount < limit) return null;

  return NextResponse.json(
    {
      error: "watchlist_limit",
      plan: ent.plan,
      limit: Number.isFinite(limit) ? limit : null,
      upgradeTo: PLAN_ORDER.find((p) => PLANS[p].watchlistLimit > limit) ?? "Analyst",
    },
    { status: 403 }
  );
}

export { planConfig };
