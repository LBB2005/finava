import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireEntitlement: vi.fn(),
  plaidConfigured: vi.fn(),
  itemPublicTokenExchange: vi.fn(),
  rebuildHoldings: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
  itemCount: 0,
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/entitlements", () => ({ requireEntitlement: deps.requireEntitlement }));
vi.mock("@/lib/plaid", () => ({
  plaidClient: { itemPublicTokenExchange: deps.itemPublicTokenExchange },
  plaidConfigured: deps.plaidConfigured,
  MAX_PLAID_ITEMS: 5,
  plaidItemLimitReached: (n: number) => n >= 5,
}));
vi.mock("@/lib/plaidSync", () => ({ rebuildHoldings: deps.rebuildHoldings }));
// Deterministic encryption so we can assert ciphertext (not the raw token) is stored.
vi.mock("@/lib/crypto", () => ({ encryptSecret: (t: string) => `ENC(${t})` }));
vi.mock("@/lib/firebase-admin", () => ({
  db: {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ set: deps.set, update: deps.update }),
          count: () => ({ get: async () => ({ data: () => ({ count: deps.itemCount }) }) }),
        }),
      }),
    }),
  },
}));

import { POST } from "./route";

function req(body: unknown = { public_token: "public-sandbox-1", institution: { name: "Chase", institution_id: "ins_1" } }) {
  return new Request("http://test.local/api/plaid/exchange", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.itemCount = 0;
  deps.requireAuth.mockResolvedValue({ userId: "user_1" });
  deps.requireEntitlement.mockResolvedValue(null);
  deps.plaidConfigured.mockReturnValue(true);
  deps.itemPublicTokenExchange.mockResolvedValue({
    data: { access_token: "access-sandbox-xyz", item_id: "item_1" },
  });
  deps.rebuildHoldings.mockResolvedValue({ imported: 2, skipped: 0, cash: null });
});

describe("POST /api/plaid/exchange", () => {
  it("passes through an auth error", async () => {
    deps.requireAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const res = await POST(req());
    expect(res.status).toBe(401);
  });

  it("returns the entitlement gate when not entitled", async () => {
    deps.requireEntitlement.mockResolvedValueOnce(
      NextResponse.json({ error: "entitlement_required" }, { status: 403 })
    );
    const res = await POST(req());
    expect(res.status).toBe(403);
  });

  it("503s when Plaid is not configured", async () => {
    deps.plaidConfigured.mockReturnValueOnce(false);
    expect((await POST(req())).status).toBe(503);
  });

  it("400s when public_token is missing", async () => {
    const res = await POST(req({ institution: null }));
    expect(res.status).toBe(400);
  });

  it("stores the ENCRYPTED access token (never the raw one) and rebuilds holdings", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    // The critical assertion: the token is run through encryptSecret before it
    // is persisted — the raw Plaid token is never written verbatim.
    expect(deps.set).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "ENC(access-sandbox-xyz)" })
    );
    const stored = deps.set.mock.calls[0][0];
    expect(stored.accessToken).not.toBe("access-sandbox-xyz");
    expect(deps.rebuildHoldings).toHaveBeenCalledWith("user_1");
  });

  it("500s with a scrubbed message when the exchange fails", async () => {
    deps.itemPublicTokenExchange.mockRejectedValueOnce({ response: { data: { error_code: "X" } } });
    const res = await POST(req());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to link account" });
  });
});

describe("POST /api/plaid/exchange — connection cap", () => {
  it("refuses a new Item once the user is at the connection cap, before exchanging", async () => {
    deps.itemCount = 5;
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(deps.itemPublicTokenExchange).not.toHaveBeenCalled();
    expect(deps.set).not.toHaveBeenCalled();
  });
});
