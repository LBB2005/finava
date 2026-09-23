import { describe, it, expect, vi } from "vitest";
import {
  callJev,
  requireAnswers,
  resolveJevTransport,
  JEV_ENDPOINT,
  JEV_GATEWAY_ENDPOINT,
  type JevDeps,
} from "./client";
import { JevResponseSchema } from "./schemas";

const KEY = "test-key-not-a-real-credential";

function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function errorRes(status: number, retryAfter?: string) {
  return {
    ok: false,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
    json: async () => ({}),
  } as unknown as Response;
}

const VALID_BODY = {
  model: "jev-1.13.0",
  answers: {
    contradiction: { noul: 0.2 },
    source_adequacy: {
      choice: "sufficient",
      probabilities: { sufficient: 0.7, insufficient: 0.2, conflicting: 0.1 },
      confidence: 0.8,
    },
  },
  usage: { input_tokens: 120, output_tokens: 30 },
};

function deps(fetchImpl: unknown, over: Partial<JevDeps> = {}): JevDeps {
  return {
    fetch: fetchImpl as typeof globalThis.fetch,
    apiKey: KEY,
    // An empty env, so a real key in the developer's .env cannot change which
    // endpoint these assertions see.
    env: {} as NodeJS.ProcessEnv,
    sleep: async () => {},
    ...over,
  };
}

const CALL = {
  state: "NVDA evidence bundle",
  questions: { contradiction: { type: "noul" as const, instructions: "Does it contradict?" } },
};

describe("callJev — the happy path", () => {
  it("returns the validated answers, the RESOLVED model and usage", async () => {
    const f = vi.fn().mockResolvedValue(ok(VALID_BODY));
    const r = await callJev(CALL, deps(f));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The resolved version, not the "jev-latest" we asked for.
    expect(r.model).toBe("jev-1.13.0");
    expect(r.usage).toEqual({ input_tokens: 120, output_tokens: 30 });
    expect(r.attempts).toBe(1);
  });

  it("posts to the documented endpoint with bearer auth and JSON", async () => {
    const f = vi.fn().mockResolvedValue(ok(VALID_BODY));
    await callJev(CALL, deps(f));
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body.state).toBe("NVDA evidence bundle");
    expect(body.model).toBe("jev-latest");
    expect(body.questions.contradiction.type).toBe("noul");
  });

  it("never puts the key anywhere but the Authorization header", async () => {
    const f = vi.fn().mockResolvedValue(ok(VALID_BODY));
    await callJev(CALL, deps(f));
    const [url, init] = f.mock.calls[0];
    expect(url).not.toContain(KEY);
    expect(init.body).not.toContain(KEY);
  });

  it("honours an explicit model override", async () => {
    const f = vi.fn().mockResolvedValue(ok(VALID_BODY));
    await callJev({ ...CALL, model: "jev-1.12.0" }, deps(f));
    expect(JSON.parse(f.mock.calls[0][1].body).model).toBe("jev-1.12.0");
  });
});

