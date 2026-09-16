import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREDIT_USD,
  DEFAULT_PLAN,
  PER_RUN_CAP,
  PLANS,
  PLAN_ORDER,
  RUN_LANES,
  TYPICAL_RUN_CREDITS,
  creditsToUsd,
  perRunCapFor,
  jsonLimit,
  nextPaidPlan,
  planConfig,
  planForPriceId,
  planGranting,
  priceIdFor,
  type PlanName,
} from "./plans";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the plan table", () => {
  it("defines every plan in PLAN_ORDER", () => {
    expect(PLAN_ORDER).toEqual(["Free", "Analyst", "Pro", "Quant"]);
    for (const p of PLAN_ORDER) expect(PLANS[p]).toBeDefined();
  });

  it("raises the credit allowance monotonically up the ladder", () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lo = PLANS[PLAN_ORDER[i - 1]];
      const hi = PLANS[PLAN_ORDER[i]];
      expect(hi.daily).toBeGreaterThan(lo.daily);
      expect(hi.weekly).toBeGreaterThan(lo.weekly);
      expect(hi.monthly).toBeGreaterThan(lo.monthly);
    }
  });

  it("never revokes a capability at a higher tier", () => {
    const caps = ["plaidLinking", "weeklyBriefings"] as const;
    for (const cap of caps) {
      let granted = false;
      for (const p of PLAN_ORDER) {
        if (PLANS[p].capabilities[cap]) granted = true;
        else expect(granted, `${p} revokes ${cap}`).toBe(false);
      }
    }
  });

  it("gates Free to a single watchlist and leaves paid tiers unlimited", () => {
    expect(PLANS.Free.watchlistLimit).toBe(1);
    for (const p of ["Analyst", "Pro", "Quant"] as PlanName[]) {
      expect(PLANS[p].watchlistLimit).toBe(Infinity);
    }
  });

  it("marks only Analyst and Pro purchasable (Quant is internal, Free has no price)", () => {
    expect(PLANS.Free.stripe.purchasable).toBe(false);
    expect(PLANS.Analyst.stripe.purchasable).toBe(true);
    expect(PLANS.Pro.stripe.purchasable).toBe(true);
    expect(PLANS.Quant.stripe.purchasable).toBe(false);
  });
});

describe("per-run caps", () => {
  it("gives every lane a cap above what a typical run costs", () => {
    for (const lane of RUN_LANES) {
      expect(PER_RUN_CAP[lane], lane).toBeGreaterThan(TYPICAL_RUN_CREDITS[lane]);
    }
  });

  it("keeps the lanes in their measured cost order", () => {
    expect(PER_RUN_CAP.fast).toBeLessThan(PER_RUN_CAP.discover);
    expect(PER_RUN_CAP.discover).toBeLessThan(PER_RUN_CAP.full);
    expect(PER_RUN_CAP.full).toBeLessThan(PER_RUN_CAP.deep);
  });

  it("no longer cuts off a median deep-research run (the old flat 300 did)", () => {
    for (const p of PLAN_ORDER) {
      expect(perRunCapFor(PLANS[p], "deep")).toBeGreaterThan(TYPICAL_RUN_CREDITS.deep);
    }
  });

  it("falls back to the shared table for a config with no per-lane caps", () => {
    expect(perRunCapFor(null, "full")).toBe(PER_RUN_CAP.full);
    expect(perRunCapFor({ perRunCap: undefined as never }, "deep")).toBe(PER_RUN_CAP.deep);
  });
});

