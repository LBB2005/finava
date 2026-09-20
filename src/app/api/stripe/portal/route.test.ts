import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  stripeConfigured: vi.fn(),
  settingsGet: vi.fn(),
  portalCreate: vi.fn(),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/firebase-admin", () => ({
  db: { collection: vi.fn(() => ({ doc: vi.fn(() => ({ get: deps.settingsGet })) })) },
}));
vi.mock("@/lib/stripe", () => ({
  stripeConfigured: deps.stripeConfigured,
  billingBaseUrl: () => process.env.NEXT_PUBLIC_APP_URL || null,
  stripe: { billingPortal: { sessions: { create: deps.portalCreate } } },
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.finava.ai";
  deps.requireAuth.mockResolvedValue({ userId: "user_123" });
  deps.stripeConfigured.mockReturnValue(true);
  deps.settingsGet.mockResolvedValue({ data: () => ({ stripeCustomerId: "cus_123" }) });
  deps.portalCreate.mockResolvedValue({ url: "https://stripe.test/portal" });
});

describe("POST /api/stripe/portal", () => {
  it("gates auth/config/customer and creates portal sessions", async () => {
    deps.requireAuth.mockResolvedValueOnce({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) });
    expect((await POST()).status).toBe(401);
    deps.stripeConfigured.mockReturnValueOnce(false);
    expect((await POST()).status).toBe(503);
    deps.settingsGet.mockResolvedValueOnce({ data: () => ({}) });
    expect((await POST()).status).toBe(404);

    const res = await POST();
    expect(res.status).toBe(200);
    expect(deps.portalCreate).toHaveBeenCalledWith({
      customer: "cus_123",
      return_url: "https://app.finava.ai/settings?section=billing",
    });
    await expect(res.json()).resolves.toEqual({ url: "https://stripe.test/portal" });
  });

  it("returns 502 when Stripe portal creation fails", async () => {
    deps.portalCreate.mockRejectedValueOnce(new Error("down"));
    expect((await POST()).status).toBe(502);
  });
});

describe("billing base URL", () => {
  // Regression: an unset NEXT_PUBLIC_APP_URL sent paying customers to localhost.
  it("refuses to build return URLs when the app URL isn't configured", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "";
    const res = await POST();
    expect(res.status).toBe(503);
  });
});
