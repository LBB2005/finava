import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  convGet: vi.fn(),
  generateConversationTitle: vi.fn(),
}));

vi.mock("@/lib/withRoute", () => ({
  withRoute: vi.fn((_opts, handler) => async (
    req = new Request("http://localhost/api/conversations/conv_1/title"),
    ctx = { params: Promise.resolve({ id: "conv_1" }) }
  ) => handler({ req, userId: "user_123" }, ctx)),
}));
vi.mock("@/lib/conversationTitle", () => ({
  generateConversationTitle: deps.generateConversationTitle,
}));
vi.mock("@/lib/firebase-admin", () => ({
  db: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        collection: vi.fn(() => ({
          doc: vi.fn(() => ({ get: deps.convGet })),
        })),
      })),
    })),
  },
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  deps.convGet
    .mockResolvedValueOnce({ exists: true, data: () => ({}) })
    .mockResolvedValueOnce({ data: () => ({ title: "Apple DCF" }) });
  deps.generateConversationTitle.mockResolvedValue(undefined);
});

describe("POST /api/conversations/[id]/title", () => {
  it("backfills a title for existing conversations and returns the latest title", async () => {
    const res = await POST(new Request("http://localhost/api/conversations/conv_1/title", {
      method: "POST",
    }), { params: Promise.resolve({ id: "conv_1" }) });

    expect(res.status).toBe(200);
    expect(deps.generateConversationTitle).toHaveBeenCalledWith("user_123", "conv_1");
    await expect(res.json()).resolves.toEqual({ ok: true, title: "Apple DCF" });
  });

  it("returns not_found without generating a title for missing conversations", async () => {
    deps.convGet.mockReset();
    deps.convGet.mockResolvedValueOnce({ exists: false });

    const res = await POST(new Request("http://localhost/api/conversations/missing/title", {
      method: "POST",
    }), { params: Promise.resolve({ id: "missing" }) });

    expect(res.status).toBe(404);
    expect(deps.generateConversationTitle).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      error: { code: "not_found", message: "Conversation not found" },
      message: "Conversation not found",
    });
  });
});
