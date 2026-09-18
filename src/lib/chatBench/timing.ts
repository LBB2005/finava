/**
 * Chat replay bench (dev only): the timing sidecar recorded next to a real SSE
 * fixture, so the replay page can feed the stream to the chat UI at the pace
 * the network delivered it.
 *
 * `evals/lib/measure.ts` writes `recorded-*.timing.json` with `fixtureTiming`;
 * `/dev/chat-replay` reads it back with `planChunks`. Fixtures without a
 * sidecar (the synthetic ones) replay with `defaultTiming`.
 */
import type { ChatMode } from "@/types/chat";
import type { StoredMessage } from "@/lib/chat/storedMessage";

/** How the turn was sent: a composer mode, or the "Run full analysis" button. */
export type ReplaySendMode = ChatMode | "full_analysis_button";

export interface ReplayTiming {
  version: 1;
  /** The lane request the fixture holds. */
  route: "/api/chat" | "/api/agent";
  mode: ReplaySendMode;
  /** What the user typed (empty for the button). */
  prompt: string;
  /** The conversation before this turn, so the replay starts from the same screen. */
  prior: StoredMessage[];
  /** Auto's /api/classify call before the lane started, if there was one. */
  router: { ms: number; response: unknown } | null;
  /** Each network chunk of the lane response: [ms after the request started, bytes]. */
  chunks: [number, number][];
}

/** The parts of an eval-tapped request the sidecar needs (see evals/lib/http.ts). */
export interface TappedLane {
  url: string;
  startedAt: number;
  /** Epoch ms each chunk arrived, parallel to `bytes`. */
  chunkAt: number[];
  bytes: Uint8Array[];
}

export function fixtureTiming(a: {
  lane: TappedLane;
  router: { startedAt: number; endedAt: number | null; payloads: unknown[] } | null;
  mode: ReplaySendMode;
  prompt: string;
  prior: StoredMessage[];
}): ReplayTiming {
  const { lane } = a;
  if (lane.chunkAt.length !== lane.bytes.length) {
    throw new Error(`${lane.url}: ${lane.bytes.length} chunks but ${lane.chunkAt.length} chunk times`);
  }
  return {
    version: 1,
    route: lane.url === "/api/agent" ? "/api/agent" : "/api/chat",
    mode: a.mode,
    prompt: a.prompt,
    prior: a.prior,
    router:
      a.router && a.router.endedAt != null
        ? { ms: a.router.endedAt - a.router.startedAt, response: a.router.payloads[0] ?? null }
        : null,
    chunks: lane.bytes.map((b, i) => [lane.chunkAt[i] - lane.startedAt, b.length]),
  };
}

/** Cut the fixture into the chunks the network delivered, each with its arrival time. */
export function planChunks(bytes: Uint8Array, timing: ReplayTiming): { at: number; bytes: Uint8Array }[] {
  const total = timing.chunks.reduce((n, [, len]) => n + len, 0);
  if (total !== bytes.length) {
    throw new Error(`timing covers ${total} bytes but the fixture has ${bytes.length} bytes`);
  }
  let offset = 0;
  return timing.chunks.map(([at, len]) => {
    const chunk = bytes.subarray(offset, offset + len);
    offset += len;
    return { at, bytes: chunk };
  });
}

/** A steady pace for fixtures recorded without timing: one SSE event per chunk. */
export function defaultTiming(name: string, bytes: Uint8Array, stepMs = 40): ReplayTiming {
  const bare = name.replace(/^recorded-/, "");
  const route = bare.startsWith("agent-") ? "/api/agent" : "/api/chat";
  const mode: ChatMode = route === "/api/chat" ? "simple" : bare.startsWith("agent-discover") ? "discover" : "agent";
  const chunks: [number, number][] = [];
  const text = new TextDecoder().decode(bytes);
  const enc = new TextEncoder();
  let i = 0;
  for (const event of text.split(/(?<=\n\n)/)) {
    if (!event) continue;
    chunks.push([++i * stepMs, enc.encode(event).length]);
  }
  return { version: 1, route, mode, prompt: "Replay", prior: [], router: null, chunks };
}

/** The send-queue request that reproduces the recorded turn. */
export function sendFor(t: Pick<ReplayTiming, "mode" | "prompt">): {
  kind: "send" | "full_analysis";
  mode: ChatMode;
  text: string;
} {
  if (t.mode === "full_analysis_button") return { kind: "full_analysis", mode: "auto", text: t.prompt };
  return { kind: "send", mode: t.mode, text: t.prompt };
}
