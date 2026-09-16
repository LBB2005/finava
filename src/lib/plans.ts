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
 * The credit numbers are set from a measurement, not guessed: per-run costs
 * from `scripts/measure-run-cost.ts` (30 real runs, Sep 2026), and allowances
 * sized so a subscriber who uses 100% of their credits still leaves a ≥ 70%
 * gross margin. The working is in `docs/pricing/run-cost-2026-09.md` — re-run
 * the script and update that doc before changing a number here.
 */

// ── Tiers ─────────────────────────────────────────────────────────────────────
export type PlanName = "Free" | "Analyst" | "Pro" | "Quant";

/**
 * The four ways a run can spend money. Cost per run differs by an order of
 * magnitude between them (one Haiku answer vs. a 15-agent deep crew), so a
 * single per-run cap either strangles the cheap lane or fails to bound the
 * expensive one. Measured p90s per lane live in
 * `docs/pricing/run-cost-2026-09.md`.
 */
export type RunLane = "fast" | "full" | "deep" | "discover";

export const RUN_LANES: RunLane[] = ["fast", "full", "deep", "discover"];

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

  /**
   * Credits a SINGLE run may consume, per lane. A run that crosses its cap stops
   * and ships what it has with a plain-English note — it is never a silent abort.
   * Set at ~1.5x each lane's measured p90 (see docs/pricing/run-cost-2026-09.md),
   * so a normal run never sees a cap and only a runaway does.
   */
  perRunCap: Record<RunLane, number>;

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

// ── Credit value ──────────────────────────────────────────────────────────────
/**
 * What one displayed credit is worth in model spend. 1 credit = a tenth of a
 * cent, which keeps the numbers readable (a ~2k-in / 1k-out Sonnet chat ≈ 21
 * credits). Lives here with the rest of the pricing data: allowances, per-run
 * caps and marketing copy all convert through it, and `usage.ts` re-exports it
 * for the metering call-sites.
 */
export const CREDIT_USD = 0.001;

/** Credits → USD, rounded to a hundredth of a cent. */
export function creditsToUsd(credits: number): number {
  return Math.round(credits * CREDIT_USD * 10_000) / 10_000;
}

// ── Per-run caps (shared by every tier) ───────────────────────────────────────
/**
 * A run costs what it costs — the same question asked by a Free user and a Quant
 * user does the same work. So the per-run ceiling is a RUNAWAY guard, not a tier
 * differentiator: every plan gets the same lane caps, and what actually separates
 * the tiers is how many runs their monthly credit allowance buys.
 *
 * Each cap is ~1.5x the lane's measured p90, rounded up to a round number, so a
 * normal run never sees it and only a runaway does. Measured Sep 2026 (credits):
 *
 *   lane      p50    p90    max    → cap
 *   fast      5.3    6.4    7.1    → 20   (see below)
 *   full      188    223    242    → 350
 *   discover  88     91     91     → 150
 *   deep      446    521    521    → 800
 *
 * `fast` is the one exception to 1.5x p90 (which would be 10): the lane is a
 * single Haiku answer bounded by max_tokens at ~16 credits, and a legitimately
 * long answer must not read as a runaway. It has no mid-run abort point either,
 * so its cap is a monitoring threshold (`run_cost_over_cap`), not a kill-switch.
 *
 * The old single cap was 300 credits on every tier. Deep research's MEDIAN run
 * is 446 — every deep run a paying customer started would have been cut off.
 */
export const PER_RUN_CAP: Record<RunLane, number> = {
  fast: 20,
  full: 350,
  deep: 800,
  discover: 150,
};

/**
 * What a typical run costs, per lane — the measured p50 in credits. Used to turn
 * an abstract credit allowance into something a buyer can picture ("≈ 26 full
 * analyses a month"). Measured Sep 2026; see docs/pricing/run-cost-2026-09.md.
 */
export const TYPICAL_RUN_CREDITS: Record<RunLane, number> = {
  fast: 5,
  full: 190,
  deep: 450,
  discover: 90,
};

// ── The plan table ────────────────────────────────────────────────────────────
export const PLANS: Record<PlanName, PlanConfig> = {
  Free: {
    label: "Free",
    price: { monthly: "$0", annual: "$0" },
    // Worst case $0.60/mo per free account: room for one deep run (~450) or
    // three full analyses, which is the "feel the crew" moment. Two deep runs
    // (the old number) never fit inside the old 400-credit month.
    daily: 250,
    weekly: 600,
    monthly: 600,
    deepResearchPerMonth: 1,
    perRunCap: PER_RUN_CAP,
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
    // 4,400 credits = $4.40 max model spend. At 100% use: 73.6% margin monthly,
    // 70.5% annual (the binding case — $200/yr is $16.67/mo). Daily fits one
    // deep run (~520 worst case) plus normal chat.
    daily: 800,
    weekly: 2000,
    monthly: 4400,
    // 30 deep runs (~13,500 credits) could never fit in the month; 8 (~3,600)
    // leaves room for the fast answers and full analyses around them.
    deepResearchPerMonth: 8,
    perRunCap: PER_RUN_CAP,
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
    // 13,500 credits = $13.50. At 100% use: 74.1% monthly, 70.0% annual.
    daily: 2000,
    weekly: 6000,
    monthly: 13500,
    deepResearchPerMonth: Infinity, // limited only by credits (~30 deep runs/month)
    perRunCap: PER_RUN_CAP,
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
    // Was 40,000 — a 57% margin at full use. 22,500 credits = $22.50: 74.3%
    // monthly, 70.1% annual. Not sold today, but it is what admins resolve to.
    daily: 3000,
    weekly: 10000,
    monthly: 22500,
    deepResearchPerMonth: Infinity,
    perRunCap: PER_RUN_CAP,
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

/**
 * The per-run credit ceiling for one lane on one plan. Falls back to the shared
 * table when a plan config predates per-lane caps (a stale cached entitlement, or
 * a test fixture), so the backstop can never be disabled by a missing field.
 */
export function perRunCapFor(
  config: Pick<PlanConfig, "perRunCap"> | undefined | null,
  lane: RunLane
): number {
  return config?.perRunCap?.[lane] ?? PER_RUN_CAP[lane];
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
