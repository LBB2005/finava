/**
 * Plan definitions — the SINGLE SOURCE OF TRUTH for tiers, limits, capabilities,
 * and Stripe price wiring.
 *
 * This module is intentionally PURE DATA: no Firestore, no Stripe SDK, no
 * `next/server` imports. That keeps it importable from BOTH server code
 * (`entitlements.ts`, `usage.ts`, the Stripe routes) and client components
 * (the Settings billing UI, the marketing Pricing page) without dragging
 * server-only dependencies into the browser bundle.
 *
 * To change pricing, limits, or what a tier unlocks, edit THIS file only.
 *
 * NOTE: the credit/limit numbers are cost-weighted placeholders — TUNE them
 * against real usage before launch (same convention as `usage.ts`).
 */

// ── Tiers ─────────────────────────────────────────────────────────────────────
export type PlanName = "Free" | "Analyst" | "Pro" | "Quant";

/** Low → high. Used for "what's the cheapest plan that unlocks X" scans. */
export const PLAN_ORDER: PlanName[] = ["Free", "Analyst", "Pro", "Quant"];

export const DEFAULT_PLAN: PlanName = "Free";

// ── Capabilities (boolean feature gates) ──────────────────────────────────────
// Only list a capability here once something actually enforces it — a flag no
// runtime code reads becomes an advertised feature the product doesn't deliver.
export type Capability =
  | "plaidLinking" // connect a live brokerage via Plaid
  | "weeklyBriefings"; // scheduled AI market briefings

export type BillingCadence = "monthly" | "annual";

export interface PlanConfig {
  /** Display label. */
  label: string;
  /** Human-friendly price strings for UI (display only — Stripe is source of truth for charging). */
  price: { monthly: string; annual: string };

  // ── Credit allowances (cost-weighted, enforced by usage.ts) ──
  // A request is blocked when ANY of these is already at/over limit.
  daily: number; // anti-abuse ceiling
  weekly: number;
  monthly: number; // aligns with the billing cycle

  // ── Deep Research (the one explicitly-counted expensive op) ──
  deepResearchPerMonth: number; // Infinity = fair-use unlimited
  deepResearchPerRunCap: number; // credits a single run may consume (soft guard)

  // ── Capability flags ──
  capabilities: Record<Capability, boolean>;

  /** Max number of watchlists (Free is gated; paid tiers unlimited). */
  watchlistLimit: number; // Infinity = unlimited

  // ── Stripe wiring ──
  stripe: {
    /** Env var NAME holding the monthly price id (resolved at request time). */
    monthlyPriceEnv?: string;
    /** Env var NAME holding the annual price id. */
    annualPriceEnv?: string;
    /** False for Quant — created in Stripe but not yet sellable (waitlist). */
    purchasable: boolean;
  };
}

// ── The plan table ────────────────────────────────────────────────────────────
export const PLANS: Record<PlanName, PlanConfig> = {
  Free: {
    label: "Free",
    price: { monthly: "$0", annual: "$0" },
    daily: 60, // TUNE
    weekly: 200, // TUNE
    monthly: 400, // TUNE — ~ a thin conversion taste
    deepResearchPerMonth: 2, // TUNE — "2 crew runs to feel the wow"
    deepResearchPerRunCap: 300, // TUNE — ~$0.30
    capabilities: {
      plaidLinking: false,
      weeklyBriefings: false,
    },
    watchlistLimit: 1,
    stripe: { purchasable: false },
  },
  Analyst: {
    label: "Analyst",
    price: { monthly: "$20", annual: "$200" },
    daily: 400, // TUNE
    weekly: 1500, // TUNE
    monthly: 4000, // TUNE
    deepResearchPerMonth: 30, // TUNE — "30 / month (5 / day)"
    deepResearchPerRunCap: 300, // TUNE
    capabilities: {
      plaidLinking: true,
      weeklyBriefings: true,
    },
    watchlistLimit: Infinity,
    stripe: {
      monthlyPriceEnv: "STRIPE_PRICE_ANALYST_MONTHLY",
      annualPriceEnv: "STRIPE_PRICE_ANALYST_ANNUAL",
      purchasable: true,
    },
  },
  Pro: {
    label: "Pro",
    price: { monthly: "$60", annual: "$600" },
    daily: 1200, // TUNE
    weekly: 5000, // TUNE
    monthly: 15000, // TUNE
    deepResearchPerMonth: Infinity, // fair-use (backstopped by daily/weekly credits)
    deepResearchPerRunCap: 300, // TUNE
    capabilities: {
      plaidLinking: true,
      weeklyBriefings: true,
    },
    watchlistLimit: Infinity,
    stripe: {
      monthlyPriceEnv: "STRIPE_PRICE_PRO_MONTHLY",
      annualPriceEnv: "STRIPE_PRICE_PRO_ANNUAL",
      purchasable: true,
    },
  },
  Quant: {
    label: "Quant",
    price: { monthly: "$100", annual: "$1000" },
    daily: 3000, // TUNE
    weekly: 12000, // TUNE
    monthly: 40000, // TUNE
    deepResearchPerMonth: Infinity,
    deepResearchPerRunCap: 300, // TUNE
    capabilities: {
      plaidLinking: true,
      weeklyBriefings: true,
    },
    watchlistLimit: Infinity,
    stripe: {
      monthlyPriceEnv: "STRIPE_PRICE_QUANT_MONTHLY",
      annualPriceEnv: "STRIPE_PRICE_QUANT_ANNUAL",
      // Created in Stripe (inactive) so the price ids exist. Quant is the
      // internal full-access level (admins resolve to it); it is not sold.
      purchasable: false,
    },
  },
};

