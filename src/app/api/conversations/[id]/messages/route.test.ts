import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  convGet: vi.fn(),
  convUpdate: vi.fn(),
  messageAdd: vi.fn(),
  serializeDoc: vi.fn((id: string, data: Record<string, unknown>) => ({ id, ...data })),
  generateConversationTitle: vi.fn(),
}));

vi.mock("@/lib/withRoute", () => ({
  withRoute: vi.fn((_opts, handler) => async (
    req = new Request("http://localhost/api/conversations/conv_1/messages"),
    ctx = { params: Promise.resolve({ id: "conv_1" }) }
  ) => {
    const body = await req.json();
    return handler({ req, userId: "user_123", body }, ctx);
  }),
}));
vi.mock("@/lib/schemas/conversation", () => ({
  AddMessageSchema: {},
}));
vi.mock("@/lib/conversationTitle", () => ({
  generateConversationTitle: deps.generateConversationTitle,
}));
vi.mock("@/lib/firebase-admin", () => ({
  serializeDoc: deps.serializeDoc,
  db: {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        collection: vi.fn(() => ({
          doc: vi.fn(() => ({
            get: deps.convGet,
            update: deps.convUpdate,
            collection: vi.fn(() => ({ add: deps.messageAdd })),
          })),
        })),
      })),
    })),
  },
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  deps.convGet.mockResolvedValue({ exists: true, data: () => ({}) });
  deps.convUpdate.mockResolvedValue(undefined);
  // Fire-and-forget title generation: the route attaches a `.catch`, so the mock
  // must return a promise (it no-ops internally in production).
  deps.generateConversationTitle.mockResolvedValue(undefined);
  deps.messageAdd.mockResolvedValue({
    get: vi.fn().mockResolvedValue({
      id: "msg_1",
      data: () => ({
        conversationId: "conv_1",
        role: "assistant",
        content: "Done",
        mode: "agent",
        agentTrace: JSON.stringify([{ step: "dcf" }]),
        durationMs: 1200,
        createdAt: "2026-06-15T12:00:00.000Z",
      }),
    }),
  });
});

describe("POST /api/conversations/[id]/messages", () => {
  it("adds messages with defaults, updates conversation recency, and titles assistant replies", async () => {
    const res = await POST(new Request("http://localhost/api/conversations/conv_1/messages", {
      method: "POST",
      body: JSON.stringify({
        role: "assistant",
        content: "Done",
        mode: "agent",
        agentTrace: [{ step: "dcf" }],
        durationMs: 1200,
      }),
    }), { params: Promise.resolve({ id: "conv_1" }) });

    expect(res.status).toBe(201);
    expect(deps.messageAdd).toHaveBeenCalledWith({
      conversationId: "conv_1",
      role: "assistant",
      content: "Done",
      mode: "agent",
      agentTrace: JSON.stringify([{ step: "dcf" }]),
      durationMs: 1200,
      context: null,
      createdAt: "2026-06-15T12:00:00.000Z",
    });
    expect(deps.convUpdate).toHaveBeenCalledWith({ updatedAt: "2026-06-15T12:00:00.000Z" });
    expect(deps.generateConversationTitle).toHaveBeenCalledWith("user_123", "conv_1");
    await expect(res.json()).resolves.toMatchObject({ id: "msg_1", role: "assistant", content: "Done" });
  });

  it("uses simple-mode defaults for user messages without triggering title generation", async () => {
    await POST(new Request("http://localhost/api/conversations/conv_1/messages", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "Analyze AAPL" }),
    }), { params: Promise.resolve({ id: "conv_1" }) });

    expect(deps.messageAdd).toHaveBeenCalledWith(expect.objectContaining({
      mode: "simple",
      agentTrace: null,
      durationMs: null,
      context: null,
    }));
    expect(deps.generateConversationTitle).not.toHaveBeenCalled();
  });

  it("persists the page context (citation pill) when a message carries one", async () => {
    await POST(new Request("http://localhost/api/conversations/conv_1/messages", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "What's going on?", context: "stock:AAPL" }),
    }), { params: Promise.resolve({ id: "conv_1" }) });

    expect(deps.messageAdd).toHaveBeenCalledWith(expect.objectContaining({
      role: "user",
      content: "What's going on?",
      context: "stock:AAPL",
    }));
  });

  it("persists follow-up chips, the Second Opinion, the Discover attachment and the stopped flag", async () => {
    await POST(new Request("http://localhost/api/conversations/conv_1/messages", {
      method: "POST",
      body: JSON.stringify({
        role: "assistant",
        content: "Partial report",
        mode: "agent",
        followups: ["What about margins?"],
        critique: "**Skeptic Review:** thin data",
        attachment: '{"kind":"final","report":"x"}',
        stopped: true,
      }),
    }), { params: Promise.resolve({ id: "conv_1" }) });

    expect(deps.messageAdd).toHaveBeenCalledWith(expect.objectContaining({
      followups: ["What about margins?"],
      critique: "**Skeptic Review:** thin data",
      attachment: '{"kind":"final","report":"x"}',
      stopped: true,
    }));
  });

  it("returns the shared not_found shape when the conversation does not exist", async () => {
    deps.convGet.mockResolvedValueOnce({ exists: false });

    const res = await POST(new Request("http://localhost/api/conversations/missing/messages", {
      method: "POST",
      body: JSON.stringify({ role: "user", content: "Hello" }),
    }), { params: Promise.resolve({ id: "missing" }) });

    expect(res.status).toBe(404);
    expect(deps.messageAdd).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      error: { code: "not_found", message: "Conversation not found" },
      message: "Conversation not found",
    });
  });
});
