/**
 * `eval:live --record` keeps real streams for the smoke eval and for the chat
 * replay bench (/dev/chat-replay), which needs to know when each chunk arrived.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planChunks, type ReplayTiming } from "@/lib/chatBench/timing";
import { httpFetcher, type Tapped } from "./http";
import { recordFixture } from "./measure";

const enc = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("httpFetcher tap", () => {
  it("records when each chunk of an SSE body arrived, parallel to the bytes", async () => {
    const parts = ['data: {"text":"Hel', 'lo"}\n\n', "data: [DONE]\n\n"];
    vi.stubGlobal("fetch", async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const p of parts) c.enqueue(enc.encode(p));
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      )
    );
    const { fetcher, log } = httpFetcher({ base: "http://app" });
    const res = await fetcher("/api/chat", { method: "POST", body: "{}" });
    await res.text();
    expect(log[0].bytes).toHaveLength(3);
    expect(log[0].chunkAt).toHaveLength(3);
    for (const t of log[0].chunkAt) expect(t).toBeGreaterThanOrEqual(log[0].startedAt);
  });
});

describe("recordFixture", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the timing sidecar next to the fixture, and it replays to the same bytes", () => {
    dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    const bytes = [enc.encode('data: {"text":"Hi'), enc.encode(' there, this is the answer."}\n\n')];
    const req: Tapped = {
      url: "/api/chat",
      body: {},
      startedAt: 1_000,
      status: 200,
      firstByteAt: 3_000,
      firstTextAt: 3_000,
      endedAt: 3_400,
      payloads: [{ text: "Hi there, this is the answer." }],
      bytes,
      chunkAt: [3_000, 3_400],
    };
    const router: Tapped = { ...req, url: "/api/classify", startedAt: 200, endedAt: 990, payloads: [{ intent: "fast" }], bytes: [], chunkAt: [] };

    const file = recordFixture("scenario-1", req, { router, mode: "auto", prompt: "hi?", prior: [] }, dir);

    expect(file).toBe("recorded-chat-scenario-1");
    const sse = new Uint8Array(readFileSync(path.join(dir, `${file}.sse`)));
    const timing = JSON.parse(readFileSync(path.join(dir, `${file}.timing.json`), "utf8")) as ReplayTiming;
    expect(timing.router).toEqual({ ms: 790, response: { intent: "fast" } });
    expect(timing.prompt).toBe("hi?");
    expect(planChunks(sse, timing).map((c) => c.at)).toEqual([2_000, 2_400]);
    expect(readFileSync(path.join(dir, `${file}.expected.md`), "utf8")).toBe("Hi there, this is the answer.");
  });
});