// ── Trial ─────────────────────────────────────────────────────────────────────
export const TRIAL_DAYS = 3;
/** Entitlement level granted during the no-card trial. */
export const TRIAL_PLAN: PlanName = "Pro";
/** Total Deep Research runs allowed across the WHOLE trial (anti-abuse). */
export const TRIAL_DEEP_RESEARCH_CAP = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Look up the config for a plan, defaulting safely to Free for unknown values. */
export function planConfig(plan: string | undefined | null): PlanConfig {
  return PLANS[(plan as PlanName) ?? DEFAULT_PLAN] ?? PLANS[DEFAULT_PLAN];
}

/** Resolve the env var name to a concrete Stripe price id (or null if unset). */
export function priceIdFor(
  plan: PlanName,
  cadence: BillingCadence
): string | null {
  const cfg = PLANS[plan];
  const envName =
    cadence === "monthly" ? cfg.stripe.monthlyPriceEnv : cfg.stripe.annualPriceEnv;
  if (!envName) return null;
  return process.env[envName] ?? null;
}

/**
 * Reverse map a Stripe price id → our plan + cadence. Built lazily from env so a
 * webhook can translate an incoming subscription's price back to a tier.
 */
export function planForPriceId(
  priceId: string
): { plan: PlanName; cadence: BillingCadence } | null {
  for (const plan of PLAN_ORDER) {
    const cfg = PLANS[plan];
    if (cfg.stripe.monthlyPriceEnv && process.env[cfg.stripe.monthlyPriceEnv] === priceId) {
      return { plan, cadence: "monthly" };
    }
    if (cfg.stripe.annualPriceEnv && process.env[cfg.stripe.annualPriceEnv] === priceId) {
      return { plan, cadence: "annual" };
    }
  }
  return null;
}

/** The cheapest plan (in PLAN_ORDER) that grants `capability`, or null if none. */
export function planGranting(capability: Capability): PlanName | null {
  for (const plan of PLAN_ORDER) {
    if (PLANS[plan].capabilities[capability]) return plan;
  }
  return null;
}

/** The next paid tier above `plan` (used for "upgrade" CTAs). */
export function nextPaidPlan(plan: PlanName): PlanName {
  const idx = PLAN_ORDER.indexOf(plan);
  for (let i = idx + 1; i < PLAN_ORDER.length; i++) {
    if (PLANS[PLAN_ORDER[i]].stripe.purchasable) return PLAN_ORDER[i];
  }
  // Already at/above the top purchasable tier — point at the highest paid one.
  return "Pro";
}

/**
 * JSON-safe limit: `Infinity` does not survive `JSON.stringify` (becomes null
 * implicitly / NaN), so convert unlimited limits to `null` at API boundaries.
 * The UI renders `null` as "Unlimited".
 */
export function jsonLimit(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}
