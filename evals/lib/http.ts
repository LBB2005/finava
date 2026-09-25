/**
 * The live fetcher: real HTTP against a running Finava (local dev or a preview
 * URL), authenticated as the dev-bypass user. Every request is tapped. Timings
 * and the raw `data:` payloads are recorded as the bytes arrive, before the
 * client code reads them, so the eval can compare what the server sent with
 * what the client kept.
 */
import type { Fetcher } from "@/lib/chat/requests";

export interface Tapped {
  url: string;
  body: unknown;
  startedAt: number;
  status: number | null;
  firstByteAt: number | null;
  /** First payload that carried answer text (`text` or `final_response`). */
  firstTextAt: number | null;
  endedAt: number | null;
  payloads: unknown[];
  /** The raw body, for `--record`. */
  bytes: Uint8Array[];
  /** Epoch ms each chunk in `bytes` arrived, so a replay can keep the pace. */
  chunkAt: number[];
  error?: string;
}

export interface HttpOptions {
  base: string;
  /** Per-request ceiling. A crew run can take 5+ minutes. */
  timeoutMs?: number;
  token?: string;
}

function parsePayload(line: string): unknown | undefined {
  if (!line.startsWith("data: ")) return undefined;
  const data = line.slice(6);
  try { return JSON.parse(data); } catch { return data; }
}

function carriesText(p: unknown): boolean {
  const e = p as { type?: string; text?: unknown; content?: unknown };
  return (e?.type === "final_response" && typeof e.content === "string" && e.content.length > 0) || (e?.type === undefined && typeof e?.text === "string");
}

export function httpFetcher(opts: HttpOptions): { fetcher: Fetcher; log: Tapped[] } {
  const log: Tapped[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const entry: Tapped = {
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      startedAt: Date.now(),
      status: null,
      firstByteAt: null,
      firstTextAt: null,
      endedAt: null,
      payloads: [],
      bytes: [],
      chunkAt: [],
    };
    log.push(entry);
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 480_000), init?.signal].filter(Boolean) as AbortSignal[];
    let res: Response;
    try {
      res = await fetch(`${opts.base}${url}`, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), Authorization: `Bearer ${opts.token ?? "dev-bypass"}` },
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
      entry.endedAt = Date.now();
      throw e;
    }
    entry.status = res.status;
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      // JSON routes (the router): keep the parsed body so the lane decision is on record.
      const json = await res.clone().json().catch(() => undefined);
      if (json !== undefined) entry.payloads.push(json);
      entry.firstByteAt = entry.endedAt = Date.now();
      return res;
    }

    const decoder = new TextDecoder();
    let buf = "";
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const now = Date.now();
        entry.firstByteAt ??= now;
        entry.bytes.push(chunk);
        entry.chunkAt.push(now);
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          const p = parsePayload(l);
          if (p === undefined) continue;
          entry.payloads.push(p);
          if (entry.firstTextAt == null && carriesText(p)) entry.firstTextAt = now;
        }
        controller.enqueue(chunk);
      },
      flush() {
        const p = parsePayload(buf);
        if (p !== undefined) entry.payloads.push(p);
        entry.endedAt = Date.now();
      },
    });
    return new Response(res.body.pipeThrough(tap), { status: res.status, headers: res.headers });
  };
  return { fetcher, log };
}

/** Plain JSON calls to the app (conversation persistence), with the same auth. */
export async function appJson<T>(opts: HttpOptions, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${opts.base}${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token ?? "dev-bypass"}`, ...(init?.headers as Record<string, string>) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}`);
  return (await res.json()) as T;
}
