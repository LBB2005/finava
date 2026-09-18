/**
 * Chat replay bench (dev only): a `fetch` that plays one recorded turn back to
 * the real chat client. The replay page installs it over `window.fetch`, so
 * ChatEngine, the stream reader, the chat store and MessageList all run
 * unchanged; only the network is swapped for the recording.
 *
 * - the lane route (/api/chat or /api/agent) streams the fixture bytes in the
 *   recorded chunks at the recorded times, once;
 * - /api/classify answers with the recorded router decision after its delay;
 * - conversation writes are swallowed, so a replay never touches Firestore;
 * - a lane request the fixture can't answer is refused, never sent to the real
 *   (paid) route;
 * - everything else goes to the real network.
 */
import type { ReplayClock } from "./replayClock";
import { planChunks, type ReplayTiming } from "./timing";

const LANES = new Set(["/api/chat", "/api/agent"]);

function pathOf(input: RequestInfo | URL): string {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return new URL(href, "http://replay.local").pathname;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

const abortError = () => new DOMException("The operation was aborted.", "AbortError");

export interface ReplayFetch {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Replay ms at which the lane request was made, or null before it. */
  laneStartedAt: () => number | null;
}

export function createReplayFetch(
  fixture: { bytes: Uint8Array; timing: ReplayTiming },
  clock: ReplayClock,
  passthrough: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): ReplayFetch {
  const plan = planChunks(fixture.bytes, fixture.timing);
  let laneStartedAt: number | null = null;

  function laneResponse(signal: AbortSignal | null | undefined): Response {
    const t0 = clock.elapsed();
    laneStartedAt = t0;
    let i = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          if (i >= plan.length) return c.close();
          try {
            await clock.sleepUntil(t0 + plan[i].at, signal ?? undefined);
          } catch (e) {
            c.error(e);
            return;
          }
          // Everything that arrived while the page was busy comes back in one read,
          // as bytes pile up in a real network pipe.
          const due: Uint8Array[] = [];
          while (i < plan.length && t0 + plan[i].at <= clock.elapsed()) due.push(plan[i++].bytes);
          if (due.length === 1) c.enqueue(due[0]);
          else {
            const joined = new Uint8Array(due.reduce((n, b) => n + b.length, 0));
            let at = 0;
            for (const b of due) {
              joined.set(b, at);
              at += b.length;
            }
            c.enqueue(joined);
          }
        },
      },
      // Pull only when the page asks for the next read, never a chunk ahead.
      { highWaterMark: 0 }
    );
    signal?.addEventListener("abort", () => {
      // fetch errors a body that is mid-read when its request is aborted.
      body.cancel(abortError()).catch(() => {});
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  async function replayFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = pathOf(input);
    const method = methodOf(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

    if (path === "/api/classify" && method === "POST") {
      const router = fixture.timing.router;
      await clock.sleepUntil(clock.elapsed() + (router?.ms ?? 0), signal ?? undefined);
      return Response.json(router?.response ?? { intent: "fast" });
    }
    if (LANES.has(path)) {
      if (path !== fixture.timing.route || laneStartedAt != null) {
        return Response.json({ error: `replay: no recording for this ${path} request` }, { status: 409 });
      }
      return laneResponse(signal);
    }
    if (path.startsWith("/api/conversations") && method !== "GET") {
      return Response.json({ ok: true });
    }
    return passthrough(input, init);
  }

  return { fetch: replayFetch, laneStartedAt: () => laneStartedAt };
}
