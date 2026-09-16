"use client";
// Session-scoped store for Finava analyses. A module-level Map keyed by ticker
// survives tab unmount/remount, so the analysis runs once per ticker per visit and
// progress persists if the user toggles away mid-stream. runFinava() is deduped by
// an in-flight guard, so a double tab-click can't fire two runs.

import { mutate } from "swr";
import { authFetch } from "@/lib/authFetch";
import { SIGNAL_ORDER, type FinavaAnalysis, type FinavaEvent, type FinavaSignal } from "@/lib/finava";

export type FinavaStatus = "idle" | "streaming" | "done" | "error";

export interface FinavaEntry {
  status: FinavaStatus;
  analysis: FinavaAnalysis;
  error: string | null;
  /** When the verdict was produced — live runs stamp now; hydrated cache
   *  carries the persisted timestamp (drives the "2d ago" age display). */
  updatedAt: string | null;
}

const store = new Map<string, FinavaEntry>();
const inflight = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function emptyEntry(): FinavaEntry {
  return { status: "idle", analysis: { signals: [], verdict: null }, error: null, updatedAt: null };
}

// Stable singleton for the "not started" state. useSyncExternalStore compares
// getSnapshot results by reference, so getEntry must return the SAME object for an
// absent ticker every call — a fresh emptyEntry() each time would loop forever.
const EMPTY: FinavaEntry = {
  status: "idle",
  analysis: { signals: [], verdict: null },
  error: null,
  updatedAt: null,
};

/**
 * Seed the store from the per-user verdict cache (GET /verdict) so the rail,
 * Overview Read, and Finava tab render a completed analysis without charging a
 * run. Never clobbers live state — only fills an idle/absent entry.
 */
export function hydrateFinava(ticker: string, analysis: FinavaAnalysis, updatedAt: string) {
  const sym = ticker.toUpperCase();
  const existing = store.get(sym);
  if (existing && existing.status !== "idle") return;
  if (!analysis.verdict) return;
  setEntry(sym, { status: "done", analysis, error: null, updatedAt });
}

export function getEntry(ticker: string): FinavaEntry {
  return store.get(ticker) ?? EMPTY;
}

function setEntry(ticker: string, entry: FinavaEntry) {
  store.set(ticker, entry);
  listeners.get(ticker)?.forEach((fn) => fn());
}

export function subscribe(ticker: string, fn: () => void): () => void {
  let set = listeners.get(ticker);
  if (!set) {
    set = new Set();
    listeners.set(ticker, set);
  }
  set.add(fn);
  return () => set!.delete(fn);
}

/** Merge a streamed signal in, keeping the canonical 6-signal display order. */
function withSignal(analysis: FinavaAnalysis, signal: FinavaSignal): FinavaAnalysis {
  const next = analysis.signals.filter((s) => s.key !== signal.key).concat(signal);
  next.sort((a, b) => SIGNAL_ORDER.indexOf(a.key) - SIGNAL_ORDER.indexOf(b.key));
  return { ...analysis, signals: next };
}

/** A run recomputes the canonical score/DCF server-side; refresh every facts read of this ticker. */
function revalidateFacts(sym: string) {
  void mutate((key: unknown) => {
    if (typeof key !== "string") return false;
    if (key === `/api/facts/${sym}` || key.startsWith(`/api/facts/${sym}?`)) return true;
    const m = key.match(/^\/api\/facts\?tickers=([^&]*)/);
    return !!m && m[1].split(",").includes(sym);
  });
}

/**
 * Kick off (or no-op resume) the analysis for a ticker. Safe to call repeatedly.
 * `force` re-runs a done/hydrated ticker stale-while-revalidate style: the old
 * verdict stays on screen while fresh signals stream in over it.
 */
export async function runFinava(ticker: string, opts: { force?: boolean } = {}): Promise<void> {
  const sym = ticker.toUpperCase();
  const existing = store.get(sym);
  if (inflight.has(sym)) return; // already running
  if (existing && existing.status === "streaming") return;
  if (!opts.force && existing && existing.status === "done") return;

  inflight.add(sym);
  const keep = opts.force && existing ? existing.analysis : { signals: [], verdict: null };
  setEntry(sym, {
    status: "streaming",
    analysis: keep,
    error: null,
    updatedAt: existing?.updatedAt ?? null,
  });

  try {
    const res = await authFetch(`/api/stock/${encodeURIComponent(sym)}/finava-analysis`, {
      method: "POST",
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Parse the SSE-style `data: {...}\n\n` frames out of the byte stream.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? ""; // keep the trailing partial frame
      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        let event: FinavaEvent;
        try {
          event = JSON.parse(json) as FinavaEvent;
        } catch {
          continue;
        }
        const cur = store.get(sym) ?? emptyEntry();
        if (event.type === "signal") {
          setEntry(sym, { ...cur, status: "streaming", analysis: withSignal(cur.analysis, event.signal) });
        } else if (event.type === "verdict") {
          setEntry(sym, {
            ...cur,
            status: "done",
            analysis: { ...cur.analysis, verdict: event.verdict },
            updatedAt: new Date().toISOString(),
          });
          revalidateFacts(sym);
        } else if (event.type === "error") {
          setEntry(sym, { ...cur, status: "error", error: event.message });
        }
      }
    }

    // Stream ended without a verdict and without an explicit error.
    const final = store.get(sym) ?? emptyEntry();
    if (final.status !== "done" && final.status !== "error") {
      setEntry(sym, { ...final, status: "error", error: "The analysis ended unexpectedly." });
    }
  } catch (err) {
    const cur = store.get(sym) ?? emptyEntry();
    setEntry(sym, {
      ...cur,
      status: "error",
      error: err instanceof Error ? err.message : "Failed to run analysis.",
    });
  } finally {
    inflight.delete(sym);
  }
}

/** Drop a ticker's cached analysis so the next run starts fresh (used by retry). */
export function resetFinava(ticker: string) {
  const sym = ticker.toUpperCase();
  store.delete(sym);
  setEntry(sym, emptyEntry());
}