describe("callJev — configuration", () => {
  it("reports not_configured without a key, and makes no request", async () => {
    const f = vi.fn();
    const r = await callJev(CALL, deps(f, { apiKey: undefined }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("callJev — failures never become defaults", () => {
  it("does not retry a 401 — the key will not become valid", async () => {
    const f = vi.fn().mockResolvedValue(errorRes(401));
    const r = await callJev(CALL, deps(f));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("auth");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400 — we built a bad request", async () => {
    const f = vi.fn().mockResolvedValue(errorRes(400));
    const r = await callJev(CALL, deps(f));
    if (r.ok) throw new Error("expected failure");
    expect(r.kind).toBe("invalid_request");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 once and succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(errorRes(429, "1"))
      .mockResolvedValueOnce(ok(VALID_BODY));
    const r = await callJev(CALL, deps(f));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempts).toBe(2);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries a 503 once and gives up after the second failure", async () => {
    const f = vi.fn().mockResolvedValue(errorRes(503));
    const r = await callJev(CALL, deps(f));
    if (r.ok) throw new Error("expected failure");
    expect(r.kind).toBe("server_error");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("caps an absurd Retry-After at the remaining deadline", async () => {
    const waits: number[] = [];
    const f = vi.fn()
      .mockResolvedValueOnce(errorRes(429, "3600")) // an hour
      .mockResolvedValueOnce(ok(VALID_BODY));
    let clock = 0;
    await callJev(
      { ...CALL, deadlineMs: 5_000 },
      deps(f, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } })
    );
    expect(waits[0]).toBeLessThanOrEqual(5_000);
  });

  it("reports a timeout when the request outlives its budget", async () => {
    const f = vi.fn().mockImplementation((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })
    );
    // A zero overall deadline forces the abort path immediately.
    const r = await callJev({ ...CALL, deadlineMs: 0 }, deps(f));
    if (r.ok) throw new Error("expected failure");
    expect(r.kind).toBe("timeout");
  });

  it("reports a network error and does not throw", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const r = await callJev(CALL, deps(f));
    if (r.ok) throw new Error("expected failure");
    expect(r.kind).toBe("network");
    expect(r.reason).toContain("ECONNRESET");
  });

  it("stops before sending when the caller already cancelled", async () => {
    const f = vi.fn();
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await callJev({ ...CALL, signal: ctrl.signal }, deps(f));
    if (r.ok) throw new Error("expected failure");
    expect(f).not.toHaveBeenCalled();
    expect(r.reason).toMatch(/cancelled/);
  });
});

describe("callJev — malformed responses are rejected, not salvaged", () => {
  const cases: Array<[string, unknown]> = [
    ["a missing usage block", { model: "jev-1.13.0", answers: { a: { noul: 0.5 } } }],
    ["a missing model", { answers: { a: { noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }],
    [
      "probabilities that do not sum to 1",
      {
        model: "m",
        answers: { a: { choice: "x", probabilities: { x: 0.5, y: 0.2 }, confidence: 0.9 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
    [
      "a NaN confidence",
      {
        model: "m",
        answers: { a: { choice: "x", probabilities: { x: 1 }, confidence: NaN } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
    [
      "a noul outside 0–1",
      { model: "m", answers: { a: { noul: 1.4 } }, usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  ];

  for (const [label, body] of cases) {
    it(`rejects ${label}`, async () => {
      const f = vi.fn().mockResolvedValue(ok(body));
      const r = await callJev(CALL, deps(f));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe("malformed_response");
    });
  }

  it("does not retry a malformed response — it would fail identically", async () => {
    const f = vi.fn().mockResolvedValue(ok({ nonsense: true }));
    await callJev(CALL, deps(f));
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("requireAnswers — the request and response must be about the same thing", () => {
  it("accepts exactly the requested ids", () => {
    expect(requireAnswers(VALID_BODY.answers, ["contradiction", "source_adequacy"]).ok).toBe(true);
  });

  it("rejects a missing answer", () => {
    const r = requireAnswers({ contradiction: { noul: 0.1 } }, ["contradiction", "source_adequacy"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("source_adequacy");
  });

  it("rejects an answer we never asked for, rather than ignoring it", () => {
    // The likeliest cause is a question-set version mismatch, which makes every
    // answer positionally untrustworthy.
    const r = requireAnswers(VALID_BODY.answers, ["contradiction"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("source_adequacy");
  });
});

describe("JevResponseSchema — the documented shapes parse", () => {
  it("accepts a score answer with its legend and 2–10 levels", () => {
    const body = {
      model: "jev-1.13.0",
      answers: {
        quality: {
          score: 3.4,
          legend: { "1": "poor", "2": "fair", "3": "good", "4": "strong" },
          probabilities: { "1": 0.1, "2": 0.2, "3": 0.4, "4": 0.3 },
          confidence: 0.72,
        },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    expect(JevResponseSchema.safeParse(body).success).toBe(true);
  });

  it("accepts a bare noul, which carries no confidence field", () => {
    const body = {
      model: "jev-1.13.0",
      answers: { flag: { noul: 0.93 } },
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    expect(JevResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe("resolveJevTransport — either credential works", () => {
  const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

  it("uses TypeSafe's own API when a TypeSafe key is present", () => {
    const t = resolveJevTransport(env({ TYPESAFE_API_KEY: "ts" }));
    expect(t).toEqual({ route: "typesafe_direct", endpoint: JEV_ENDPOINT, apiKey: "ts" });
  });

  it("uses the Gateway's TypeSafe-compatible endpoint with only a Gateway key", () => {
    const t = resolveJevTransport(env({ AI_GATEWAY_API_KEY: "gw" }));
    expect(t).toEqual({ route: "vercel_gateway", endpoint: JEV_GATEWAY_ENDPOINT, apiKey: "gw" });
  });

  it("prefers the direct key when both are present — it is the more specific config", () => {
    const t = resolveJevTransport(env({ TYPESAFE_API_KEY: "ts", AI_GATEWAY_API_KEY: "gw" }));
    expect(t?.route).toBe("typesafe_direct");
    expect(t?.apiKey).toBe("ts");
  });

  it("returns null when neither key is set", () => {
    expect(resolveJevTransport(env({}))).toBeNull();
  });

  it("honours a base-URL override and strips trailing slashes", () => {
    const t = resolveJevTransport(env({ AI_GATEWAY_API_KEY: "gw", TYPESAFE_BASE_URL: "https://proxy.test//" }));
    expect(t?.endpoint).toBe("https://proxy.test/v1/systemone");
  });
});

describe("callJev — routing through the Gateway", () => {
  it("posts to the Gateway endpoint with the Gateway key, unchanged payload shape", async () => {
    const f = vi.fn().mockResolvedValue(ok(VALID_BODY));
    // No apiKey/endpoint injected: resolution comes from env alone.
    const r = await callJev(CALL, {
      fetch: f as typeof globalThis.fetch,
      env: { AI_GATEWAY_API_KEY: "gw-key" } as unknown as NodeJS.ProcessEnv,
      sleep: async () => {},
    });
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(JEV_GATEWAY_ENDPOINT);
    expect(init.headers.Authorization).toBe("Bearer gw-key");
    // The Gateway speaks TypeSafe's native dialect, so the body is identical.
    expect(JSON.parse(init.body).questions.contradiction.type).toBe("noul");
  });

  it("reports not_configured when neither credential is available", async () => {
    const f = vi.fn();
    const r = await callJev(CALL, {
      fetch: f as typeof globalThis.fetch,
      env: {} as NodeJS.ProcessEnv,
    });
    if (r.ok) throw new Error("expected failure");
    expect(r.kind).toBe("not_configured");
    expect(r.reason).toMatch(/AI_GATEWAY_API_KEY/);
    expect(f).not.toHaveBeenCalled();
  });
});
