import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ get: vi.fn(), snapshot: vi.fn() }));

vi.mock("@/lib/providerHealth", () => ({ getHealthSnapshot: deps.snapshot }));

vi.mock("@/lib/firebase-admin", () => ({
  db: {
    collection: () => ({ doc: () => ({ get: deps.get }) }),
  },
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  deps.snapshot.mockResolvedValue({ llm: "ok", data: { perplexity: "ok", finnhub: "ok" } });
});

describe("GET /api/health", () => {
  it("returns 200 ok when Firestore responds", async () => {
    deps.get.mockResolvedValueOnce({ exists: false });

    const res = await GET(new Request("http://test.local/api/health"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "ok",
      checks: { firestore: "ok" },
    });
  });

  it("returns 503 degraded when Firestore is unreachable", async () => {
    deps.get.mockRejectedValueOnce(new Error("firestore down"));

    const res = await GET(new Request("http://test.local/api/health"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      status: "degraded",
      checks: { firestore: "error" },
    });
  });

  it("reports provider health as { llm, data } alongside the Firestore check", async () => {
    deps.get.mockResolvedValueOnce({ exists: false });
    deps.snapshot.mockResolvedValueOnce({
      llm: "degraded",
      data: { perplexity: "ok", finnhub: "degraded" },
    });

    const res = await GET(new Request("http://test.local/api/health"));
    const body = await res.json();

    expect(body.llm).toBe("degraded");
    expect(body.data).toEqual({ perplexity: "ok", finnhub: "degraded", firestore: "ok" });
  });

  it("stays 200 when only an AI provider is degraded (uptime is about our own stack)", async () => {
    deps.get.mockResolvedValueOnce({ exists: false });
    deps.snapshot.mockResolvedValueOnce({ llm: "down", data: { perplexity: "ok", finnhub: "ok" } });

    const res = await GET(new Request("http://test.local/api/health"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok", llm: "down" });
  });

  it("?scope=providers skips the Firestore read (the banner polls this every minute)", async () => {
    deps.snapshot.mockResolvedValueOnce({ llm: "degraded", data: { perplexity: "ok", finnhub: "ok" } });

    const res = await GET(new Request("http://test.local/api/health?scope=providers"));

    expect(deps.get).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      llm: "degraded",
      data: { perplexity: "ok", finnhub: "ok" },
    });
  });
});
