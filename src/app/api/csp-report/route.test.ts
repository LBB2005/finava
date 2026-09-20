import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ rateLimitGuard: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));
vi.mock("@/lib/logger", () => ({ logger: () => ({ warn: deps.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { POST } from "./route";

const post = (body: string) => new Request("http://t/api/csp-report", { method: "POST", body });

beforeEach(() => {
  vi.clearAllMocks();
  deps.rateLimitGuard.mockResolvedValue(null);
});

describe("POST /api/csp-report", () => {
  it("logs the directive, blocked host and page path — never full URLs", async () => {
    const res = await POST(post(JSON.stringify({
      "csp-report": {
        "violated-directive": "img-src",
        "blocked-uri": "https://evil.example/p.png?h=AAPL:10:150",
        "document-uri": "https://finava.ai/chat?c=abc123",
      },
    })));
    expect(res.status).toBe(204);
    expect(deps.warn).toHaveBeenCalledWith("csp violation", { directive: "img-src", blocked: "evil.example", page: "/chat" });
    expect(JSON.stringify(deps.warn.mock.calls)).not.toContain("AAPL");
    expect(JSON.stringify(deps.warn.mock.calls)).not.toContain("abc123");
  });

  it("accepts a Reporting API batch, bounded", async () => {
    const one = { type: "csp-violation", body: { effectiveDirective: "script-src-elem", blockedURL: "inline", documentURL: "https://finava.ai/" } };
    await POST(post(JSON.stringify(Array(50).fill(one))));
    expect(deps.warn).toHaveBeenCalledTimes(10);
    expect(deps.warn).toHaveBeenCalledWith("csp violation", { directive: "script-src-elem", blocked: "inline", page: "/" });
  });

  it("answers 204 to junk and to throttled clients without logging", async () => {
    expect((await POST(post("not json"))).status).toBe(204);
    deps.rateLimitGuard.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await POST(post("{}"))).status).toBe(204);
    expect(deps.warn).not.toHaveBeenCalled();
  });
});
