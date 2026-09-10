import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLAN,
  PLANS,
  PLAN_ORDER,
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
