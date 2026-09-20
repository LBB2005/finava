import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  stripeConfigured: vi.fn(),
  getOrCreateCustomer: vi.fn(),
  checkoutCreate: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/firebase-admin", () => ({ adminAuth: { getUser: deps.getUser } }));
vi.mock("@/lib/stripe", () => ({
  stripeConfigured: deps.stripeConfigured,
  billingBaseUrl: () => process.env.NEXT_PUBLIC_APP_URL || null,
  getOrCreateCustomer: deps.getOrCreateCustomer,
  stripe: { checkout: { sessions: { create: deps.checkoutCreate } } },
}));
vi.mock("@/lib/plans", () => ({
  PLANS: {
    Pro: { stripe: { purchasable: true } },
    Quant: { stripe: { purchasable: false } },
  },
  priceIdFor: vi.fn((plan, cadence) => plan === "Pro" ? `price_${cadence}` : null),
}));

import { POST } from "./route";

const req = (body: unknown) => new Request("http://test.local/api/stripe/checkout", {
  method: "POST",
  body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.finava.ai";
  deps.requireAuth.mockResolvedValue({ userId: "user_123" });
  deps.stripeConfigured.mockReturnValue(true);
  deps.getUser.mockResolvedValue({ email: "liam@example.com" });
  deps.getOrCreateCustomer.mockResolvedValue("cus_123");
  deps.checkoutCreate.mockResolvedValue({ url: "https://stripe.test/checkout" });
});

describe("POST /api/stripe/checkout", () => {
  it("gates auth, Stripe config, body shape, plan availability, and price config", async () => {
    deps.requireAuth.mockResolvedValueOnce({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) });
    expect((await POST(req({ plan: "Pro" }))).status).toBe(401);

    deps.stripeConfigured.mockReturnValueOnce(false);
    expect((await POST(req({ plan: "Pro" }))).status).toBe(503);
    expect((await POST(req("{"))).status).toBe(400);
    expect((await POST(req({ plan: "Nope" }))).status).toBe(400);
    expect((await POST(req({ plan: "Quant" }))).status).toBe(400);
  });

  it("creates a subscription checkout session with customer and uid metadata", async () => {
    const res = await POST(req({ plan: "Pro", cadence: "annual" }));

    expect(res.status).toBe(200);
    expect(deps.getOrCreateCustomer).toHaveBeenCalledWith("user_123", "liam@example.com");
    expect(deps.checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription",
      customer: "cus_123",
      line_items: [{ price: "price_annual", quantity: 1 }],
      client_reference_id: "user_123",
      subscription_data: { metadata: { firebaseUid: "user_123" } },
      success_url: expect.stringContaining("https://app.finava.ai/settings?section=billing&checkout=success"),
      cancel_url: "https://app.finava.ai/settings?section=billing&checkout=cancel",
    }));
    await expect(res.json()).resolves.toEqual({ url: "https://stripe.test/checkout" });
  });

  it("continues without Firebase email and reports Stripe session failures", async () => {
    deps.getUser.mockRejectedValueOnce(new Error("no user"));
    deps.checkoutCreate.mockRejectedValueOnce(new Error("stripe down"));

    const res = await POST(req({ plan: "Pro" }));

    expect(res.status).toBe(502);
    expect(deps.getOrCreateCustomer).toHaveBeenCalledWith("user_123", null);
  });
});

describe("billing base URL", () => {
  // Regression: an unset NEXT_PUBLIC_APP_URL sent paying customers to localhost.
  it("refuses to build return URLs when the app URL isn't configured", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "";
    const res = await POST(new Request("http://t/", { method: "POST", body: JSON.stringify({ plan: "Pro", cadence: "monthly" }) }));
    expect(res.status).toBe(503);
  });
});