describe("gross margin floor", () => {
  // Stripe's standard card rate. The floor is checked at 100% utilisation — a
  // subscriber who spends every credit — so it holds without guessing usage.
  const stripeFee = (usd: number) => usd * 0.029 + 0.3;
  const dollars = (s: string) => Number(s.replace(/[^0-9.]/g, ""));

  for (const p of ["Analyst", "Pro", "Quant"] as PlanName[]) {
    it(`${p} keeps >= 70% gross margin at full use, monthly and annual`, () => {
      const cfg = PLANS[p];
      const modelCost = creditsToUsd(cfg.monthly);
      const monthly = dollars(cfg.price.monthly);
      const annualPerMonth = dollars(cfg.price.annual) / 12;

      const monthlyMargin = 1 - (modelCost + stripeFee(monthly)) / monthly;
      const annualMargin = 1 - (modelCost + stripeFee(dollars(cfg.price.annual)) / 12) / annualPerMonth;
      expect(monthlyMargin).toBeGreaterThanOrEqual(0.7);
      expect(annualMargin).toBeGreaterThanOrEqual(0.7);
    });
  }

  it("prices credits at a tenth of a cent", () => {
    expect(CREDIT_USD).toBe(0.001);
    expect(creditsToUsd(4400)).toBe(4.4);
  });

  it("only promises Deep Research runs the monthly credits can actually pay for", () => {
    for (const p of PLAN_ORDER) {
      const { deepResearchPerMonth, monthly } = PLANS[p];
      if (!Number.isFinite(deepResearchPerMonth)) continue;
      expect(deepResearchPerMonth * TYPICAL_RUN_CREDITS.deep, p).toBeLessThanOrEqual(monthly);
    }
  });
});

describe("planConfig", () => {
  it("looks up a known plan", () => {
    expect(planConfig("Pro")).toBe(PLANS.Pro);
  });

  it("falls back to Free for unknown, null and undefined", () => {
    expect(planConfig("Enterprise")).toBe(PLANS[DEFAULT_PLAN]);
    expect(planConfig(null)).toBe(PLANS[DEFAULT_PLAN]);
    expect(planConfig(undefined)).toBe(PLANS[DEFAULT_PLAN]);
  });
});

describe("priceIdFor", () => {
  it("resolves the env var named by the plan config", () => {
    vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_m");
    vi.stubEnv("STRIPE_PRICE_PRO_ANNUAL", "price_pro_a");
    expect(priceIdFor("Pro", "monthly")).toBe("price_pro_m");
    expect(priceIdFor("Pro", "annual")).toBe("price_pro_a");
  });

  it("returns null when the env var is unset", () => {
    vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", undefined);
    expect(priceIdFor("Pro", "monthly")).toBeNull();
  });

  it("returns null for Free, which has no Stripe wiring", () => {
    expect(priceIdFor("Free", "monthly")).toBeNull();
    expect(priceIdFor("Free", "annual")).toBeNull();
  });
});

describe("planForPriceId", () => {
  it("reverse-maps a monthly price id", () => {
    vi.stubEnv("STRIPE_PRICE_ANALYST_MONTHLY", "price_a_m");
    expect(planForPriceId("price_a_m")).toEqual({ plan: "Analyst", cadence: "monthly" });
  });

  it("reverse-maps an annual price id", () => {
    vi.stubEnv("STRIPE_PRICE_PRO_ANNUAL", "price_p_a");
    expect(planForPriceId("price_p_a")).toEqual({ plan: "Pro", cadence: "annual" });
  });

  it("returns null for an unrecognised price id", () => {
    expect(planForPriceId("price_nope")).toBeNull();
  });

  it("does not match when the env var is unset (a blank id must not collide)", () => {
    vi.stubEnv("STRIPE_PRICE_ANALYST_MONTHLY", undefined);
    expect(planForPriceId("")).toBeNull();
  });
});

describe("planGranting", () => {
  it("returns the cheapest tier that unlocks the capability", () => {
    expect(planGranting("plaidLinking")).toBe("Analyst");
    expect(planGranting("weeklyBriefings")).toBe("Analyst");
  });
});

describe("nextPaidPlan", () => {
  it("steps up to the next purchasable tier", () => {
    expect(nextPaidPlan("Free")).toBe("Analyst");
    expect(nextPaidPlan("Analyst")).toBe("Pro");
  });

  it("points at Pro once there is nothing purchasable above (Quant is not sold)", () => {
    expect(nextPaidPlan("Pro")).toBe("Pro");
    expect(nextPaidPlan("Quant")).toBe("Pro");
  });
});

describe("jsonLimit", () => {
  it("passes finite limits through", () => {
    expect(jsonLimit(400)).toBe(400);
    expect(jsonLimit(0)).toBe(0);
  });

  it("converts Infinity to null so it survives JSON.stringify", () => {
    expect(jsonLimit(Infinity)).toBeNull();
    expect(JSON.parse(JSON.stringify({ n: jsonLimit(Infinity) }))).toEqual({ n: null });
  });

  it("converts NaN to null too", () => {
    expect(jsonLimit(NaN)).toBeNull();
  });
});
