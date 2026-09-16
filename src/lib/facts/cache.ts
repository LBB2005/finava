// src/lib/facts/cache.ts
// Two-tier cache for the facts layer.
//
// Tier 1, in process (globalThis, survives dev HMR like factorUniverse.ts):
//   quote  — 60 s while the market is open; a read taken while closed stays
//            good until the next session has closed.
//   day    — 24 h (fundamentals, filings, earnings date, Street target).
// Tier 2, Firestore factsCache/{TICKER}: the expensive score + DCF, shared by
// every user and every cold lambda. See readDerived / writeDerived.
//
// Failures and nulls are never cached (the W1-2 rule): the next caller retries.

import { isMarketOpen, lastCloseDate } from "@/lib/marketSession";

export type TtlKind = "quote" | "day";

const QUOTE_TTL_MS = 60_000;
const DAY_TTL_MS = 86_400_000;

export interface MemoEntryMeta {
  at: number;
  openAtFetch: boolean;
  closeDate: string;
}

interface MemoEntry<T> extends MemoEntryMeta {
  value: T;
}

const g = globalThis as typeof globalThis & {
  __factsMemo?: Map<string, MemoEntry<unknown>>;
  __factsInflight?: Map<string, Promise<{ value: unknown; at: number }>>;
};
const store = () => (g.__factsMemo ??= new Map());
const inflight = () => (g.__factsInflight ??= new Map());

export function clearFactsMemo() {
  store().clear();
  inflight().clear();
}

export function isFresh(e: MemoEntryMeta, kind: TtlKind, now: Date = new Date(), maxAgeSec?: number): boolean {
  const age = now.getTime() - e.at;
  if (maxAgeSec != null && age > maxAgeSec * 1000) return false;
  if (kind === "day") return age < DAY_TTL_MS;
  if (age < QUOTE_TTL_MS) return true;
  // Taken while closed and no session has closed since: the price can't have moved.
  return !e.openAtFetch && !isMarketOpen(now) && lastCloseDate(now) === e.closeDate;
}

export interface MemoOptions {
  maxAgeSec?: number;
  now?: () => Date;
}

export async function memo<T>(
  key: string,
  kind: TtlKind,
  load: () => Promise<T>,
  opts: MemoOptions = {}
): Promise<{ value: T; at: number }> {
  const now = opts.now ?? (() => new Date());
  const hit = store().get(key) as MemoEntry<T> | undefined;
  if (hit && isFresh(hit, kind, now(), opts.maxAgeSec)) return { value: hit.value, at: hit.at };

  const running = inflight().get(key) as Promise<{ value: T; at: number }> | undefined;
  if (running) return running;

  const p = (async () => {
    const value = await load();
    const t = now();
    if (value != null) {
      store().set(key, { value, at: t.getTime(), openAtFetch: isMarketOpen(t), closeDate: lastCloseDate(t) });
    }
    return { value, at: t.getTime() };
  })().finally(() => inflight().delete(key));
  inflight().set(key, p);
  return p;
}
