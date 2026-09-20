import { afterEach, describe, expect, it, vi } from "vitest";

// stripe.ts constructs a Stripe client and imports db at module load — mock both
// so the module evaluates without real credentials.
vi.mock("stripe", () => ({
  default: class {
    customers = { search: vi.fn(), create: vi.fn() };
  },
}));
vi.mock("@/lib/firebase-admin", () => ({
  db: { collection: () => ({ doc: () => ({ get: async () => ({ data: () => ({}) }), set: async () => {} }) }) },
}));

import { billingBaseUrl, mapSubscriptionToPlan, periodEndISO, stripeConfigured } from "./stripe";

type Sub = Parameters<typeof mapSubscriptionToPlan>[0];

function sub(status: string, priceId = "price_unknown", periodEnd: number | null = 1_800_000_000): Sub {
  return {
    status,
    items: { data: [{ price: { id: priceId }, current_period_end: periodEnd } ] },
  } as unknown as Sub;
}

afterEach(() => vi.unstubAllEnvs());

describe("mapSubscriptionToPlan", () => {
  it("maps lapsed statuses to Free", () => {
    for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
      expect(mapSubscriptionToPlan(sub(status)).plan).toBe("Free");
      expect(mapSubscriptionToPlan(sub(status)).subscriptionStatus).toBe(status);
    }
  });

  it("keeps the raw status but falls back to Free for an unknown price id", () => {
    const r = mapSubscriptionToPlan(sub("active", "price_not_in_env"));
    expect(r.subscriptionStatus).toBe("active");
    expect(r.plan).toBe("Free"); // no matching STRIPE_PRICE_* env → Free
  });

  it("maps an active subscription to the plan implied by its price id", () => {
    vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_m");
    const r = mapSubscriptionToPlan(sub("active", "price_pro_m"));
    expect(r.subscriptionStatus).toBe("active");
    expect(r.plan).toBe("Pro");
  });
});

describe("periodEndISO", () => {
  it("converts the subscription-item period end to ISO", () => {
    expect(periodEndISO(sub("active", "p", 1_800_000_000))).toBe(
      new Date(1_800_000_000 * 1000).toISOString()
    );
  });

  it("returns null when there is no period end", () => {
    expect(periodEndISO(sub("active", "p", null))).toBeNull();
  });
});

describe("stripeConfigured", () => {
  it("is false without a secret key and true with one", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(stripeConfigured()).toBe(false);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    expect(stripeConfigured()).toBe(true);
  });
});

describe("billingBaseUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the configured app URL, without a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://finava.ai/");
    expect(billingBaseUrl()).toBe("https://finava.ai");
  });

  it("falls back to localhost only outside production", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(billingBaseUrl()).toBe("http://localhost:3000");
    vi.stubEnv("NODE_ENV", "production");
    expect(billingBaseUrl()).toBeNull();
  });
});
