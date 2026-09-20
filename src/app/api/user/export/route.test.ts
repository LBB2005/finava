import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getUser: vi.fn(),
  settingsGet: vi.fn(),
  usageGet: vi.fn(),
  listCollections: vi.fn(),
  memoryGet: vi.fn(),
  serializeDoc: vi.fn((id: string, data: Record<string, unknown>) => ({ id, ...data })),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/firebase-admin", () => ({
  adminAuth: { getUser: deps.getUser },
  serializeDoc: deps.serializeDoc,
  db: {
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() => {
        if (name === "userSettings") return { get: deps.settingsGet };
        if (name === "userUsage") return { get: deps.usageGet };
        return { listCollections: deps.listCollections };
      }),
      where: vi.fn(() => ({ get: deps.memoryGet })),
    })),
  },
}));

import { GET } from "./route";

beforeEach(() => {
  deps.memoryGet.mockResolvedValue({ docs: [] });
});

const doc = (id: string, data: Record<string, unknown>, subcollections: unknown[] = []) => ({
  id,
  data: () => data,
  ref: { listCollections: vi.fn().mockResolvedValue(subcollections) },
});

const collection = (id: string, docs: unknown[]) => ({
  id,
  get: vi.fn().mockResolvedValue({ docs }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  deps.requireAuth.mockResolvedValue({ userId: "user_123" });
  deps.getUser.mockResolvedValue({
    uid: "user_123",
    email: "liam@example.com",
    displayName: "Liam",
    photoURL: null,
    metadata: {
      creationTime: "2026-01-01T00:00:00Z",
      lastSignInTime: "2026-06-15T11:00:00Z",
    },
  });
  deps.settingsGet.mockResolvedValue({
    exists: true,
    data: () => ({ plan: "Pro", stripeCustomerId: "cus_secret", theme: "dark" }),
  });
  deps.usageGet.mockResolvedValue({
    exists: true,
    data: () => ({ used: 12, limit: 100 }),
  });
});

describe("GET /api/user/export", () => {
  it("exports account, settings, usage, and nested user data with secrets redacted", async () => {
    const messages = collection("messages", [
      doc("msg_1", { role: "assistant", content: "DCF complete", accessToken: "nested_secret" }),
    ]);
    deps.listCollections.mockResolvedValue([
      collection("conversations", [
        doc("conv_1", { title: "Apple", stripeCustomerId: "cus_nested" }, [messages]),
      ]),
      collection("plaidItems", [
        doc("item_1", { institutionName: "Robinhood", accessToken: "plaid_secret" }),
      ]),
    ]);

    const res = await GET();
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="finava-export-2026-06-15.json"');
    expect(payload).toMatchObject({
      exportedAt: "2026-06-15T12:00:00.000Z",
      account: {
        uid: "user_123",
        email: "liam@example.com",
        displayName: "Liam",
        createdAt: "2026-01-01T00:00:00Z",
        lastSignInAt: "2026-06-15T11:00:00Z",
      },
      settings: { id: "user_123", plan: "Pro", theme: "dark" },
      usage: { id: "user_123", used: 12, limit: 100 },
    });
    expect(payload.data.conversations[0]).toEqual({
      id: "conv_1",
      title: "Apple",
      messages: [{ id: "msg_1", role: "assistant", content: "DCF complete" }],
    });
    expect(payload.data.plaidItems[0]).toEqual({ id: "item_1", institutionName: "Robinhood" });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("falls back to uid-only account data when Firebase Auth lookup fails", async () => {
    deps.getUser.mockRejectedValueOnce(new Error("missing user"));
    deps.settingsGet.mockResolvedValueOnce({ exists: false });
    deps.usageGet.mockResolvedValueOnce({ exists: false });
    deps.listCollections.mockResolvedValueOnce([]);

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      account: { uid: "user_123" },
      settings: null,
      usage: null,
      data: {},
    });
  });

  it("returns auth and export failure responses", async () => {
    deps.requireAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await GET()).status).toBe(401);

    deps.listCollections.mockRejectedValueOnce(new Error("firestore down"));
    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to export data" });
  });
});

describe("GET /api/user/export — top-level per-user rows", () => {
  // Regression: portfolio-derived tickerMemory rows were held but never exported.
  it("includes the user's tickerMemory rows", async () => {
    deps.requireAuth.mockResolvedValue({ userId: "user_123" });
    deps.getUser.mockResolvedValue(null);
    deps.settingsGet.mockResolvedValue({ exists: false });
    deps.usageGet.mockResolvedValue({ exists: false });
    deps.listCollections.mockResolvedValue([]);
    deps.memoryGet.mockResolvedValueOnce({
      docs: [{ id: "m1", data: () => ({ userId: "user_123", ticker: "AAPL", insight: "x" }) }],
    });

    const body = JSON.parse(await (await GET()).text());

    expect(body.data.tickerMemory).toEqual([{ id: "m1", userId: "user_123", ticker: "AAPL", insight: "x" }]);
  });
});
