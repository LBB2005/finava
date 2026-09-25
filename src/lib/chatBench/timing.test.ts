import { describe, expect, it } from "vitest";
import { defaultTiming, fixtureTiming, planChunks, sendFor, type ReplayTiming } from "./timing";

const enc = new TextEncoder();

describe("fixtureTiming", () => {
  it("keeps each network chunk's arrival time (ms after the request) and size", () => {
    const t = fixtureTiming({
      lane: { url: "/api/chat", startedAt: 1_000, chunkAt: [3_500, 3_520, 4_100], bytes: [enc.encode("abc"), enc.encode("de"), enc.encode("fghij")] },
      router: null,
      mode: "auto",
      prompt: "is nvda a buy",
      prior: [],
    });
    expect(t.version).toBe(1);
    expect(t.route).toBe("/api/chat");
    expect(t.chunks).toEqual([
      [2_500, 3],
      [2_520, 2],
      [3_100, 5],
    ]);
  });

  it("records how long Auto's router took and what it answered", () => {
    const t = fixtureTiming({
      lane: { url: "/api/agent", startedAt: 5_000, chunkAt: [5_010], bytes: [enc.encode("x")] },
      router: { startedAt: 4_200, endedAt: 4_990, payloads: [{ intent: "full_analysis" }] },
      mode: "auto",
      prompt: "full analysis of AMD",
      prior: [],
    });
    expect(t.router).toEqual({ ms: 790, response: { intent: "full_analysis" } });
  });

  it("refuses a lane request whose chunk times and chunks don't line up", () => {
    expect(() =>
      fixtureTiming({
        lane: { url: "/api/chat", startedAt: 0, chunkAt: [1], bytes: [enc.encode("a"), enc.encode("b")] },
        router: null,
        mode: "auto",
        prompt: "q",
        prior: [],
      })
    ).toThrow(/chunk/);
  });
});

describe("planChunks", () => {
  const timing = (chunks: [number, number][]): ReplayTiming => ({
    version: 1,
    route: "/api/chat",
    mode: "auto",
    prompt: "q",
    prior: [],
    router: null,
    chunks,
  });

  it("cuts the fixture bytes exactly where the network did", () => {
    const bytes = enc.encode("abcdefghij");
    const plan = planChunks(bytes, timing([[10, 3], [25, 2], [40, 5]]));
    expect(plan.map((c) => c.at)).toEqual([10, 25, 40]);
    expect(plan.map((c) => new TextDecoder().decode(c.bytes))).toEqual(["abc", "de", "fghij"]);
  });

  it("refuses a timing file recorded for different bytes", () => {
    expect(() => planChunks(enc.encode("abcdef"), timing([[10, 3], [25, 2]]))).toThrow(/6 bytes/);
  });
});

describe("defaultTiming (fixtures recorded without timing)", () => {
  const sse = enc.encode('data: {"text":"a"}\n\ndata: {"text":"b"}\n\ndata: [DONE]\n\n');

  it("sends one SSE event per chunk at a steady pace", () => {
    const t = defaultTiming("chat-fast-nvda", sse, 40);
    expect(t.route).toBe("/api/chat");
    expect(t.chunks.map(([at]) => at)).toEqual([40, 80, 120]);
    expect(t.chunks.reduce((n, [, len]) => n + len, 0)).toBe(sse.length);
    expect(new TextDecoder().decode(planChunks(sse, t)[0].bytes)).toBe('data: {"text":"a"}\n\n');
  });

  it("maps the fixture's route prefix to the manual lane that calls it", () => {
    expect(defaultTiming("agent-crew-replace", sse).mode).toBe("agent");
    expect(defaultTiming("recorded-chat-x-1", sse).mode).toBe("simple");
    expect(defaultTiming("agent-discover-scout", sse).mode).toBe("discover");
  });
});

describe("sendFor", () => {
  it("replays the Run full analysis button as the engine's full_analysis request", () => {
    expect(sendFor({ mode: "full_analysis_button", prompt: "" })).toEqual({ kind: "full_analysis", mode: "auto", text: "" });
  });

  it("replays a typed turn in the mode it was sent in", () => {
    expect(sendFor({ mode: "auto", prompt: "is it too late to buy nvidia" })).toEqual({
      kind: "send",
      mode: "auto",
      text: "is it too late to buy nvidia",
    });
    expect(sendFor({ mode: "discover", prompt: "cheap energy" })).toEqual({ kind: "send", mode: "discover", text: "cheap energy" });
  });
});
