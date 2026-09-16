/**
 * Replays SSE fixture files as the byte streams a browser would receive.
 *
 * The bytes are cut at seeded pseudo-random offsets. Those cuts land mid-line,
 * mid-JSON and mid-UTF-8 sequence ("—", "×", "≈"), the boundaries a real network
 * produces and a single `enqueue(wholeFile)` never exercises.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "sse");

export interface Fixture {
  name: string;
  /** Which route produced it: `agent-*` came from /api/agent, `chat-*` from /api/chat. Recorded fixtures keep the prefix after `recorded-`. */
  route: "agent" | "chat";
  bytes: Uint8Array;
  /** The answer the user should end up with. */
  expected: string;
}

function routeOf(name: string): "agent" | "chat" {
  const bare = name.replace(/^recorded-/, "");
  if (bare.startsWith("agent-")) return "agent";
  if (bare.startsWith("chat-")) return "chat";
  throw new Error(`fixture ${name}: name must start with agent- or chat-`);
}

export function loadFixture(name: string): Fixture {
  return {
    name,
    route: routeOf(name),
    bytes: new Uint8Array(readFileSync(path.join(FIXTURE_DIR, `${name}.sse`))),
    expected: readFileSync(path.join(FIXTURE_DIR, `${name}.expected.md`), "utf8"),
  };
}

export function listFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".sse"))
    .map((f) => f.slice(0, -".sse".length))
    .sort();
}

/** Byte chunk sizes from a seeded LCG. Seed 0 means one chunk, the whole body. */
export function chunkBytes(bytes: Uint8Array, seed: number, maxChunk = 48): Uint8Array[] {
  if (seed === 0) return [bytes];
  const out: Uint8Array[] = [];
  let s = seed;
  for (let i = 0; i < bytes.length; ) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const n = 1 + (s % maxChunk);
    out.push(bytes.subarray(i, i + n));
    i += n;
  }
  return out;
}

/**
 * One chunk per read, like a network body. An aborted signal errors the stream the
 * way fetch does, so Stop behaves as it does in a browser.
 */
export function streamOf(chunks: Uint8Array[], signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (signal?.aborted) return c.error(new DOMException("The operation was aborted.", "AbortError"));
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}

/** A 200 response whose body replays the fixture in chunks. */
export function fixtureResponse(fx: Fixture, seed: number, signal?: AbortSignal | null): Response {
  return new Response(streamOf(chunkBytes(fx.bytes, seed), signal), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** The raw `data:` payloads in order, parsed without any client code, for assertions about the wire itself. */
export function wireEvents(bytes: Uint8Array): unknown[] {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .map((d) => {
      try { return JSON.parse(d); } catch { return d; }
    });
}
