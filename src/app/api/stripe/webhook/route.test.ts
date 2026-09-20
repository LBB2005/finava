import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  getEventDoc: vi.fn(),
  createEventDoc: vi.fn(),
  setUserSettings: vi.fn(),
  getUserSettingsDoc: vi.fn(),
  getUserSettingsQuery: vi.fn(),
  whereUserSettings: vi.fn(),
  stripeConfigured: vi.fn(),
  constructEvent: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrieveCustomer: vi.fn(),
  mapSubscriptionToPlan: vi.fn(),
  periodEndISO: vi.fn(),
  deleteField: { __delete: true },
}));

vi.mock("firebase-admin", () => ({
  firestore: {
    FieldValue: {
      delete: vi.fn(() => deps.deleteField),
    },
  },
}));

vi.mock("@/lib/firebase-admin", () => ({
  db: {
    collection: vi.fn((name: string) => {
      if (name === "stripeEvents") {
        return {
          doc: vi.fn(() => ({ get: deps.getEventDoc, create: deps.createEventDoc })),
        };
      }
      if (name === "userSettings") {
        return {
          doc: vi.fn((id: string) => ({
            id,
            get: deps.getUserSettingsDoc,
            set: deps.setUserSettings,
          })),
          where: deps.whereUserSettings,
        };
      }
      throw new Error(`unexpected collection ${name}`);
    }),
  },
}));

vi.mock("@/lib/stripe", () => ({
  stripeConfigured: deps.stripeConfigured,
  stripe: {
    webhooks: { constructEvent: deps.constructEvent },
    subscriptions: { retrieve: deps.retrieveSubscription },
    customers: { retrieve: deps.retrieveCustomer },
  },
  mapSubscriptionToPlan: deps.mapSubscriptionToPlan,
  periodEndISO: deps.periodEndISO,
}));

import { POST } from "./route";

function webhookRequest(body = "{}", signature = "sig_test") {
  return new Request("http://test.local/api/stripe/webhook", {
    method: "POST",
    headers: signature ? { "stripe-signature": signature } : {},
    body,
  });
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_123",
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_pro" }, current_period_end: 1_800_000_000 }] },
    customer: "cus_123",
    metadata: { firebaseUid: "user_123" },
    ...overrides,
  };
}

function event(
  type: string,
  object: Record<string, unknown>,
  id = `evt_${type}`,
  created = 1_700_000_000
) {
  return { id, type, created, data: { object } };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  deps.stripeConfigured.mockReturnValue(true);
  deps.constructEvent.mockReturnValue(event("customer.subscription.updated", subscription()));
  deps.getEventDoc.mockResolvedValue({ exists: false });
  deps.createEventDoc.mockResolvedValue(undefined);
  deps.setUserSettings.mockResolvedValue(undefined);
  deps.getUserSettingsDoc.mockResolvedValue({ data: () => ({}) });
  deps.mapSubscriptionToPlan.mockReturnValue({
    plan: "Pro",
    subscriptionStatus: "active",
  });
  deps.periodEndISO.mockReturnValue("2027-01-15T08:00:00.000Z");
  deps.retrieveSubscription.mockResolvedValue(subscription());
  deps.retrieveCustomer.mockResolvedValue({
    deleted: false,
    metadata: { firebaseUid: "user_from_customer" },
  });
  deps.getUserSettingsQuery.mockResolvedValue({ empty: true, docs: [] });
  deps.whereUserSettings.mockReturnValue({
    limit: vi.fn(() => ({ get: deps.getUserSettingsQuery })),
  });
});

