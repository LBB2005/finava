import { afterEach, describe, expect, it, vi } from "vitest";
import { planChunks, type ReplayTiming } from "@/lib/chatBench/timing";
import { GET } from "./route";

const get = (qs = "") => GET(new Request(`http://test.local/api/dev/replay-fixtures${qs}`));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/dev/replay-fixtures", () => {
  it("does not exist in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await get()).status).toBe(404);
    expect((await get("?name=chat-fast-nvda")).status).toBe(404);
  });

  it("lists the SSE fixtures the bench can replay", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { fixtures } = (await res.json()) as { fixtures: { name: string; route: string; recorded: boolean }[] };
    expect(fixtures).toContainEqual({ name: "chat-fast-nvda", route: "/api/chat", recorded: false });
    expect(fixtures.every((f) => !f.name.endsWith(".sse"))).toBe(true);
  });

  it("returns a fixture's bytes, expected answer and a timing that covers every byte", async () => {
    const res = await get("?name=chat-fast-nvda");
    expect(res.status).toBe(200);
    const fx = (await res.json()) as { name: string; sse: string; expected: string; timing: ReplayTiming };
    const bytes = Uint8Array.from(atob(fx.sse), (c) => c.charCodeAt(0));
    expect(fx.expected.length).toBeGreaterThan(80);
    expect(planChunks(bytes, fx.timing).length).toBeGreaterThan(1);
  });

  it("refuses names that aren't fixtures (no path tricks)", async () => {
    expect((await get("?name=../../.env")).status).toBe(404);
    expect((await get("?name=nope")).status).toBe(404);
  });
});
