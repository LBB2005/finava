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
import { db } from "@/lib/firebase-admin";
import { hasValue, SCORE_VERSION, DCF_VERSION, type Fact, type ScoreFact, type DcfFact } from "./types";

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
  derivedMirror().clear();
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

// ── Tier 2: score + DCF in Firestore ──────────────────────────────────────────

export interface Derived {
  score: Fact<ScoreFact> | null;
  dcf: Fact<DcfFact> | null;
}

interface DerivedDoc {
  score?: Fact<ScoreFact>;
  scoreAt?: number;
  dcf?: Fact<DcfFact>;
  dcfAt?: number;
}

const derivedMirror = () =>
  ((g as typeof g & { __factsDerived?: Map<string, DerivedDoc> }).__factsDerived ??= new Map());

function pickDerived(doc: DerivedDoc | undefined, now: Date, maxAgeSec?: number): Derived {
  const ok = (at: number | undefined) =>
    at != null && isFresh({ at, openAtFetch: true, closeDate: "" }, "day", now, maxAgeSec);
  return {
    score: doc?.score && ok(doc.scoreAt) && doc.score.value?.version === SCORE_VERSION ? doc.score : null,
    dcf: doc?.dcf && ok(doc.dcfAt) && doc.dcf.value?.version === DCF_VERSION ? doc.dcf : null,
  };
}

export async function readDerived(ticker: string, opts: MemoOptions = {}): Promise<Derived> {
  const sym = ticker.toUpperCase();
  const now = (opts.now ?? (() => new Date()))();
  const mirrored = pickDerived(derivedMirror().get(sym), now, opts.maxAgeSec);
  if (mirrored.score && mirrored.dcf) return mirrored;
  try {
    const snap = await db.collection("factsCache").doc(sym).get();
    const doc = snap.exists ? (snap.data() as DerivedDoc) : undefined;
    if (doc) derivedMirror().set(sym, doc);
    return pickDerived(doc, now, opts.maxAgeSec);
  } catch (err) {
    console.error("[facts cache] read failed", sym, err);
    return mirrored;
  }
}

/** Persist successful computes only. Never throws. */
export async function writeDerived(ticker: string, d: Derived, now: Date = new Date()): Promise<void> {
  const sym = ticker.toUpperCase();
  const patch: DerivedDoc = {};
  if (hasValue(d.score)) Object.assign(patch, { score: d.score, scoreAt: now.getTime() });
  if (hasValue(d.dcf)) Object.assign(patch, { dcf: d.dcf, dcfAt: now.getTime() });
  if (!patch.score && !patch.dcf) return;
  derivedMirror().set(sym, { ...derivedMirror().get(sym), ...patch });
  try {
    await db.collection("factsCache").doc(sym).set(patch as Record<string, unknown>, { merge: true });
  } catch (err) {
    console.error("[facts cache] write failed", sym, err);
  }
}