describe("POST /api/stripe/webhook", () => {
  it("returns 503 when Stripe billing is not configured", async () => {
    deps.stripeConfigured.mockReturnValueOnce(false);

    const res = await POST(webhookRequest());

    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toBe("Billing not configured");
    expect(deps.constructEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when the Stripe signature is missing", async () => {
    const res = await POST(webhookRequest("{}", ""));

    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toBe("Missing signature");
  });

  it("returns 400 when signature verification fails", async () => {
    deps.constructEvent.mockImplementationOnce(() => {
      throw new Error("bad sig");
    });

    const res = await POST(webhookRequest());

    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toBe("Webhook error: bad sig");
    expect(deps.createEventDoc).not.toHaveBeenCalled();
  });

  it("short-circuits an already-recorded duplicate without re-running the handler", async () => {
    deps.getEventDoc.mockResolvedValueOnce({ exists: true });

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("Duplicate, ignored");
    expect(deps.setUserSettings).not.toHaveBeenCalled();
    expect(deps.createEventDoc).not.toHaveBeenCalled();
  });

  it("acknowledges a concurrent duplicate whose post-handler create races to ALREADY_EXISTS", async () => {
    // Both concurrent deliveries pass the read check, both run the (idempotent)
    // handler, and the create loser gets ALREADY_EXISTS → 200, not a 500 retry.
    deps.createEventDoc.mockRejectedValueOnce({ code: 6 });

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("Duplicate, ignored");
    expect(deps.setUserSettings).toHaveBeenCalled();
  });

  it("writes subscription state from checkout completion", async () => {
    deps.constructEvent.mockReturnValueOnce(
      event("checkout.session.completed", {
        client_reference_id: "user_checkout",
        customer: "cus_123",
        subscription: "sub_123",
        metadata: {},
      })
    );
    deps.retrieveSubscription.mockResolvedValueOnce(subscription({ id: "sub_123" }));

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(deps.retrieveSubscription).toHaveBeenCalledWith("sub_123");
    expect(deps.setUserSettings).toHaveBeenCalledWith(
      {
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        trialEndsAt: null,
        plan: "Pro",
        subscriptionStatus: "active",
        currentPeriodEnd: "2027-01-15T08:00:00.000Z",
        cancelAtPeriodEnd: false,
      },
      { merge: true }
    );
  });

  it("writes plan and period state from subscription updates", async () => {
    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(deps.setUserSettings).toHaveBeenCalledWith(
      {
        stripeSubscriptionId: "sub_123",
        plan: "Pro",
        subscriptionStatus: "active",
        currentPeriodEnd: "2027-01-15T08:00:00.000Z",
        cancelAtPeriodEnd: false,
        pastDueSince: deps.deleteField,
        lastSubscriptionEventAt: 1_700_000_000,
      },
      { merge: true }
    );
  });

  // Regression: a past_due UPDATE never started the grace clock, and the
  // invoice.payment_failed that would have was dropped as stale when it arrived
  // after this (later-stamped) update — so the 7-day grace never expired.
  it("starts the grace clock when a past_due update arrives first", async () => {
    deps.constructEvent.mockReturnValueOnce(
      event("customer.subscription.updated", subscription({ status: "past_due" }))
    );
    deps.mapSubscriptionToPlan.mockReturnValueOnce({ plan: "Pro", subscriptionStatus: "past_due" });
    deps.getUserSettingsDoc.mockResolvedValueOnce({ data: () => ({}) });

    await POST(webhookRequest());

    expect(deps.setUserSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionStatus: "past_due",
        pastDueSince: new Date(1_700_000_000 * 1000).toISOString(),
      }),
      { merge: true }
    );
  });

  it("keeps an already-running grace clock on a later past_due update", async () => {
    deps.constructEvent.mockReturnValueOnce(
      event("customer.subscription.updated", subscription({ status: "past_due" }))
    );
    deps.mapSubscriptionToPlan.mockReturnValueOnce({ plan: "Pro", subscriptionStatus: "past_due" });
    deps.getUserSettingsDoc.mockResolvedValueOnce({
      data: () => ({ pastDueSince: "2024-01-01T00:00:00.000Z" }),
    });

    await POST(webhookRequest());

    const written = deps.setUserSettings.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(written.subscriptionStatus).toBe("past_due");
    expect(written).not.toHaveProperty("pastDueSince");
  });

  it("downgrades to Free and deletes subscription fields on subscription deletion", async () => {
    deps.constructEvent.mockReturnValueOnce(
      event("customer.subscription.deleted", subscription({ status: "canceled" }))
    );

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(deps.setUserSettings).toHaveBeenCalledWith(
      {
        plan: "Free",
        subscriptionStatus: "canceled",
        stripeSubscriptionId: deps.deleteField,
        currentPeriodEnd: deps.deleteField,
        cancelAtPeriodEnd: deps.deleteField,
        pastDueSince: deps.deleteField,
        lastSubscriptionEventAt: 1_700_000_000,
      },
      { merge: true }
    );
  });

  it("refreshes current period end when an invoice is paid", async () => {
    deps.constructEvent.mockReturnValueOnce(
      event("invoice.paid", {
        customer: "cus_123",
        subscription: "sub_invoice",
        lines: { data: [] },
      })
    );
    deps.getUserSettingsQuery.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: "user_by_customer" }],
    });

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(deps.retrieveSubscription).toHaveBeenCalledWith("sub_invoice");
    expect(deps.setUserSettings).toHaveBeenCalledWith(
      {
        subscriptionStatus: "active",
        pastDueSince: deps.deleteField,
        currentPeriodEnd: "2027-01-15T08:00:00.000Z",
      },
      { merge: true }
    );
  });

  it("marks subscription past_due and stamps pastDueSince from the first failure", async () => {
    deps.constructEvent.mockReturnValueOnce(
      event("invoice.payment_failed", { customer: "cus_123" })
    );
    deps.getUserSettingsQuery.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: "user_by_customer" }],
    });
    // No existing pastDueSince → the failure event's timestamp starts the clock.
    deps.getUserSettingsDoc.mockResolvedValueOnce({ data: () => ({}) });

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(deps.setUserSettings).toHaveBeenCalledWith(
      {
        subscriptionStatus: "past_due",
        pastDueSince: new Date(1_700_000_000 * 1000).toISOString(),
      },
      { merge: true }
    );
  });

  it("preserves the original pastDueSince on a repeat payment failure", async () => {
    deps.constructEvent.mockReturnValueOnce(
      event("invoice.payment_failed", { customer: "cus_123" })
    );
    deps.getUserSettingsQuery.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: "user_by_customer" }],
    });
    deps.getUserSettingsDoc.mockResolvedValueOnce({
      data: () => ({ pastDueSince: "2024-01-01T00:00:00.000Z" }),
    });

    await POST(webhookRequest());

    expect(deps.setUserSettings).toHaveBeenCalledWith(
      { subscriptionStatus: "past_due", pastDueSince: "2024-01-01T00:00:00.000Z" },
      { merge: true }
    );
  });

  it("ignores a stale subscription event that predates the last applied one", async () => {
    // A delayed OLDER `updated` (created 1.7e9) arriving after a newer event
    // (lastSubscriptionEventAt 2.0e9) must NOT overwrite state / resurrect paid.
    deps.getUserSettingsDoc.mockResolvedValueOnce({
      data: () => ({ lastSubscriptionEventAt: 2_000_000_000 }),
    });
    // Default constructEvent = customer.subscription.updated, created 1_700_000_000.

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    // No write applied…
    expect(deps.setUserSettings).not.toHaveBeenCalled();
    // …but the event is still recorded so Stripe stops retrying it.
    expect(deps.createEventDoc).toHaveBeenCalled();
  });

  // ── Out-of-order protection beyond the subscription.* events ───────────────
  // Stripe retries for ~3 days and does not guarantee order. A delayed event
  // that PREDATES an applied cancellation must not write entitlement state, or
  // it resurrects paid access for a user who has already been downgraded.

  it("ignores a stale invoice.paid that would resurrect access after cancellation", async () => {
    deps.constructEvent.mockReturnValueOnce(
      event("invoice.paid", { customer: "cus_123", subscription: "sub_x", lines: { data: [] } })
    );
    deps.getUserSettingsQuery.mockResolvedValue({
      empty: false,
      docs: [{ id: "user_by_customer" }],
    });
    // A cancellation created at 2.0e9 already landed; this invoice is from 1.7e9.
    deps.getUserSettingsDoc.mockResolvedValue({
      data: () => ({ lastSubscriptionEventAt: 2_000_000_000 }),
    });

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(deps.setUserSettings).not.toHaveBeenCalled();
    expect(deps.createEventDoc).toHaveBeenCalled();
  });

  it("ignores a stale invoice.payment_failed that predates the last applied event", async () => {
    deps.constructEvent.mockReturnValueOnce(
      event("invoice.payment_failed", { customer: "cus_123" })
    );
    deps.getUserSettingsQuery.mockResolvedValue({
      empty: false,
      docs: [{ id: "user_by_customer" }],
    });
    deps.getUserSettingsDoc.mockResolvedValue({
      data: () => ({ lastSubscriptionEventAt: 2_000_000_000 }),
    });

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(deps.setUserSettings).not.toHaveBeenCalled();
  });

  it("writes identity from a stale checkout completion but not its plan or status", async () => {
    // stripeCustomerId is what resolveUid indexes on and carries no entitlement,
    // so it is written regardless; the plan/status half is clock-guarded.
    deps.constructEvent.mockReturnValueOnce(
      event("checkout.session.completed", {
        client_reference_id: "user_checkout",
        customer: "cus_123",
        subscription: "sub_123",
        metadata: {},
      })
    );
    deps.getUserSettingsDoc.mockResolvedValue({
      data: () => ({ lastSubscriptionEventAt: 2_000_000_000 }),
    });

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(deps.setUserSettings).toHaveBeenCalledWith(
      { stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_123" },
      { merge: true }
    );
  });

  it("does not let an invoice event advance the subscription clock", async () => {
    // Invoice events RESPECT the clock but must not SET it: an invoice.paid and
    // its customer.subscription.updated are seconds apart, and stamping the
    // clock from the invoice would drop the update that carries the plan.
    deps.constructEvent.mockReturnValueOnce(
      event("invoice.paid", { customer: "cus_123", subscription: "sub_x", lines: { data: [] } })
    );
    deps.getUserSettingsQuery.mockResolvedValue({
      empty: false,
      docs: [{ id: "user_by_customer" }],
    });

    await POST(webhookRequest());

    const [patch] = deps.setUserSettings.mock.calls[0];
    expect(patch).not.toHaveProperty("lastSubscriptionEventAt");
  });

  it("returns 500 so Stripe retries when handler logic fails, leaving no idempotency record", async () => {
    deps.setUserSettings.mockRejectedValueOnce(new Error("write failed"));

    const res = await POST(webhookRequest());

    expect(res.status).toBe(500);
    await expect(res.text()).resolves.toBe("Handler error");
    // No record written on failure → Stripe's retry re-runs the handler cleanly.
    expect(deps.createEventDoc).not.toHaveBeenCalled();
  });
});
