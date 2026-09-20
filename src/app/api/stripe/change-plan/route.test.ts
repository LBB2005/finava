import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  stripeConfigured: vi.fn(),
  settingsGet: vi.fn(),
  retrieve: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/firebase-admin", () => ({
  db: { collection: vi.fn(() => ({ doc: vi.fn(() => ({ get: deps.settingsGet })) })) },
}));
vi.mock("@/lib/stripe", () => ({
  stripeConfigured: deps.stripeConfigured,
  stripe: { subscriptions: { retrieve: deps.retrieve, update: deps.update } },
}));
vi.mock("@/lib/plans", () => ({
  PLANS: { Pro: { stripe: { purchasable: true } }, Quant: { stripe: { purchasable: false } } },
  priceIdFor: vi.fn((plan, cadence) => plan === "Pro" ? `price_${cadence}` : null),
}));

import { POST } from "./route";

const req = (body: unknown) => new Request("http://test.local/api/stripe/change-plan", {
  method: "POST",
  body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  deps.requireAuth.mockResolvedValue({ userId: "user_123" });
  deps.stripeConfigured.mockReturnValue(true);
  deps.settingsGet.mockResolvedValue({ data: () => ({ stripeSubscriptionId: "sub_123" }) });
  deps.retrieve.mockResolvedValue({ items: { data: [{ id: "si_123" }] } });
  deps.update.mockResolvedValue({});
});

describe("POST /api/stripe/change-plan", () => {
  it("validates gates, body, plan, price, and subscription presence", async () => {
    deps.requireAuth.mockResolvedValueOnce({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) });
    expect((await POST(req({ plan: "Pro" }))).status).toBe(401);
    deps.stripeConfigured.mockReturnValueOnce(false);
    expect((await POST(req({ plan: "Pro" }))).status).toBe(503);
    expect((await POST(req("{"))).status).toBe(400);
    expect((await POST(req({ plan: "Quant" }))).status).toBe(400);
    expect((await POST(req({ plan: "Nope" }))).status).toBe(400);
    deps.settingsGet.mockResolvedValueOnce({ data: () => ({}) });
    expect((await POST(req({ plan: "Pro" }))).status).toBe(404);
  });

  // Regression: create_prorations granted the new plan immediately and deferred
  // the charge (uncollected if cancelled at period end), and a declining card
  // still switched plans. Now the proration is invoiced up front and the change
  // only applies once that payment succeeds.
  it("invoices the proration now and applies the change only if payment succeeds", async () => {
    const res = await POST(req({ plan: "Pro", cadence: "annual" }));

    expect(res.status).toBe(200);
    expect(deps.retrieve).toHaveBeenCalledWith("sub_123");
    expect(deps.update).toHaveBeenCalledWith("sub_123", {
      items: [{ id: "si_123", price: "price_annual" }],
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
    });
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("handles missing subscription items and Stripe failures", async () => {
    deps.retrieve.mockResolvedValueOnce({ items: { data: [] } });
    expect((await POST(req({ plan: "Pro" }))).status).toBe(500);
    deps.retrieve.mockRejectedValueOnce(new Error("down"));
    expect((await POST(req({ plan: "Pro" }))).status).toBe(502);
  });
});
