import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayClock } from "./replayClock";
import { createReplayFetch } from "./replayFetch";
import type { ReplayTiming } from "./timing";

const enc = new TextEncoder();
const SSE = 'data: {"text":"Hel"}\n\ndata: {"text":"lo"}\n\ndata: [DONE]\n\n';

function timing(over: Partial<ReplayTiming> = {}): ReplayTiming {
  return {
    version: 1,
    route: "/api/chat",
    mode: "auto",
    prompt: "hi",
    prior: [],
    router: { ms: 800, response: { intent: "fast" } },
    chunks: [
      [2_000, 22],
      [2_050, 21],
      [2_300, 14],
    ],
    ...over,
  };
}

function setup(t = timing()) {
  const clock = new ReplayClock({ now: () => Date.now() });
  const passthrough = vi.fn(async () => new Response("real"));
  const replay = createReplayFetch({ bytes: enc.encode(SSE), timing: t }, clock, passthrough);
  clock.play();
  return { clock, passthrough, replay };
}

async function readAll(res: Response): Promise<{ text: string; at: number[] }> {
  const reader = res.body!.getReader();
  const at: number[] = [];
  let text = "";
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    at.push(Date.now());
    text += dec.decode(value, { stream: true });
  }
  return { text, at };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createReplayFetch", () => {
  it("streams the fixture's exact bytes, chunk by chunk, at the recorded times", async () => {
    const { replay } = setup();
    const t0 = Date.now();
    const res = await replay.fetch("/api/chat", { method: "POST", body: "{}" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reading = readAll(res);
    await vi.advanceTimersByTimeAsync(3_000);
    const { text, at } = await reading;
    expect(text).toBe(SSE);
    expect(at.map((t) => t - t0)).toEqual([2_000, 2_050, 2_300]);
  });

  it("hands a busy page everything that arrived while it was busy in one read, as a network does", async () => {
    const { replay } = setup();
    const res = await replay.fetch("/api/chat", { method: "POST", body: "{}" });
    const reader = res.body!.getReader();
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(new TextDecoder().decode((await first).value)).toBe('data: {"text":"Hel"}\n\n');
    // The page is busy until well after the other two chunks were due.
    await vi.advanceTimersByTimeAsync(1_000);
    const rest = reader.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(new TextDecoder().decode((await rest).value)).toBe('data: {"text":"lo"}\n\ndata: [DONE]\n\n');
  });

  it("answers Auto's router with the recorded decision after the recorded delay", async () => {
    const { replay } = setup();
    let body: unknown;
    void replay.fetch("/api/classify", { method: "POST", body: "{}" }).then(async (r) => (body = await r.json()));
    await vi.advanceTimersByTimeAsync(799);
    expect(body).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(body).toEqual({ intent: "fast" });
  });

  it("keeps the replay out of the real conversation store", async () => {
    const { replay, passthrough } = setup();
    const res = await replay.fetch("/api/conversations/replay-1/messages", { method: "POST", body: "{}" });
    expect(res.ok).toBe(true);
    expect(passthrough).not.toHaveBeenCalled();
  });

  it("passes every other request through to the real network", async () => {
    const { replay, passthrough } = setup();
    await replay.fetch("/api/quotes?t=NVDA");
    await replay.fetch("/api/conversations");
    expect(passthrough).toHaveBeenCalledTimes(2);
  });

  it("errors the body with an AbortError when the run is stopped mid-stream, as fetch does", async () => {
    const { replay } = setup();
    const ctrl = new AbortController();
    const res = await replay.fetch("/api/chat", { method: "POST", body: "{}", signal: ctrl.signal });
    const reader = res.body!.getReader();
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    const second = reader.read();
    ctrl.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
  });

  it("plays the fixture once; a second lane request is refused", async () => {
    const { replay } = setup();
    await replay.fetch("/api/chat", { method: "POST", body: "{}" });
    const again = await replay.fetch("/api/chat", { method: "POST", body: "{}" });
    expect(again.status).toBe(409);
  });

  it("refuses a lane the fixture wasn't recorded from, instead of passing it to the real (paid) route", async () => {
    const { replay, passthrough } = setup();
    const res = await replay.fetch("/api/agent", { method: "POST", body: "{}" });
    expect(res.status).toBe(409);
    expect(passthrough).not.toHaveBeenCalled();
  });

  it("matches absolute URLs and Request objects too", async () => {
    const { replay, passthrough } = setup();
    const res = await replay.fetch(new Request("http://localhost:3011/api/conversations/x/messages", { method: "POST" }));
    expect(res.ok).toBe(true);
    expect(passthrough).not.toHaveBeenCalled();
  });

  it("reports when the lane request started, so the bench can time from it", async () => {
    const { replay } = setup();
    expect(replay.laneStartedAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    await replay.fetch("/api/chat", { method: "POST", body: "{}" });
    expect(replay.laneStartedAt()).toBe(100);
  });
});
