# W3-1 Facts Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every surface shows one Finava Score, one DCF and one price, from one server module (`src/lib/facts`), with source and as-of on every number.

**Architecture:** `getTickerFacts(ticker)` fans out to the existing data libs (finnhub, edgar, stockData, finavaInputs, finavaScore, dcf), derives P/E, EV/EBITDA, market cap and the DCF in code, and caches two tiers: in-process for quotes and fundamentals, Firestore `factsCache/{TICKER}` for score + DCF. `/api/facts/[ticker]` and `/api/facts?tickers=` serve it to `useTickerFacts` / `useTickerFactsSlim`. The old `/score` and `/dcf` routes, the finava-analysis route and `quickContext` become readers of facts. The 6-factor universe composite remains only as a ranking input.

**Tech Stack:** Next.js App Router (this repo's version; see AGENTS.md), TypeScript, vitest, SWR, firebase-admin.

**Spec:** `docs/superpowers/specs/2026-09-15-facts-layer-design.md`

**Worktree:** `/Users/liamblackshaw-brown/code/finava-w3-1-facts-layer` (branch `feat/w3-1-facts-layer`, dev port 3011). Every command below runs from the worktree root.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/facts/types.ts` (new, client-safe) | `Fact<T>`, `TickerFacts`, `TickerFactsSlim`, portfolio types, `fact()`, `missing()`, `toSlim()`, versions |
| `src/lib/facts/format.ts` (new, client-safe) | `asOfLabel()`, `factTitle()` for hover/small print |
| `src/lib/facts/signals.ts` (new, client-safe) | `pillarToSignal()` moved out of the finava-analysis route |
| `src/lib/facts/cache.ts` (new, server) | in-process `memo()` with quote/day TTLs + in-flight dedupe; Firestore `readDerived()` / `writeDerived()` |
| `src/lib/facts/fast.ts` (new, server-safe pure) | `buildFastFacts()`: raw source payloads → the non-derived facts |
| `src/lib/facts/ticker.ts` (new, server) | `getTickerFacts()`, `getTickerFactsSlim()` |
| `src/lib/facts/portfolio.ts` (new, server) | `buildPortfolioFacts()` (pure), `getPortfolioFacts()` |
| `src/test/fakeFirestore.ts` (new) | path-based in-memory Firestore fake for tests |
| `src/lib/finavaInputs.ts` | `extractDcfBase()`, `finishDcfInputs()`; `computeDcfBundle` uses them; `assembleScoreInputs` accepts precomputed DCF + P/E |
| `src/lib/factorRank.ts` (new) replaces `src/lib/compositeScore.ts` | rank-only helper |
| `src/app/api/facts/[ticker]/route.ts`, `src/app/api/facts/route.ts` (new) | transport |
| `src/app/api/stock/[ticker]/score/route.ts`, `.../dcf/route.ts` | thin readers of facts |
| `src/app/api/stock/[ticker]/finava-analysis/route.ts` | pillars/DCF/street/price from facts |
| `src/lib/quickContext.ts` | formats `getTickerFacts`; exports unchanged |
| `src/hooks/useTickerFacts.ts` (new), `src/hooks/useDcfInputs.ts`, `src/lib/finavaStore.ts` | client reads + revalidation after a run |
| `src/components/stock/IntelligenceRail.tsx`, `StockTabs.tsx`, `FinavaTab.tsx`, `src/app/stock/[ticker]/page.tsx` | stock page on facts |
| `src/components/watchlist/WatchlistSplitRail.tsx`, `src/app/portfolio/page.tsx` (score source only) | list pills |
| `src/components/research/BoardLeaderboard.tsx`, `LadderRow.tsx`, `ScreenMode.tsx`, `VerdictHero.tsx` | board rows |
| `src/lib/facts/consistency.test.ts` (new) | 5-ticker cross-surface identity test |

---

### Task 0: Baseline

- [ ] **Step 1: Confirm a green start**

Run: `npm run typecheck && npm run lint && npm test 2>&1 | tail -5`
Expected: typecheck/lint exit 0, vitest "Tests ... passed". If anything is red on untouched `main`, record it in the PR under "Found, not fixed" and continue.

---

### Task 1: Fact types and constructors

**Files:**
- Create: `src/lib/facts/types.ts`
- Test: `src/lib/facts/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/facts/types.test.ts
import { describe, expect, it } from "vitest";
import { fact, missing, hasValue, toSlim, SCORE_VERSION, type TickerFacts } from "./types";

describe("fact / missing", () => {
  it("keeps a real value with its source and as-of", () => {
    const f = fact(182.5, { source: "Finnhub quote", asOf: "2026-09-15T20:00:00.000Z", unit: "USD" });
    expect(f).toEqual({ value: 182.5, source: "Finnhub quote", asOf: "2026-09-15T20:00:00.000Z", unit: "USD" });
    expect(hasValue(f)).toBe(true);
  });

  it("turns null, NaN and Infinity into a missing fact with a note", () => {
    for (const v of [null, NaN, Infinity]) {
      const f = fact(v as number | null, { source: "Finnhub quote", asOf: "2026-09-15" });
      expect(f.value).toBeNull();
      expect(f.source).toBe("Finnhub quote");
      expect(f.asOf).toBe("2026-09-15");
      expect(f.note).toBeTruthy();
      expect(hasValue(f)).toBe(false);
    }
  });

  it("uses the caller's note when a value is missing", () => {
    const f = fact(null, { source: "SEC EDGAR", asOf: "2026-09-15", note: "No SEC filings" });
    expect(f.note).toBe("No SEC filings");
  });

  it("applies missingNote only to a missing value", () => {
    const meta = { source: "Finnhub basic financials", asOf: "2026-09-15", missingNote: "Not reported by the source" };
    expect(fact(null, meta).note).toBe("Not reported by the source");
    expect(fact(1.2, meta).note).toBeUndefined();
  });

  it("missing() always carries source, as-of and note", () => {
    const f = missing<number>("SEC EDGAR", "No SEC filings", "2026-09-15T00:00:00.000Z");
    expect(f).toEqual({ value: null, source: "SEC EDGAR", asOf: "2026-09-15T00:00:00.000Z", note: "No SEC filings" });
  });

  it("missing() defaults as-of to now", () => {
    const f = missing<number>("x", "y");
    expect(new Date(f.asOf).toString()).not.toBe("Invalid Date");
  });
});

describe("toSlim", () => {
  it("keeps only ticker and the score headline", () => {
    const score = fact(
      { total: 58, grade: "C", pillars: [], confidence: "Moderate" as const, coverage: 0.8, peerPremiumPct: 12, version: SCORE_VERSION },
      { source: "Finava Score v2 (15 factors)", asOf: "2026-09-15T00:00:00.000Z" }
    );
    const slim = toSlim({ ticker: "AAPL", score } as unknown as TickerFacts);
    expect(slim).toEqual({
      ticker: "AAPL",
      score: { value: { total: 58, grade: "C", version: SCORE_VERSION }, source: "Finava Score v2 (15 factors)", asOf: "2026-09-15T00:00:00.000Z" },
    });
  });

  it("passes a missing score through with its note", () => {
    const slim = toSlim({ ticker: "SPY", score: missing("Finava Score v2", "Not scored yet", "2026-09-15") } as unknown as TickerFacts);
    expect(slim.score).toEqual({ value: null, source: "Finava Score v2", asOf: "2026-09-15", note: "Not scored yet" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/facts/types.test.ts`
Expected: FAIL, cannot resolve `./types`.

- [ ] **Step 3: Implement**

```ts
// src/lib/facts/types.ts
// The facts layer's shared vocabulary. Client-safe: type-only imports, no I/O.
//
// Every number Finava displays is a Fact: a value plus where it came from and
// when it was true. A value we could not get is `value: null` with a note that
// says why. There is no other way to build one (see fact / missing).

import type { PillarScore } from "@/lib/finavaScore";
import type { DcfInputs } from "@/lib/dcf";

export interface Fact<T> {
  value: T | null;
  unit?: string;
  source: string;
  asOf: string;
  period?: string;
  note?: string;
}

export interface FactMeta {
  source: string;
  asOf: string;
  unit?: string;
  period?: string;
  /** Kept on the fact whether or not it has a value (e.g. "Mean of 38 analysts"). */
  note?: string;
  /** Used only when the value turns out to be missing. */
  missingNote?: string;
}

/** Bump when the score engine changes: cached docs of another version are misses. */
export const SCORE_VERSION = "finava-score-v2";
/** Bump when the DCF inputs or model change. */
export const DCF_VERSION = "dcf-v1";
/** Perpetual growth used by `computeDcf`'s default. */
export const TERMINAL_GROWTH = 0.025;

function isAbsent(v: unknown): boolean {
  return v == null || (typeof v === "number" && !Number.isFinite(v));
}

/** A fact. A null or non-finite value becomes a missing fact that keeps the source. */
export function fact<T>(value: T | null, meta: FactMeta): Fact<T> {
  if (isAbsent(value)) return missing<T>(meta.source, meta.missingNote ?? meta.note ?? "No value returned by the source", meta.asOf);
  const out: Fact<T> = { value, source: meta.source, asOf: meta.asOf };
  if (meta.unit) out.unit = meta.unit;
  if (meta.period) out.period = meta.period;
  if (meta.note) out.note = meta.note;
  return out;
}

/** The only way to say "we don't have this": the note is required. */
export function missing<T>(source: string, note: string, asOf: string = new Date().toISOString()): Fact<T> {
  return { value: null, source, asOf, note };
}

export function hasValue<T>(f: Fact<T> | null | undefined): f is Fact<T> & { value: T } {
  return !!f && f.value != null;
}

export interface ScoreFact {
  total: number;
  grade: string;
  pillars: PillarScore[];
  confidence: "Low" | "Moderate" | "High";
  coverage: number;
  /** Average P/E & P/S premium vs the peer median, in percent. */
  peerPremiumPct: number | null;
  version: string;
}

export interface DcfFact {
  fairValue: number;
  wacc: number;
  growth: number;
  terminal: number;
  inputs: DcfInputs;
  version: string;
}

export type SlimScore = Pick<ScoreFact, "total" | "grade" | "version">;

export interface TickerFacts {
  ticker: string;
  price: Fact<number>;
  change1d: Fact<number>;
  marketCap: Fact<number>;
  sharesOut: Fact<number>;
  pe: Fact<number>;
  evEbitda: Fact<number>;
  epsTTM: Fact<number>;
  range52w: Fact<{ low: number; high: number }>;
  revenueTTM: Fact<number>;
  netIncomeTTM: Fact<number>;
  fcfTTM: Fact<number>;
  cashAndSTI: Fact<number>;
  debt: Fact<number>;
  beta: Fact<number>;
  dividendYield: Fact<number>;
  nextEarnings: Fact<{ date: string; estimated: boolean; epsEst?: number }>;
  streetTarget: Fact<number>;
  score: Fact<ScoreFact>;
  dcf: Fact<DcfFact>;
  /** Sources that failed or missed the deadline this read. */
  dropped: string[];
}

export interface TickerFactsSlim {
  ticker: string;
  score: Fact<SlimScore>;
}

export function toSlim(f: Pick<TickerFacts, "ticker" | "score">): TickerFactsSlim {
  const s = f.score;
  if (!hasValue(s)) return { ticker: f.ticker, score: s as Fact<SlimScore> };
  const { value, ...meta } = s;
  return { ticker: f.ticker, score: { ...meta, value: { total: value.total, grade: value.grade, version: value.version } } };
}

export interface HoldingFact {
  ticker: string;
  shares: number;
  price: Fact<number>;
  marketValue: Fact<number>;
  /** Fraction of totalValue (0.153 = 15.3%). */
  weight: Fact<number>;
  /** Average cost per share. */
  costBasis: Fact<number>;
  score: Fact<SlimScore>;
}

export interface PortfolioFacts {
  holdings: HoldingFact[];
  totalValue: Fact<number>;
  cash: Fact<number>;
  /** Sum of holding weights + cash weight; 1 whenever totalValue > 0. */
  weightsSum: number;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/facts/types.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/facts/types.ts src/lib/facts/types.test.ts
git commit -m "feat(facts): Fact type, constructors and slim projection"
```

---

### Task 2: As-of formatting

**Files:**
- Create: `src/lib/facts/format.ts`
- Test: `src/lib/facts/format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/facts/format.test.ts
import { describe, expect, it } from "vitest";
import { asOfLabel, factTitle } from "./format";
import { fact, missing } from "./types";

const NOW = new Date("2026-09-15T19:00:00.000Z"); // 15:00 ET

describe("asOfLabel", () => {
  it("shows the Eastern time for an instant earlier the same day", () => {
    expect(asOfLabel("2026-09-15T18:32:00.000Z", NOW)).toBe("as of 14:32 ET");
  });
  it("shows the date for an older instant", () => {
    expect(asOfLabel("2026-09-12T20:00:00.000Z", NOW)).toBe("as of Sep 12");
  });
  it("shows the date for a bare YYYY-MM-DD", () => {
    expect(asOfLabel("2026-06-27", NOW)).toBe("as of Jun 27");
  });
  it("says so when the as-of is unreadable", () => {
    expect(asOfLabel("garbage", NOW)).toBe("as of unknown time");
  });
});

describe("factTitle", () => {
  it("joins source and as-of", () => {
    expect(factTitle(fact(1, { source: "Finnhub quote", asOf: "2026-09-15T18:32:00.000Z" }), NOW)).toBe("Finnhub quote · as of 14:32 ET");
  });
  it("adds the note for a missing value", () => {
    expect(factTitle(missing("SEC EDGAR", "No SEC filings", "2026-09-15T18:32:00.000Z"), NOW)).toBe("SEC EDGAR · as of 14:32 ET · No SEC filings");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/facts/format.test.ts`
Expected: FAIL, cannot resolve `./format`.

- [ ] **Step 3: Implement**

```ts
// src/lib/facts/format.ts
// Human as-of strings for facts: small print and hover titles. Client-safe.
import type { Fact } from "./types";

const TZ = "America/New_York";

function easternDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

export function asOfLabel(asOf: string, now: Date = new Date()): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(asOf);
  const d = dateOnly ? new Date(`${asOf}T12:00:00.000Z`) : new Date(asOf);
  if (Number.isNaN(d.getTime())) return "as of unknown time";
  if (!dateOnly && easternDay(d) === easternDay(now)) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = String(parseInt(get("hour"), 10) % 24).padStart(2, "0");
    return `as of ${hour}:${get("minute")} ET`;
  }
  const label = new Intl.DateTimeFormat("en-US", { timeZone: dateOnly ? "UTC" : TZ, month: "short", day: "numeric" }).format(d);
  return `as of ${label}`;
}

export function factTitle<T>(f: Fact<T>, now: Date = new Date()): string {
  const parts = [f.source, asOfLabel(f.asOf, now)];
  if (f.note) parts.push(f.note);
  return parts.join(" · ");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/facts/format.test.ts`
Expected: PASS (6 tests). If the `Sep 12` case renders as `Sept 12` under this ICU, switch to the numeric-month + label-table approach used in `src/lib/portfolioContext.ts` (`MONTHS`) and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/lib/facts/format.ts src/lib/facts/format.test.ts
git commit -m "feat(facts): as-of labels for small print and hover"
```

---

### Task 3: In-process memo with quote/day TTLs

**Files:**
- Create: `src/lib/facts/cache.ts`
- Test: `src/lib/facts/cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/facts/cache.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase-admin", () => ({ db: { collection: vi.fn() } }));

import { memo, isFresh, clearFactsMemo } from "./cache";

// Tue 15 Sep 2026: 14:00 ET is open; 20:00 ET is closed.
const OPEN = new Date("2026-09-15T18:00:00.000Z");
const CLOSED = new Date("2026-09-16T00:00:00.000Z");

beforeEach(() => clearFactsMemo());
afterEach(() => vi.useRealTimers());

describe("isFresh", () => {
  it("quote: fresh for 60 s while open", () => {
    const e = { at: OPEN.getTime(), openAtFetch: true, closeDate: "2026-09-14" };
    expect(isFresh(e, "quote", new Date(OPEN.getTime() + 59_000))).toBe(true);
    expect(isFresh(e, "quote", new Date(OPEN.getTime() + 61_000))).toBe(false);
  });

  it("quote: a closed-market read stays fresh until the next session closes", () => {
    const e = { at: CLOSED.getTime(), openAtFetch: false, closeDate: "2026-09-15" };
    expect(isFresh(e, "quote", new Date(CLOSED.getTime() + 8 * 3600_000))).toBe(true); // 04:00 ET next day
    expect(isFresh(e, "quote", new Date("2026-09-16T14:00:00.000Z"))).toBe(false); // 10:00 ET, open again
  });

  it("day: fresh for 24 h", () => {
    const e = { at: OPEN.getTime(), openAtFetch: true, closeDate: "2026-09-14" };
    expect(isFresh(e, "day", new Date(OPEN.getTime() + 86_399_000))).toBe(true);
    expect(isFresh(e, "day", new Date(OPEN.getTime() + 86_401_000))).toBe(false);
  });

  it("maxAgeSec can only make a read stricter", () => {
    const e = { at: OPEN.getTime(), openAtFetch: true, closeDate: "2026-09-14" };
    expect(isFresh(e, "day", new Date(OPEN.getTime() + 10_000), 5)).toBe(false);
  });
});

describe("memo", () => {
  it("loads once and serves the cached value with its fetch time", async () => {
    const load = vi.fn().mockResolvedValue({ price: 1 });
    const a = await memo("quote:AAPL", "quote", load, { now: () => OPEN });
    const b = await memo("quote:AAPL", "quote", load, { now: () => OPEN });
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ value: { price: 1 }, at: OPEN.getTime() });
    expect(b).toEqual(a);
  });

  it("collapses concurrent cold calls onto one load", async () => {
    let resolve!: (v: number) => void;
    const load = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const p1 = memo("k", "day", load, { now: () => OPEN });
    const p2 = memo("k", "day", load, { now: () => OPEN });
    resolve(7);
    expect((await p1).value).toBe(7);
    expect((await p2).value).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce(3);
    await expect(memo("k2", "day", load, { now: () => OPEN })).rejects.toThrow("429");
    expect((await memo("k2", "day", load, { now: () => OPEN })).value).toBe(3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("never caches null", async () => {
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(4);
    expect((await memo("k3", "day", load, { now: () => OPEN })).value).toBeNull();
    expect((await memo("k3", "day", load, { now: () => OPEN })).value).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/facts/cache.test.ts`
Expected: FAIL, cannot resolve `./cache`.

- [ ] **Step 3: Implement**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/facts/cache.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/facts/cache.ts src/lib/facts/cache.test.ts
git commit -m "feat(facts): in-process memo with market-aware quote TTL"
```

---

### Task 4: Firestore tier for score + DCF

**Files:**
- Create: `src/test/fakeFirestore.ts`
- Modify: `src/lib/facts/cache.ts` (append)
- Test: `src/lib/facts/cache.derived.test.ts`

- [ ] **Step 1: Write the fake**

```ts
// src/test/fakeFirestore.ts
// Minimal path-based Firestore fake for tests: collection/doc chains, get/set
// (with merge), collection get() over direct children, orderBy (no-op sort by id).
type Data = Record<string, unknown>;

export function createFakeFirestore() {
  const docs = new Map<string, Data>();

  function docRef(path: string) {
    return {
      id: path.split("/").at(-1)!,
      path,
      async get() {
        const d = docs.get(path);
        return { id: path.split("/").at(-1)!, exists: d !== undefined, data: () => (d ? structuredClone(d) : undefined) };
      },
      async set(data: Data, opts?: { merge?: boolean }) {
        const prev = opts?.merge ? docs.get(path) ?? {} : {};
        docs.set(path, structuredClone({ ...prev, ...data }));
      },
      collection: (name: string) => collectionRef(`${path}/${name}`),
    };
  }

  function collectionRef(path: string) {
    const depth = path.split("/").length + 1;
    const ref = {
      doc: (id: string) => docRef(`${path}/${id}`),
      orderBy: () => ref,
      async get() {
        const matches = [...docs.keys()]
          .filter((k) => k.startsWith(`${path}/`) && k.split("/").length === depth)
          .sort()
          .map((k) => ({ id: k.split("/").at(-1)!, ref: docRef(k), data: () => structuredClone(docs.get(k)!) }));
        return { docs: matches, empty: matches.length === 0 };
      },
    };
    return ref;
  }

  return { db: { collection: (name: string) => collectionRef(name) }, docs };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/facts/cache.derived.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFirestore } from "@/test/fakeFirestore";

const fs = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeFirestore> | null }));
vi.mock("@/lib/firebase-admin", () => ({
  get db() {
    return fs.current!.db;
  },
}));

import { readDerived, writeDerived, clearFactsMemo } from "./cache";
import { fact, missing, SCORE_VERSION, DCF_VERSION, type ScoreFact, type DcfFact } from "./types";

const NOW = new Date("2026-09-15T18:00:00.000Z");
const score = fact<ScoreFact>(
  { total: 58, grade: "C", pillars: [], confidence: "Moderate", coverage: 0.8, peerPremiumPct: null, version: SCORE_VERSION },
  { source: "Finava Score v2 (15 factors)", asOf: NOW.toISOString() }
);
const dcf = fact<DcfFact>(
  {
    fairValue: 171.2, wacc: 0.1, growth: 0.08, terminal: 0.025, version: DCF_VERSION,
    inputs: { baseFcf: 1, fcfIsProxy: false, sharesOutstanding: 1, netDebt: 0, historicalGrowth: 0.08, suggestedWacc: 0.1, currentPrice: 200, currency: "USD" },
  },
  { source: "Finava DCF on SEC EDGAR filings", asOf: NOW.toISOString(), unit: "USD" }
);

beforeEach(() => {
  fs.current = createFakeFirestore();
  clearFactsMemo();
});

describe("derived tier", () => {
  it("round-trips score and dcf through factsCache/{TICKER}", async () => {
    await writeDerived("aapl", { score, dcf }, NOW);
    expect(fs.current!.docs.has("factsCache/AAPL")).toBe(true);
    clearFactsMemo(); // force a Firestore read, not the in-process mirror
    const got = await readDerived("AAPL", { now: () => NOW });
    expect(got.score).toEqual(score);
    expect(got.dcf).toEqual(dcf);
  });

  it("does not write missing facts", async () => {
    await writeDerived("SPY", { score: missing("Finava Score v2", "No factor data"), dcf: missing("SEC EDGAR", "No SEC filings") }, NOW);
    expect(fs.current!.docs.has("factsCache/SPY")).toBe(false);
  });

  it("treats a doc older than 24 h as a miss", async () => {
    await writeDerived("AAPL", { score, dcf }, NOW);
    clearFactsMemo();
    const later = new Date(NOW.getTime() + 86_401_000);
    expect(await readDerived("AAPL", { now: () => later })).toEqual({ score: null, dcf: null });
  });

  it("treats another engine version as a miss", async () => {
    await writeDerived("AAPL", { score: { ...score, value: { ...score.value!, version: "finava-score-v1" } }, dcf }, NOW);
    clearFactsMemo();
    const got = await readDerived("AAPL", { now: () => NOW });
    expect(got.score).toBeNull();
    expect(got.dcf).toEqual(dcf);
  });

  it("reads as a miss when Firestore throws", async () => {
    fs.current = { db: { collection: () => { throw new Error("offline"); } } } as never;
    expect(await readDerived("AAPL", { now: () => NOW })).toEqual({ score: null, dcf: null });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/facts/cache.derived.test.ts`
Expected: FAIL, `readDerived` is not exported.

- [ ] **Step 4: Implement (append to cache.ts)**

```ts
// ── Tier 2: score + DCF in Firestore ──────────────────────────────────────────
import { db } from "@/lib/firebase-admin";
import { hasValue, SCORE_VERSION, DCF_VERSION, type Fact, type ScoreFact, type DcfFact } from "./types";

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
```

Move the two new `import` lines to the top of `cache.ts` with the existing import, and add `derivedMirror().clear()` inside `clearFactsMemo()`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/facts/cache.derived.test.ts src/lib/facts/cache.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
git add src/test/fakeFirestore.ts src/lib/facts/cache.ts src/lib/facts/cache.derived.test.ts
git commit -m "feat(facts): global Firestore tier for score and DCF, versioned"
```

---

### Task 5: One DCF input path in finavaInputs

**Files:**
- Modify: `src/lib/finavaInputs.ts` (replace `computeDcfBundle`, extend `assembleScoreInputs`)
- Test: `src/lib/finavaInputs.dcf.test.ts` (new); update `src/lib/finavaInputs.assemble.test.ts` mocks

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/finavaInputs.dcf.test.ts
// The single DCF input path, on real (trimmed) SEC filings.
import { describe, expect, it } from "vitest";
import aapl from "@/lib/__fixtures__/sec/aapl.json";
import jpm from "@/lib/__fixtures__/sec/jpm.json";
import { extractDcfBase, finishDcfInputs } from "@/lib/finavaInputs";
import { extractFinancialMetrics, extractCurrentSharesOutstanding } from "@/lib/edgar";
import { suggestedWaccFromBeta } from "@/lib/dcf";

describe("extractDcfBase", () => {
  it("builds FCF from operating cash flow minus capex, and flags no proxy", () => {
    const mm = extractFinancialMetrics(aapl);
    const base = extractDcfBase(aapl);
    expect(base.baseFcf).toBe((mm.operatingCashFlow as number) - (mm.capex as number));
    expect(base.fcfIsProxy).toBe(false);
  });

  it("uses the cover-page share count (split-safe), with its date", () => {
    const cur = extractCurrentSharesOutstanding(aapl)!;
    const base = extractDcfBase(aapl);
    expect(base.sharesEdgar).toBe(cur.shares);
    expect(base.sharesAsOf).toBe(cur.asOf);
  });

  it("computes net debt from debt and cash, treating a missing side as zero", () => {
    const mm = extractFinancialMetrics(aapl);
    expect(extractDcfBase(aapl).netDebt).toBe(((mm.totalDebt as number) ?? 0) - ((mm.cash as number) ?? 0));
  });

  it("returns an all-null base for no filings", () => {
    expect(extractDcfBase(null)).toEqual({
      baseFcf: null, fcfIsProxy: true, sharesEdgar: null, sharesAsOf: null, netDebt: 0,
      historicalGrowth: null, fcfConversion: null, revenueCagr3y: null,
    });
  });

  it("does not throw on a bank's filings", () => {
    expect(() => extractDcfBase(jpm)).not.toThrow();
  });
});

describe("finishDcfInputs", () => {
  const base = {
    baseFcf: 100e9, fcfIsProxy: false, sharesEdgar: 15e9, sharesAsOf: "2026-07-18", netDebt: -30e9,
    historicalGrowth: 0.06, fcfConversion: 1.02, revenueCagr3y: 0.04,
  };

  it("uses the beta-tuned WACC, never a flat default", () => {
    const i = finishDcfInputs(base, { price: 230, beta: 1.3, marketCapMillions: null, currency: "USD" });
    expect(i.suggestedWacc).toBe(suggestedWaccFromBeta(1.3));
    expect(i.sharesOutstanding).toBe(15e9);
    expect(i.currentPrice).toBe(230);
  });

  it("falls back to market cap ÷ price for shares only when filings have none", () => {
    const i = finishDcfInputs({ ...base, sharesEdgar: null }, { price: 200, beta: null, marketCapMillions: 3_000_000, currency: null });
    expect(i.sharesOutstanding).toBe(15e9);
    expect(i.currency).toBe("USD");
  });

  it("leaves shares null when neither source has them", () => {
    const i = finishDcfInputs({ ...base, sharesEdgar: null }, { price: null, beta: null, marketCapMillions: 3_000_000, currency: "USD" });
    expect(i.sharesOutstanding).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/finavaInputs.dcf.test.ts`
Expected: FAIL, `extractDcfBase` is not exported. (If JSON import is rejected, check `resolveJsonModule` in tsconfig; `edgar.fixtures.test.ts` shows the working import form, copy it.)

- [ ] **Step 3: Implement**

In `src/lib/finavaInputs.ts`:

1. Change the edgar import to:
```ts
import { getCikByTicker, getCompanyFacts, extractFinancialMetrics, extractFundamentalTimeSeries, extractCurrentSharesOutstanding } from "@/lib/edgar";
```
2. Replace the whole `computeDcfBundle` function (and its doc comment) with:

```ts
/** Filing-derived DCF ingredients. Pure; cached by the facts layer per ticker. */
export interface DcfBase {
  baseFcf: number | null;
  fcfIsProxy: boolean;
  sharesEdgar: number | null;
  sharesAsOf: string | null;
  netDebt: number;
  historicalGrowth: number | null;
  fcfConversion: number | null;
  revenueCagr3y: number | null;
}

const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Everything the DCF needs from SEC companyfacts. `null` facts → an all-null base. */
export function extractDcfBase(companyFacts: unknown): DcfBase {
  if (!companyFacts) {
    return { baseFcf: null, fcfIsProxy: true, sharesEdgar: null, sharesAsOf: null, netDebt: 0, historicalGrowth: null, fcfConversion: null, revenueCagr3y: null };
  }
  const mm = extractFinancialMetrics(companyFacts);
  const series = extractFundamentalTimeSeries(companyFacts, 6);
  const ocf = numOrNull(mm.operatingCashFlow);
  const capex = numOrNull(mm.capex);
  const baseFcf = ocf != null ? (capex != null ? ocf - capex : ocf) : null;
  const netIncome = numOrNull(mm.netIncome);
  const rev = series.revenue;
  const historicalGrowth = rev.length >= 2 && rev[0].value > 0 && rev.at(-1)!.value > 0
    ? Math.pow(rev.at(-1)!.value / rev[0].value, 1 / (rev.length - 1)) - 1 : null;
  const revenueCagr3y = rev.length >= 4 && rev.at(-4)!.value > 0 && rev.at(-1)!.value > 0
    ? Math.pow(rev.at(-1)!.value / rev.at(-4)!.value, 1 / 3) - 1 : null;
  // Cover-page count, not the annual weighted average: the latter is pre-split
  // until the next 10-K (see extractCurrentSharesOutstanding).
  const cur = extractCurrentSharesOutstanding(companyFacts);
  return {
    baseFcf,
    fcfIsProxy: capex == null,
    sharesEdgar: cur?.shares ?? numOrNull(mm.sharesOutstanding),
    sharesAsOf: cur?.asOf ?? null,
    netDebt: (numOrNull(mm.totalDebt) ?? 0) - (numOrNull(mm.cash) ?? 0),
    historicalGrowth,
    fcfConversion: baseFcf != null && netIncome != null && netIncome > 0 ? baseFcf / netIncome : null,
    revenueCagr3y,
  };
}

/** The one place DCF inputs are finished: beta-tuned WACC, shares with a mcap÷price fallback. */
export function finishDcfInputs(
  base: DcfBase,
  market: { price: number | null; beta: number | null; marketCapMillions: number | null; currency: string | null }
): DcfInputs {
  let shares = base.sharesEdgar;
  if ((shares == null || shares <= 0) && market.marketCapMillions != null && market.price != null && market.price > 0) {
    shares = (market.marketCapMillions * 1e6) / market.price;
  }
  return {
    baseFcf: base.baseFcf,
    fcfIsProxy: base.fcfIsProxy,
    sharesOutstanding: shares != null && shares > 0 ? shares : null,
    netDebt: base.netDebt,
    historicalGrowth: base.historicalGrowth,
    suggestedWacc: suggestedWaccFromBeta(market.beta),
    currentPrice: market.price,
    currency: market.currency ?? "USD",
  };
}

/** DCF bundle for callers outside the facts layer. Same path as facts.dcf. */
async function computeDcfBundle(
  symbol: string,
  price: number | null
): Promise<{ dcfFair: number | null; fcfConversion: number | null; revenueCagr3y: number | null }> {
  const cik = await getCikByTicker(symbol);
  if (!cik) return { dcfFair: null, fcfConversion: null, revenueCagr3y: null };
  const [facts, metricRaw] = await Promise.all([
    getCompanyFacts(cik),
    getBasicFinancials(symbol).catch(() => null),
  ]);
  const m = (metricRaw as { metric?: Metric } | null)?.metric ?? {};
  const base = extractDcfBase(facts);
  const inputs = finishDcfInputs(base, { price, beta: n(m.beta), marketCapMillions: n(m.marketCapitalization), currency: "USD" });
  return { dcfFair: defaultFairValue(inputs), fcfConversion: base.fcfConversion, revenueCagr3y: base.revenueCagr3y };
}
```

3. Extend `assembleScoreInputs` with a sixth parameter and use it:

```ts
export interface PrecomputedScoreParts {
  /** Canonical DCF parts from the facts layer; skips the internal DCF fetch. */
  dcf?: { dcfFair: number | null; fcfConversion: number | null; revenueCagr3y: number | null };
  /** Canonical P/E (price ÷ EPS TTM). `undefined` keeps Finnhub's peTTM. */
  peTTM?: number | null;
}
```
Signature becomes `(symbol, price, insiderTrades, newsSentiment, companyName?: string, pre: PrecomputedScoreParts = {})`. In the `Promise.all`, replace the `computeDcfBundle(...)` entry with:
```ts
    pre.dcf
      ? Promise.resolve(pre.dcf)
      : computeDcfBundle(symbol, price).catch(() => ({ dcfFair: null, fcfConversion: null, revenueCagr3y: null })),
```
After `Object.assign(base, metricsToFundamentalInputs(m));` add:
```ts
  // One P/E everywhere: the facts layer's price ÷ EPS. peerPe stays on Finnhub's
  // basis, so the peer ratio mixes bases by a fraction of a percent (accepted).
  if (pre.peTTM !== undefined) base.peTTM = pre.peTTM;
```

4. In `src/lib/finavaInputs.assemble.test.ts`, add `extractCurrentSharesOutstanding: vi.fn(() => null)` to `deps` and to the `@/lib/edgar` mock. Add two tests at the end of its main `describe`:

```ts
  it("uses precomputed DCF parts and skips the filing fetch", async () => {
    const out = await assembleScoreInputs("AAPL", 200, null, null, "Apple", {
      dcf: { dcfFair: 171, fcfConversion: 0.9, revenueCagr3y: 0.05 },
    });
    expect(out.dcfFair).toBe(171);
    expect(out.fcfConversion).toBe(0.9);
    expect(out.revenueCagr3y).toBe(0.05);
    expect(deps.getCikByTicker).not.toHaveBeenCalled();
  });

  it("overrides peTTM with the canonical P/E when given, including null", async () => {
    expect((await assembleScoreInputs("AAPL", 200, null, null, "Apple", { peTTM: 33.1 })).peTTM).toBe(33.1);
    expect((await assembleScoreInputs("AAPL", 200, null, null, "Apple", { peTTM: null })).peTTM).toBeNull();
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/finavaInputs.dcf.test.ts src/lib/finavaInputs.assemble.test.ts src/lib/finavaInputs.test.ts`
Expected: PASS. If an existing assemble test asserted the old flat-WACC call (`suggestedWaccFromBeta` called with `null`), update it to expect the metric's beta: that is the bug this task fixes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/finavaInputs.ts src/lib/finavaInputs.dcf.test.ts src/lib/finavaInputs.assemble.test.ts
git commit -m "fix(dcf): one input path with beta-tuned WACC and split-safe shares"
```

---

### Task 6: Shared pillar → signal mapping

**Files:**
- Create: `src/lib/facts/signals.ts`
- Test: `src/lib/facts/signals.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/facts/signals.test.ts
import { describe, expect, it } from "vitest";
import { pillarToSignal, pillarsToSignals, peerPremiumPct } from "./signals";
import type { PillarScore } from "@/lib/finavaScore";

const pillar = (over: Partial<PillarScore> = {}): PillarScore => ({
  key: "valuation", label: "Valuation", weight: 22, score: 71.6,
  factors: [
    { key: "relativeVal", label: "Relative valuation", pillar: "valuation", weight: 0.7, score: 80, detail: "P/E 30.0 vs peers 26.0" },
    { key: "absoluteVal", label: "Absolute (DCF)", pillar: "valuation", weight: 0.3, score: null, detail: "No DCF" },
  ],
  ...over,
});

describe("pillarToSignal", () => {
  it("rounds the score and headlines the most extreme present factor", () => {
    const s = pillarToSignal(pillar());
    expect(s.score).toBe(72);
    expect(s.isNoData).toBe(false);
    expect(s.headline).toBe("Strong relative valuation");
    expect(s.detail).toBe("P/E 30.0 vs peers 26.0");
    expect(s.factors).toHaveLength(2);
  });

  it("marks a pillar with no data instead of scoring it 50 silently", () => {
    const s = pillarToSignal(pillar({ score: null, factors: [] }));
    expect(s.isNoData).toBe(true);
    expect(s.headline).toBe("No data yet");
  });
});

describe("pillarsToSignals", () => {
  it("returns signals in the canonical display order", () => {
    const keys = ["insider", "fundamentals", "valuation"] as const;
    const out = pillarsToSignals(keys.map((k) => pillar({ key: k, label: k })));
    expect(out.map((s) => s.key)).toEqual(["fundamentals", "valuation", "insider"]);
  });
});

describe("peerPremiumPct", () => {
  it("averages P/E and P/S premiums in percent", () => {
    expect(peerPremiumPct({ peTTM: 30, peerPe: 25, psTTM: 6, peerPs: 5 })).toBeCloseTo(20);
  });
  it("ignores a non-positive multiple and is null with nothing usable", () => {
    expect(peerPremiumPct({ peTTM: -4, peerPe: 25, psTTM: 6, peerPs: 5 })).toBeCloseTo(20);
    expect(peerPremiumPct({ peTTM: null, peerPe: null, psTTM: null, peerPs: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/facts/signals.test.ts`
Expected: FAIL, cannot resolve `./signals`.

- [ ] **Step 3: Implement**

```ts
// src/lib/facts/signals.ts
// Pillar → FinavaSignal, shared by the finava-analysis stream and the Finava
// tab's facts read so both render the same bars. Client-safe.
import type { PillarScore } from "@/lib/finavaScore";
import type { ScoreInputs } from "@/lib/finavaScore";
import { stanceFromScore, SIGNAL_ORDER, type FinavaSignal, type SignalKey } from "@/lib/finava";

function topFactorHeadline(p: PillarScore): string {
  const present = p.factors.filter((f) => f.score != null);
  if (present.length === 0) return "Limited data";
  const top = present.reduce((a, b) => (Math.abs(b.score! - 50) > Math.abs(a.score! - 50) ? b : a));
  const dir = top.score! >= 60 ? "Strong" : top.score! <= 40 ? "Weak" : "Mixed";
  return `${dir} ${top.label.toLowerCase()}`;
}

export function pillarToSignal(p: PillarScore): FinavaSignal {
  const score = p.score == null ? 50 : Math.round(p.score);
  const present = p.factors.filter((f) => f.score != null);
  return {
    key: p.key as SignalKey,
    label: p.label,
    score,
    isNoData: p.score == null,
    stance: stanceFromScore(score),
    headline: p.score == null ? "No data yet" : topFactorHeadline(p),
    detail: present.map((f) => f.detail).slice(0, 2).join(" · ") || "Insufficient data for a confident signal.",
    factors: p.factors.map((f) => ({ key: f.key, label: f.label, score: f.score, detail: f.detail })),
  };
}

export function pillarsToSignals(pillars: PillarScore[]): FinavaSignal[] {
  const byKey = new Map(pillars.map((p) => [p.key as string, p]));
  return SIGNAL_ORDER.flatMap((k) => {
    const p = byKey.get(k);
    return p ? [pillarToSignal(p)] : [];
  });
}

/** Average premium of P/E and P/S over the peer median, in percent. */
export function peerPremiumPct(i: Pick<ScoreInputs, "peTTM" | "peerPe" | "psTTM" | "peerPs">): number | null {
  const pe = i.peTTM != null && i.peTTM > 0 && i.peerPe != null && i.peerPe > 0 ? i.peTTM / i.peerPe - 1 : null;
  const ps = i.psTTM != null && i.psTTM > 0 && i.peerPs != null && i.peerPs > 0 ? i.psTTM / i.peerPs - 1 : null;
  const xs = [pe, ps].filter((x): x is number => x != null);
  return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 : null;
}
```

Check `src/lib/finava.ts` has no server-only imports (it shouldn't; it's already imported by client components).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/facts/signals.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/facts/signals.ts src/lib/facts/signals.test.ts
git commit -m "feat(facts): shared pillar-to-signal mapping and peer premium"
```

---

### Task 7: Fast facts from raw sources (pure)

**Files:**
- Create: `src/lib/facts/fast.ts`
- Test: `src/lib/facts/fast.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/facts/fast.test.ts
import { describe, expect, it } from "vitest";
import aapl from "@/lib/__fixtures__/sec/aapl.json";
import { buildFastFacts, snapshotEdgar, quoteFacts, SRC, type FastSources } from "./fast";

const AT = Date.parse("2026-09-15T18:00:00.000Z");
const QUOTE = {
  ticker: "AAPL", price: 230, change: 2.3, changePct: 1.01, volume: 0, high: 231, low: 227, open: 228, prevClose: 227.7,
  asOf: "2026-09-15T17:59:30.000Z", asOfSource: "exchange" as const,
};
const METRIC = {
  epsTTM: 7.5, "52WeekLow": 170, "52WeekHigh": 260, beta: 1.2, dividendYieldIndicatedAnnual: 0.45,
  marketCapitalization: 3_400_000, shareOutstanding: 14_900, ebitdPerShareTTM: 11,
};
const EARN = { date: "2026-10-28", quarter: 4, year: 2026, epsEstimate: 2.02, epsActual: null, status: "upcoming" as const, estimated: true };

function sources(over: Partial<FastSources> = {}): FastSources {
  return {
    quote: { value: QUOTE, at: AT },
    metric: { value: METRIC, at: AT },
    edgar: { value: snapshotEdgar(aapl), at: AT },
    earnings: { value: EARN, at: AT },
    target: { value: { targetMean: 250, numberOfAnalysts: 38 }, at: AT },
    errors: {},
    ...over,
  };
}

const FIELDS = [
  "price", "change1d", "marketCap", "sharesOut", "pe", "evEbitda", "epsTTM", "range52w", "revenueTTM",
  "netIncomeTTM", "fcfTTM", "cashAndSTI", "debt", "beta", "dividendYield", "nextEarnings", "streetTarget",
] as const;

describe("buildFastFacts", () => {
  it("gives every field a source and an as-of, and a note whenever the value is null", () => {
    const f = buildFastFacts("AAPL", sources());
    for (const k of FIELDS) {
      expect(f[k].source, k).toBeTruthy();
      expect(new Date(f[k].asOf.length === 10 ? `${f[k].asOf}T00:00:00Z` : f[k].asOf).toString(), k).not.toBe("Invalid Date");
      if (f[k].value == null) expect(f[k].note, k).toBeTruthy();
    }
  });

  it("derives P/E, market cap and EV/EBITDA in code", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(f.pe.value).toBeCloseTo(230 / 7.5);
    expect(f.pe.source).toBe(SRC.pe);
    expect(f.marketCap.value).toBeCloseTo(230 * f.sharesOut.value!);
    expect(f.marketCap.source).toBe(SRC.marketCap);
    const ev = f.marketCap.value! + f.debt.value! - f.cashAndSTI.value!;
    expect(f.evEbitda.value).toBeCloseTo(ev / (11 * f.sharesOut.value!));
  });

  it("uses filings for TTM figures with the covered period", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(f.revenueTTM.value).toBeGreaterThan(0);
    expect(f.revenueTTM.period).toMatch(/^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    expect(f.sharesOut.source).toBe(SRC.edgarShares);
  });

  it("refuses a P/E for a loss-maker", () => {
    const f = buildFastFacts("X", sources({ metric: { value: { ...METRIC, epsTTM: -1.2 }, at: AT } }));
    expect(f.pe.value).toBeNull();
    expect(f.pe.note).toMatch(/loss/i);
  });

  it("a failed quote nulls price, change and P/E only; market cap falls back to Finnhub", () => {
    const f = buildFastFacts("AAPL", sources({ quote: null, errors: { quote: "error" } }));
    expect(f.price.value).toBeNull();
    expect(f.price.note).toBe("Source unavailable right now");
    expect(f.change1d.value).toBeNull();
    expect(f.pe.value).toBeNull();
    expect(f.marketCap.value).toBe(3_400_000 * 1e6);
    expect(f.marketCap.source).toBe(SRC.metric);
    expect(f.revenueTTM.value).not.toBeNull();
  });

  it("a timed-out filings read says so on every filing field", () => {
    const f = buildFastFacts("AAPL", sources({ edgar: null, errors: { edgar: "timeout" } }));
    for (const k of ["revenueTTM", "netIncomeTTM", "fcfTTM", "cashAndSTI", "debt"] as const) {
      expect(f[k].value, k).toBeNull();
      expect(f[k].note, k).toBe("Not retrieved in time");
    }
    expect(f.sharesOut.source).toBe(SRC.metric); // Finnhub fallback
  });

  it("a symbol with no SEC filings says so", () => {
    const f = buildFastFacts("SPY", sources({ edgar: { value: snapshotEdgar(null), at: AT } }));
    expect(f.revenueTTM.note).toBe("No SEC filings for this symbol");
  });

  it("never puts a missing-value note on a real value", () => {
    const f = buildFastFacts("AAPL", sources());
    for (const k of ["epsTTM", "beta", "range52w", "debt", "cashAndSTI"] as const) {
      if (f[k].value != null) expect(f[k].note, k).toBeUndefined();
    }
  });

  it("carries the next earnings date and whether it is estimated", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(f.nextEarnings.value).toEqual({ date: "2026-10-28", estimated: true, epsEst: 2.02 });
  });

  it("notes the analyst count on the Street target", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(f.streetTarget.value).toBe(250);
    expect(f.streetTarget.note).toBe("Mean of 38 analysts");
  });
});

describe("quoteFacts", () => {
  it("is exactly what buildFastFacts uses for price and change", () => {
    const f = buildFastFacts("AAPL", sources());
    expect(quoteFacts({ value: QUOTE, at: AT }, {})).toEqual({ price: f.price, change1d: f.change1d });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/facts/fast.test.ts`
Expected: FAIL, cannot resolve `./fast`.

- [ ] **Step 3: Implement**

```ts
// src/lib/facts/fast.ts
// Raw source payloads → the non-derived facts. Pure: no I/O, so every rule about
// sources, as-of and missing-value notes is tested here without mocks.
import type { TickerSnapshot } from "@/lib/finnhub";
import {
  extractBalanceSnapshot, extractQuarterlyFundamentals, ttmFromQuarters,
  extractCurrentSharesOutstanding, type BalanceSnapshot, type TtmTotal,
} from "@/lib/edgar";
import type { NextEarnings } from "@/agents/sub-agents/earnings-agent";
import { extractDcfBase, type DcfBase } from "@/lib/finavaInputs";
import { fact, missing, type Fact, type TickerFacts } from "./types";

export type SourceName = "quote" | "metric" | "edgar" | "earnings" | "target" | "derived";
export type SourceError = "timeout" | "error";
export type Loaded<T> = { value: T; at: number } | null;

export const SRC = {
  quote: "Finnhub quote",
  metric: "Finnhub basic financials",
  edgarTtm: "SEC EDGAR (last four quarters)",
  edgarBalance: "SEC EDGAR balance sheet",
  edgarShares: "SEC EDGAR cover page",
  earnings: "Finnhub earnings calendar",
  target: "Finnhub price target",
  pe: "Computed: price ÷ EPS (TTM)",
  marketCap: "Computed: price × shares outstanding",
  evEbitda: "Computed: enterprise value ÷ EBITDA (TTM)",
  fcf: "Computed: operating cash flow − capex (TTM)",
  score: "Finava Score v2 (15 factors)",
  dcf: "Finava DCF on SEC EDGAR filings",
} as const;

export interface EdgarSnapshot {
  hasFilings: boolean;
  balance: BalanceSnapshot | null;
  revenueTTM: TtmTotal | null;
  netIncomeTTM: TtmTotal | null;
  ocfTTM: TtmTotal | null;
  capexTTM: TtmTotal | null;
  shares: { shares: number; asOf: string } | null;
  dcfBase: DcfBase | null;
}

/** Small, cacheable extract of a companyfacts payload (never cache the multi-MB JSON). */
export function snapshotEdgar(companyFacts: unknown): EdgarSnapshot {
  if (!companyFacts) {
    return { hasFilings: false, balance: null, revenueTTM: null, netIncomeTTM: null, ocfTTM: null, capexTTM: null, shares: null, dcfBase: null };
  }
  const q = extractQuarterlyFundamentals(companyFacts, 8);
  return {
    hasFilings: true,
    balance: extractBalanceSnapshot(companyFacts),
    revenueTTM: ttmFromQuarters(q.revenue),
    netIncomeTTM: ttmFromQuarters(q.netIncome),
    ocfTTM: ttmFromQuarters(q.operatingCashFlow),
    capexTTM: ttmFromQuarters(q.capex),
    shares: extractCurrentSharesOutstanding(companyFacts),
    dcfBase: extractDcfBase(companyFacts),
  };
}

export interface FastSources {
  quote: Loaded<TickerSnapshot>;
  metric: Loaded<Record<string, unknown>>;
  edgar: Loaded<EdgarSnapshot>;
  earnings: Loaded<NextEarnings | null>;
  target: Loaded<{ targetMean?: number | null; numberOfAnalysts?: number | null }>;
  errors: Partial<Record<SourceName, SourceError>>;
}

export type FastFacts = Omit<TickerFacts, "ticker" | "score" | "dcf" | "dropped">;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (ms: number) => new Date(ms).toISOString();

/** Why a source-backed value is absent, in user-facing words. */
export function absentNote(err: SourceError | undefined, fallback: string): string {
  if (err === "timeout") return "Not retrieved in time";
  if (err === "error") return "Source unavailable right now";
  return fallback;
}

export function quoteFacts(q: Loaded<TickerSnapshot>, errors: FastSources["errors"]): Pick<FastFacts, "price" | "change1d"> {
  if (!q) {
    const note = absentNote(errors.quote, "No quote returned");
    const asOf = new Date().toISOString();
    return { price: missing(SRC.quote, note, asOf), change1d: missing(SRC.quote, note, asOf) };
  }
  return {
    price: fact(num(q.value.price), { source: SRC.quote, asOf: q.value.asOf, unit: "USD" }),
    change1d: fact(num(q.value.changePct), { source: SRC.quote, asOf: q.value.asOf, unit: "%" }),
  };
}

export function buildFastFacts(_ticker: string, s: FastSources): FastFacts {
  const now = new Date().toISOString();
  const { price, change1d } = quoteFacts(s.quote, s.errors);

  // ── Finnhub basic financials ──
  const m = s.metric?.value ?? null;
  const mAsOf = s.metric ? iso(s.metric.at) : now;
  const mNote = absentNote(s.errors.metric, "Not reported by the source");
  const fromMetric = (v: number | null, unit?: string, period?: string): Fact<number> =>
    m ? fact(v, { source: SRC.metric, asOf: mAsOf, unit, period, missingNote: "Not reported by the source" }) : missing(SRC.metric, mNote, mAsOf);
  const epsTTM = fromMetric(m ? num(m.epsTTM) ?? num(m.epsBasicExclExtraItemsTTM) : null, "USD", "TTM");
  const beta = fromMetric(m ? num(m.beta) : null);
  const dividendYield = fromMetric(m ? num(m.dividendYieldIndicatedAnnual) ?? num(m.currentDividendYieldTTM) : null, "%");
  const lo = m ? num(m["52WeekLow"]) : null;
  const hi = m ? num(m["52WeekHigh"]) : null;
  const range52w: Fact<{ low: number; high: number }> = m
    ? fact(lo != null && hi != null ? { low: lo, high: hi } : null, { source: SRC.metric, asOf: mAsOf, unit: "USD", missingNote: "Not reported by the source" })
    : missing(SRC.metric, mNote, mAsOf);

  // ── SEC EDGAR ──
  const e = s.edgar?.value ?? null;
  const eFetched = s.edgar ? iso(s.edgar.at) : now;
  const eNote = !s.edgar ? absentNote(s.errors.edgar, "Filings unavailable") : !e?.hasFilings ? "No SEC filings for this symbol" : null;
  const ttm = (t: TtmTotal | null | undefined, why: string): Fact<number> =>
    eNote ? missing(SRC.edgarTtm, eNote, eFetched)
      : t ? fact(t.value, { source: SRC.edgarTtm, asOf: t.to, unit: "USD", period: `${t.from} to ${t.to}` })
      : missing(SRC.edgarTtm, why, eFetched);
  const revenueTTM = ttm(e?.revenueTTM, "Last four quarters not consecutive in filings");
  const netIncomeTTM = ttm(e?.netIncomeTTM, "Last four quarters not consecutive in filings");
  let fcfTTM: Fact<number>;
  if (eNote) fcfTTM = missing(SRC.fcf, eNote, eFetched);
  else if (!e?.ocfTTM) fcfTTM = missing(SRC.fcf, "Operating cash flow not available for the last four quarters", eFetched);
  else if (!e.capexTTM) fcfTTM = missing(SRC.fcf, "Capital expenditure not tagged in filings", eFetched);
  else fcfTTM = fact(e.ocfTTM.value - e.capexTTM.value, { source: SRC.fcf, asOf: e.ocfTTM.to, unit: "USD", period: `${e.ocfTTM.from} to ${e.ocfTTM.to}` });
  const bal = (v: number | null | undefined): Fact<number> =>
    eNote ? missing(SRC.edgarBalance, eNote, eFetched)
      : fact(v ?? null, { source: SRC.edgarBalance, asOf: e?.balance?.asOf ?? eFetched, unit: "USD", missingNote: "Not tagged on the latest balance sheet" });
  const cashAndSTI = bal(e?.balance?.cashAndShortTermInvestments);
  const debt = bal(e?.balance?.totalDebt);

  // ── Shares & market cap: filings first, Finnhub second ──
  const finnhubShares = m && num(m.shareOutstanding) != null ? (m.shareOutstanding as number) * 1e6 : null;
  const sharesOut: Fact<number> = e?.shares
    ? fact(e.shares.shares, { source: SRC.edgarShares, asOf: e.shares.asOf, unit: "shares" })
    : finnhubShares != null
      ? fact(finnhubShares, { source: SRC.metric, asOf: mAsOf, unit: "shares" })
      : missing(SRC.edgarShares, eNote ?? "Share count not reported", eFetched);
  const finnhubCap = m && num(m.marketCapitalization) != null ? (m.marketCapitalization as number) * 1e6 : null;
  const marketCap: Fact<number> = price.value != null && sharesOut.value != null
    ? fact(price.value * sharesOut.value, { source: SRC.marketCap, asOf: price.asOf, unit: "USD" })
    : finnhubCap != null
      ? fact(finnhubCap, { source: SRC.metric, asOf: mAsOf, unit: "USD" })
      : missing(SRC.marketCap, "Needs a price and a share count", now);

  // ── Derived multiples ──
  let pe: Fact<number>;
  if (price.value == null || epsTTM.value == null) pe = missing(SRC.pe, "Needs both a price and EPS (TTM)", price.asOf);
  else if (epsTTM.value <= 0) pe = missing(SRC.pe, "Loss-making over the last twelve months; P/E not meaningful", price.asOf);
  else pe = fact(price.value / epsTTM.value, { source: SRC.pe, asOf: price.asOf, unit: "x", period: "TTM" });

  const ebitdaPerShare = m ? num(m.ebitdPerShareTTM) : null;
  let evEbitda: Fact<number>;
  if (marketCap.value == null || debt.value == null || cashAndSTI.value == null || ebitdaPerShare == null || sharesOut.value == null) {
    evEbitda = missing(SRC.evEbitda, "Needs market cap, debt, cash and EBITDA", now);
  } else if (ebitdaPerShare <= 0) {
    evEbitda = missing(SRC.evEbitda, "EBITDA is negative; EV/EBITDA not meaningful", now);
  } else {
    const ev = marketCap.value + debt.value - cashAndSTI.value;
    evEbitda = fact(ev / (ebitdaPerShare * sharesOut.value), { source: SRC.evEbitda, asOf: marketCap.asOf, unit: "x", period: "TTM" });
  }

  // ── Calendar & Street ──
  const nextEarnings: TickerFacts["nextEarnings"] = !s.earnings
    ? missing(SRC.earnings, absentNote(s.errors.earnings, "No earnings date scheduled"), now)
    : s.earnings.value
      ? fact(
          { date: s.earnings.value.date, estimated: s.earnings.value.estimated, ...(s.earnings.value.epsEstimate != null ? { epsEst: s.earnings.value.epsEstimate } : {}) },
          { source: SRC.earnings, asOf: iso(s.earnings.at) }
        )
      : missing(SRC.earnings, "No earnings date in the next 120 days", iso(s.earnings.at));

  const tv = s.target?.value;
  const tMean = tv ? num(tv.targetMean) : null;
  const streetTarget: Fact<number> = !s.target
    ? missing(SRC.target, absentNote(s.errors.target, "No Street target"), now)
    : tMean != null && tMean > 0
      ? fact(tMean, { source: SRC.target, asOf: iso(s.target.at), unit: "USD", note: num(tv?.numberOfAnalysts) != null ? `Mean of ${tv!.numberOfAnalysts} analysts` : undefined })
      : missing(SRC.target, "No analyst price target for this symbol", iso(s.target.at));

  return {
    price, change1d, marketCap, sharesOut, pe, evEbitda, epsTTM, range52w,
    revenueTTM, netIncomeTTM, fcfTTM, cashAndSTI, debt, beta, dividendYield, nextEarnings, streetTarget,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/facts/fast.test.ts`
Expected: PASS (11 tests). If the AAPL fixture lacks quarterly capex so `fcfTTM` is null, the first test still passes (note present). If the trimmed fixture has no debt or cash tag, so `evEbitda` is null, change that one test to build `edgar` by hand: `{ value: { ...snapshotEdgar(aapl), balance: { ...snapshotEdgar(aapl).balance!, totalDebt: 100e9, cashAndShortTermInvestments: 60e9 } }, at: AT }`. Never edit the fixture.

- [ ] **Step 5: Commit**

```bash
git add src/lib/facts/fast.ts src/lib/facts/fast.test.ts
git commit -m "feat(facts): build sourced fast facts with derived multiples in code"
```

---

### Task 8: getTickerFacts and getTickerFactsSlim

**Files:**
- Create: `src/lib/facts/ticker.ts`
- Test: `src/lib/facts/ticker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/facts/ticker.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import aapl from "@/lib/__fixtures__/sec/aapl.json";
import { createFakeFirestore } from "@/test/fakeFirestore";

const fs = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeFirestore> | null }));
const deps = vi.hoisted(() => ({
  getQuote: vi.fn(), getBasicFinancials: vi.fn(), getEarningsCalendar: vi.fn(), getPriceTarget: vi.fn(),
  getCikByTicker: vi.fn(), getCompanyFacts: vi.fn(), getStockBundle: vi.fn(), assembleScoreInputs: vi.fn(),
}));

vi.mock("@/lib/firebase-admin", () => ({ get db() { return fs.current!.db; } }));
vi.mock("@/lib/llm", () => ({ generate: vi.fn() }));
vi.mock("@/agents/skills", () => ({ getSkillsPrompt: () => "" }));
vi.mock("@/lib/finnhub", () => ({
  getQuote: deps.getQuote, getBasicFinancials: deps.getBasicFinancials,
  getEarningsCalendar: deps.getEarningsCalendar, getPriceTarget: deps.getPriceTarget,
}));
vi.mock("@/lib/edgar", async (orig) => ({
  ...(await orig<typeof import("@/lib/edgar")>()),
  getCikByTicker: deps.getCikByTicker, getCompanyFacts: deps.getCompanyFacts,
}));
vi.mock("@/lib/stockData", () => ({ getStockBundle: deps.getStockBundle }));
vi.mock("@/lib/finavaInputs", async (orig) => ({
  ...(await orig<typeof import("@/lib/finavaInputs")>()),
  assembleScoreInputs: deps.assembleScoreInputs,
}));

import { getTickerFacts, getTickerFactsSlim } from "./ticker";
import { clearFactsMemo } from "./cache";
import { SCORE_VERSION, DCF_VERSION } from "./types";

const NOW = new Date("2026-09-15T18:00:00.000Z");
const now = () => NOW;

const INPUTS = {
  revenueYoY: 0.11, epsYoY: 0.14, revenueCagr3y: 0.09, grossMargin: 45, operatingMargin: 30, netMargin: 25,
  roe: 28, roa: 18, roic: 22, debtToEquity: 1.1, currentRatio: 1.3, fcfConversion: 1.05,
  price: 230, dcfFair: 215, peTTM: 30, peerPe: 26, psTTM: 7, peerPs: 6,
  ratingSkew: 0.6, targetUpsidePct: null, estimateRevisionPct: null, earningsSurprisePct: 0.04,
  trendVs200: 0.08, ret3m: 0.06, relStrength6m: 0.04, newsSentiment: 62, xSentiment: 58, insiderFlow: 0.2,
  beta: 1.2, annualizedVol: 0.24,
};

beforeEach(() => {
  vi.clearAllMocks();
  fs.current = createFakeFirestore();
  clearFactsMemo();
  deps.getQuote.mockResolvedValue({ ticker: "AAPL", price: 230, change: 2, changePct: 0.9, volume: 0, high: 0, low: 0, open: 0, prevClose: 0, asOf: "2026-09-15T17:59:00.000Z", asOfSource: "exchange" });
  deps.getBasicFinancials.mockResolvedValue({ metric: { epsTTM: 7.5, beta: 1.2, "52WeekLow": 170, "52WeekHigh": 260, marketCapitalization: 3_400_000, ebitdPerShareTTM: 11 } });
  deps.getEarningsCalendar.mockResolvedValue({ earningsCalendar: [{ symbol: "AAPL", date: "2026-10-28", epsEstimate: 2.02 }] });
  deps.getPriceTarget.mockResolvedValue({ targetMean: 250, numberOfAnalysts: 38 });
  deps.getCikByTicker.mockResolvedValue("0000320193");
  deps.getCompanyFacts.mockResolvedValue(aapl);
  deps.getStockBundle.mockResolvedValue({ insider: null, sentiment: { score: 60 }, profile: { name: "Apple Inc." } });
  deps.assembleScoreInputs.mockResolvedValue(INPUTS);
});

describe("getTickerFacts", () => {
  it("computes score and DCF on a miss, with versions, and caches them globally", async () => {
    const f = await getTickerFacts("aapl", { now });
    expect(f.ticker).toBe("AAPL");
    expect(f.score.value?.version).toBe(SCORE_VERSION);
    expect(f.score.value?.grade).toMatch(/^[A-F][+-]?$/);
    expect(f.score.value?.pillars).toHaveLength(6);
    expect(f.dcf.value?.version).toBe(DCF_VERSION);
    expect(f.dcf.value?.wacc).toBeCloseTo(0.04 + 1.2 * 0.05);
    expect(fs.current!.docs.has("factsCache/AAPL")).toBe(true);
    expect(f.dropped).toEqual([]);
  });

  it("feeds the score the canonical DCF fair value and P/E", async () => {
    const f = await getTickerFacts("AAPL", { now });
    const pre = deps.assembleScoreInputs.mock.calls[0][5];
    expect(pre.dcf.dcfFair).toBe(f.dcf.value!.fairValue);
    expect(pre.peTTM).toBeCloseTo(230 / 7.5);
  });

  it("serves a second read from the cache without re-assembling", async () => {
    await getTickerFacts("AAPL", { now });
    clearFactsMemo();
    await getTickerFacts("AAPL", { now });
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(1);
  });

  it("cachedOnly never assembles, and says the score isn't computed yet", async () => {
    const f = await getTickerFacts("AAPL", { now, cachedOnly: true });
    expect(deps.assembleScoreInputs).not.toHaveBeenCalled();
    expect(deps.getStockBundle).not.toHaveBeenCalled();
    expect(f.score.value).toBeNull();
    expect(f.score.note).toBe("Not scored yet");
    expect(f.price.value).toBe(230);
  });

  it("refreshDerived recomputes even when cached", async () => {
    await getTickerFacts("AAPL", { now });
    await getTickerFacts("AAPL", { now, refreshDerived: true });
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing source and names it", async () => {
    deps.getQuote.mockRejectedValue(new Error("Finnhub 429"));
    const f = await getTickerFacts("AAPL", { now, cachedOnly: true });
    expect(f.dropped).toEqual(["quote"]);
    expect(f.price.note).toBe("Source unavailable right now");
    expect(f.revenueTTM.value).not.toBeNull();
  });

  it("drops a source that misses the deadline instead of waiting", async () => {
    deps.getCompanyFacts.mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    const f = await getTickerFacts("AAPL", { now, cachedOnly: true, deadlineMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.dropped).toContain("edgar");
    expect(f.revenueTTM.note).toBe("Not retrieved in time");
  });

  it("a symbol without SEC filings gets a noted DCF and still a score", async () => {
    deps.getCikByTicker.mockResolvedValue(null);
    const f = await getTickerFacts("SPY", { now });
    expect(f.dcf.value).toBeNull();
    expect(f.dcf.note).toBe("No SEC filings for this symbol");
    expect(f.score.value).not.toBeNull();
  });

  it("does not cache a missing DCF", async () => {
    deps.getCikByTicker.mockResolvedValue(null);
    await getTickerFacts("SPY", { now });
    const doc = fs.current!.docs.get("factsCache/SPY")!;
    expect(doc.dcf).toBeUndefined();
    expect(doc.score).toBeDefined();
  });

  it("re-deriving a missing DCF does not re-stamp the cached score", async () => {
    deps.getCikByTicker.mockResolvedValue(null);
    await getTickerFacts("SPY", { now });
    const firstAt = fs.current!.docs.get("factsCache/SPY")!.scoreAt;
    clearFactsMemo();
    await getTickerFacts("SPY", { now: () => new Date(NOW.getTime() + 3_600_000) });
    expect(fs.current!.docs.get("factsCache/SPY")!.scoreAt).toBe(firstAt);
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent computes for one ticker", async () => {
    await Promise.all([getTickerFacts("AAPL", { now }), getTickerFacts("AAPL", { now })]);
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(1);
  });
});

describe("getTickerFactsSlim", () => {
  it("reads only the cache: scored names get their score, others a note", async () => {
    const full = await getTickerFacts("AAPL", { now });
    vi.clearAllMocks();
    const slim = await getTickerFactsSlim(["AAPL", "MSFT"], { now });
    expect(slim[0]).toEqual({ ticker: "AAPL", score: { ...full.score, value: { total: full.score.value!.total, grade: full.score.value!.grade, version: SCORE_VERSION } } });
    expect(slim[1].score.value).toBeNull();
    expect(slim[1].score.note).toMatch(/Not scored yet/);
    expect(deps.getQuote).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/facts/ticker.test.ts`
Expected: FAIL, cannot resolve `./ticker`.

- [ ] **Step 3: Implement**

```ts
// src/lib/facts/ticker.ts
// The one loader for a ticker's numbers. Server-only.
//
// Fast fields (quote, fundamentals, filings, calendar, Street) come from the
// in-process memo; score + DCF come from the global Firestore tier and are
// computed on a miss unless `cachedOnly`. Every source is failure-isolated and
// optionally raced against a deadline; what failed is listed in `dropped`.

import { getQuote, getBasicFinancials, getEarningsCalendar, getPriceTarget } from "@/lib/finnhub";
import { getCikByTicker, getCompanyFacts } from "@/lib/edgar";
import { pickNextEarnings, type EarningsCalendarRow } from "@/agents/sub-agents/earnings-agent";
import { getStockBundle } from "@/lib/stockData";
import { assembleScoreInputs, finishDcfInputs } from "@/lib/finavaInputs";
import { computeFinavaScore } from "@/lib/finavaScore";
import { defaultFairValue, defaultGrowthFor } from "@/lib/dcf";
import { grade } from "@/lib/research";
import { memo, readDerived, writeDerived, type Derived } from "./cache";
import { buildFastFacts, quoteFacts, snapshotEdgar, SRC, type EdgarSnapshot, type FastFacts, type SourceError, type SourceName } from "./fast";
import { peerPremiumPct } from "./signals";
import {
  fact, missing, toSlim, SCORE_VERSION, DCF_VERSION, TERMINAL_GROWTH,
  type Fact, type ScoreFact, type DcfFact, type TickerFacts, type TickerFactsSlim,
} from "./types";

export interface GetTickerFactsOptions {
  /** Demand fresher data than the default TTLs. */
  maxAgeSec?: number;
  /** Read score/DCF from cache only; never run the expensive assembly. */
  cachedOnly?: boolean;
  /** Ignore cached score/DCF and recompute (a user-requested run). */
  refreshDerived?: boolean;
  /** Total budget in ms; sources still pending are dropped. */
  deadlineMs?: number;
  now?: () => Date;
}

class DeadlineError extends Error {}

function race<T>(p: Promise<T>, deadline: number | undefined): Promise<T> {
  if (deadline == null) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError("timeout")), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([p, timeout]).finally(() => timer && clearTimeout(timer));
}

function easternDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

function plusDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const computing = new Map<string, Promise<Derived>>();

async function computeDerived(
  t: string,
  fast: FastFacts,
  edgar: EdgarSnapshot | null,
  metric: Record<string, unknown> | null,
  have: Derived,
  now: () => Date
): Promise<Derived> {
  const asOf = now().toISOString();

  let dcf: Fact<DcfFact> | null = have.dcf;
  if (!dcf) {
    const base = edgar?.dcfBase ?? null;
    if (!edgar) dcf = missing(SRC.dcf, "SEC filings unavailable right now", asOf);
    else if (!edgar.hasFilings || !base) dcf = missing(SRC.dcf, "No SEC filings for this symbol", asOf);
    else {
      const inputs = finishDcfInputs(base, {
        price: fast.price.value, beta: fast.beta.value, marketCapMillions: num(metric?.marketCapitalization), currency: "USD",
      });
      const positiveFcf = inputs.baseFcf != null && inputs.baseFcf > 0;
      const fairValue = positiveFcf ? defaultFairValue(inputs) : null;
      dcf = fairValue == null
        ? missing(SRC.dcf, positiveFcf ? "Shares outstanding unavailable" : "No positive free cash flow in filings", asOf)
        : fact<DcfFact>(
            { fairValue, wacc: inputs.suggestedWacc, growth: defaultGrowthFor(inputs), terminal: TERMINAL_GROWTH, inputs, version: DCF_VERSION },
            { source: SRC.dcf, asOf, unit: "USD" }
          );
    }
  }

  let score: Fact<ScoreFact> | null = have.score;
  if (!score) {
    const bundle = await getStockBundle(t).catch(() => null);
    const inputs = await assembleScoreInputs(
      t, fast.price.value, bundle?.insider ?? null, bundle?.sentiment?.score ?? null, bundle?.profile?.name ?? t,
      {
        dcf: {
          dcfFair: dcf.value?.fairValue ?? null,
          fcfConversion: edgar?.dcfBase?.fcfConversion ?? null,
          revenueCagr3y: edgar?.dcfBase?.revenueCagr3y ?? null,
        },
        peTTM: fast.pe.value,
      }
    );
    const r = computeFinavaScore(inputs);
    score = r.coverage === 0
      ? missing(SRC.score, "No factor data available for this symbol", asOf)
      : fact<ScoreFact>(
          {
            total: r.score, grade: grade(r.score), pillars: r.pillars, confidence: r.confidence,
            coverage: r.coverage, peerPremiumPct: peerPremiumPct(inputs), version: SCORE_VERSION,
          },
          { source: SRC.score, asOf }
        );
  }

  // Persist only what this call computed, so re-deriving a missing DCF never
  // silently extends a cached score's 24 h life.
  await writeDerived(t, { score: have.score ? null : score, dcf: have.dcf ? null : dcf }, now());
  return { score, dcf };
}

export async function getTickerFacts(raw: string, opts: GetTickerFactsOptions = {}): Promise<TickerFacts> {
  const t = raw.trim().toUpperCase();
  const now = opts.now ?? (() => new Date());
  const deadline = opts.deadlineMs != null ? Date.now() + opts.deadlineMs : undefined;
  const errors: Partial<Record<SourceName, SourceError>> = {};
  const m = { maxAgeSec: opts.maxAgeSec, now };

  const run = async <T>(name: SourceName, load: () => Promise<{ value: T; at: number }>) => {
    try {
      return await race(load(), deadline);
    } catch (err) {
      errors[name] = err instanceof DeadlineError ? "timeout" : "error";
      return null;
    }
  };

  const today = easternDay(now());
  const [quote, metric, edgar, earnings, target, cached] = await Promise.all([
    run("quote", () => memo(`quote:${t}`, "quote", () => getQuote(t), m)),
    run("metric", () =>
      memo(`metric:${t}`, "day", async () => ((await getBasicFinancials(t)) as { metric?: Record<string, unknown> } | null)?.metric ?? null, m)),
    run("edgar", () =>
      memo(`edgar:${t}`, "day", async () => {
        const cik = await getCikByTicker(t);
        return snapshotEdgar(cik ? await getCompanyFacts(cik) : null);
      }, m)),
    run("earnings", () =>
      memo(`earnings:${t}`, "day", async () => {
        const res = (await getEarningsCalendar(today, plusDays(today, 120), t)) as { earningsCalendar?: EarningsCalendarRow[] } | null;
        return pickNextEarnings(res?.earningsCalendar ?? [], today);
      }, m)),
    run("target", () => memo(`target:${t}`, "day", () => getPriceTarget(t), m)),
    run("derived", async () => ({
      value: opts.refreshDerived ? { score: null, dcf: null } : await readDerived(t, m),
      at: now().getTime(),
    })),
  ]);

  const fast = buildFastFacts(t, { quote, metric, edgar, earnings, target, errors });

  let derived: Derived = cached?.value ?? { score: null, dcf: null };
  if (!opts.cachedOnly && (!derived.score || !derived.dcf)) {
    const have = derived;
    let job = computing.get(t);
    if (!job) {
      job = computeDerived(t, fast, edgar?.value ?? null, metric?.value ?? null, have, now).finally(() => computing.delete(t));
      computing.set(t, job);
    }
    const done = await run("derived", async () => ({ value: await job!, at: now().getTime() }));
    if (done) derived = done.value;
  }

  const asOf = now().toISOString();
  const pendingNote = opts.cachedOnly ? "Not scored yet" : errors.derived === "timeout" ? "Not retrieved in time" : "Couldn't compute right now";
  return {
    ticker: t,
    ...fast,
    score: derived.score ?? missing(SRC.score, pendingNote, asOf),
    dcf: derived.dcf ?? missing(SRC.dcf, opts.cachedOnly ? "Not computed yet" : pendingNote, asOf),
    dropped: Object.keys(errors),
  };
}

/** Price, day change and cached score only: what a holdings row needs. Cheap. */
export async function getTickerQuoteFacts(
  raw: string,
  opts: Pick<GetTickerFactsOptions, "now"> = {}
): Promise<Pick<TickerFacts, "ticker" | "price" | "change1d" | "score">> {
  const t = raw.trim().toUpperCase();
  const now = opts.now ?? (() => new Date());
  const errors: Partial<Record<SourceName, SourceError>> = {};
  const [quote, derived] = await Promise.all([
    memo(`quote:${t}`, "quote", () => getQuote(t), { now }).catch(() => {
      errors.quote = "error";
      return null;
    }),
    readDerived(t, { now }),
  ]);
  return {
    ticker: t,
    ...quoteFacts(quote, errors),
    score: derived.score ?? missing(SRC.score, "Not scored yet", now().toISOString()),
  };
}

/** Cache-only score headlines for list rows. Never calls a market-data vendor. */
export async function getTickerFactsSlim(
  tickers: string[],
  opts: Pick<GetTickerFactsOptions, "now"> = {}
): Promise<TickerFactsSlim[]> {
  const now = opts.now ?? (() => new Date());
  return Promise.all(
    tickers.map(async (raw) => {
      const t = raw.trim().toUpperCase();
      const d = await readDerived(t, { now });
      return toSlim({
        ticker: t,
        score: d.score ?? missing(SRC.score, "Not scored yet. Open the stock page to compute it.", now().toISOString()),
      });
    })
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/facts/ticker.test.ts`
Expected: PASS (12 tests). If `pickNextEarnings` needs more of `@/lib/llm` at import, extend that mock with the named exports the import error lists.

- [ ] **Step 5: Commit**

```bash
git add src/lib/facts/ticker.ts src/lib/facts/ticker.test.ts
git commit -m "feat(facts): getTickerFacts with global score/DCF cache and deadlines"
```

---

### Task 9: Portfolio facts

**Files:**
- Create: `src/lib/facts/portfolio.ts`
- Test: `src/lib/facts/portfolio.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/facts/portfolio.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFirestore } from "@/test/fakeFirestore";

const fs = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeFirestore> | null }));
const deps = vi.hoisted(() => ({ getTickerQuoteFacts: vi.fn() }));
vi.mock("@/lib/firebase-admin", () => ({ get db() { return fs.current!.db; } }));
vi.mock("./ticker", () => ({ getTickerQuoteFacts: deps.getTickerQuoteFacts }));

import { buildPortfolioFacts, getPortfolioFacts } from "./portfolio";
import { fact, missing, SCORE_VERSION } from "./types";

const NOW = new Date("2026-09-15T18:00:00.000Z");
const priced = (ticker: string, price: number) => ({
  ticker,
  price: fact(price, { source: "Finnhub quote", asOf: "2026-09-15T17:59:00.000Z", unit: "USD" }),
  change1d: fact(1, { source: "Finnhub quote", asOf: "2026-09-15T17:59:00.000Z", unit: "%" }),
  score: fact({ total: 58, grade: "C", pillars: [], confidence: "Moderate" as const, coverage: 1, peerPremiumPct: null, version: SCORE_VERSION }, { source: "Finava Score v2 (15 factors)", asOf: NOW.toISOString() }),
});

describe("buildPortfolioFacts", () => {
  it("computes weights as fractions that sum to 1 with cash", () => {
    const p = buildPortfolioFacts(
      [{ ticker: "AAPL", shares: 10, avgCost: 150 }, { ticker: "MSFT", shares: 5, avgCost: 300 }],
      700,
      new Map([["AAPL", priced("AAPL", 230)], ["MSFT", priced("MSFT", 460)]]),
      NOW
    );
    expect(p.totalValue.value).toBe(2300 + 2300 + 700);
    expect(p.holdings[0].weight.value).toBeCloseTo(0.434, 3);
    expect(p.weightsSum).toBe(1);
    expect(p.cash.value).toBe(700);
    expect(p.holdings[0].costBasis.value).toBe(150);
    expect(p.holdings[0].score.value).toEqual({ total: 58, grade: "C", version: SCORE_VERSION });
  });

  it("leaves an unpriced holding out of the totals, with notes", () => {
    const p = buildPortfolioFacts(
      [{ ticker: "AAPL", shares: 10, avgCost: 150 }, { ticker: "XYZ", shares: 1, avgCost: 10 }],
      0,
      new Map([["AAPL", priced("AAPL", 230)], ["XYZ", { ...priced("XYZ", 1), price: missing("Finnhub quote", "Source unavailable right now") }]]),
      NOW
    );
    expect(p.totalValue.value).toBe(2300);
    expect(p.totalValue.note).toBe("Excludes unpriced: XYZ");
    expect(p.holdings[1].weight.value).toBeNull();
    expect(p.holdings[1].weight.note).toBe("No live price; excluded from totals");
    expect(p.holdings[1].marketValue.value).toBeNull();
    expect(p.weightsSum).toBe(1);
  });

  it("an empty account is worth zero, not unavailable", () => {
    const p = buildPortfolioFacts([], 0, new Map(), NOW);
    expect(p.totalValue.value).toBe(0);
    expect(p.weightsSum).toBe(0);
  });

  it("a book with nothing priced and no cash is unavailable", () => {
    const p = buildPortfolioFacts([{ ticker: "XYZ", shares: 1, avgCost: 10 }], 0, new Map(), NOW);
    expect(p.totalValue.value).toBeNull();
    expect(p.totalValue.note).toBe("No holdings could be priced");
  });
});

describe("getPortfolioFacts", () => {
  beforeEach(async () => {
    fs.current = createFakeFirestore();
    const u = fs.current.db.collection("users").doc("u1");
    await u.collection("holdings").doc("AAPL").set({ ticker: "AAPL", shares: 10, avgCost: 150 });
    await u.collection("portfolioSettings").doc("default").set({ cashBalance: 100 });
    deps.getTickerQuoteFacts.mockImplementation(async (t: string) => priced(t, 230));
  });

  it("reads holdings and cash for the user and prices them from facts", async () => {
    const p = await getPortfolioFacts("u1", { now: () => NOW });
    expect(p.holdings.map((h) => h.ticker)).toEqual(["AAPL"]);
    expect(p.totalValue.value).toBe(2400);
    expect(deps.getTickerQuoteFacts).toHaveBeenCalledWith("AAPL", expect.anything());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/facts/portfolio.test.ts`
Expected: FAIL, cannot resolve `./portfolio`.

- [ ] **Step 3: Implement**

```ts
// src/lib/facts/portfolio.ts
// A user's book as facts. The arithmetic (totals, rounded weights) is
// computePortfolio's — the same numbers chat already quotes — wrapped with
// sources and as-of, and priced from the facts layer's quote cache.
import { db } from "@/lib/firebase-admin";
import { computePortfolio, type PortfolioHoldingInput } from "@/lib/portfolioContext";
import { runPooled } from "@/lib/stockData";
import type { Quote } from "@/types/portfolio";
import { getTickerQuoteFacts } from "./ticker";
import { fact, missing, toSlim, type PortfolioFacts, type HoldingFact, type TickerFacts } from "./types";

type QuoteFacts = Pick<TickerFacts, "ticker" | "price" | "change1d" | "score">;

const SRC = {
  quote: "Finnhub quote",
  marketValue: "Computed: price × shares",
  weight: "Computed: market value ÷ total value (holdings + cash)",
  total: "Computed: priced holdings + cash",
  holdings: "Your holdings",
  cash: "Your portfolio settings",
  score: "Finava Score v2 (15 factors)",
} as const;

const UNPRICED = "No live price; excluded from totals";

export function buildPortfolioFacts(
  holdings: PortfolioHoldingInput[],
  cashBalance: number,
  facts: Map<string, QuoteFacts>,
  now: Date
): PortfolioFacts {
  const iso = now.toISOString();
  const quoteMap = new Map<string, Quote>();
  for (const h of holdings) {
    const f = facts.get(h.ticker.toUpperCase());
    if (f?.price.value != null) {
      quoteMap.set(h.ticker, {
        ticker: h.ticker, price: f.price.value, change: 0,
        changePct: f.change1d.value ?? Number.NaN, timestamp: Date.parse(f.price.asOf),
      });
    }
  }
  const p = computePortfolio(holdings, cashBalance, quoteMap);
  const asOf = p.quotedAt != null ? new Date(p.quotedAt).toISOString() : iso;

  const rows: HoldingFact[] = p.rows.map((r, i) => {
    const h = holdings[i];
    const f = facts.get(h.ticker.toUpperCase());
    const price = f?.price ?? missing<number>(SRC.quote, "No live price", iso);
    return {
      ticker: r.ticker,
      shares: r.shares,
      price,
      marketValue: r.marketValue == null ? missing(SRC.marketValue, UNPRICED, iso) : fact(r.marketValue, { source: SRC.marketValue, asOf: price.asOf, unit: "USD" }),
      weight: r.weightPct == null ? missing(SRC.weight, UNPRICED, iso) : fact(r.weightPct / 100, { source: SRC.weight, asOf, unit: "fraction" }),
      costBasis: fact(h.avgCost, { source: SRC.holdings, asOf: iso, unit: "USD" }),
      score: toSlim({ ticker: r.ticker, score: f?.score ?? missing(SRC.score, "Not scored yet", iso) }).score,
    };
  });

  const nothingPriced = holdings.length > 0 && p.unpriced.length === holdings.length && p.cash === 0;
  const weightsSum = Math.round(
    (rows.reduce((s, r) => s + (r.weight.value ?? 0), 0) + (p.cashWeightPct ?? 0) / 100) * 1e4
  ) / 1e4;

  return {
    holdings: rows,
    totalValue: nothingPriced
      ? missing(SRC.total, "No holdings could be priced", iso)
      : fact(p.totalValue, { source: SRC.total, asOf, unit: "USD", note: p.unpriced.length ? `Excludes unpriced: ${p.unpriced.join(", ")}` : undefined }),
    cash: fact(p.cash, { source: SRC.cash, asOf: iso, unit: "USD" }),
    weightsSum,
  };
}

export async function getPortfolioFacts(userId: string, opts: { now?: () => Date } = {}): Promise<PortfolioFacts> {
  const now = opts.now ?? (() => new Date());
  const user = db.collection("users").doc(userId);
  const [holdSnap, settingsSnap] = await Promise.all([
    user.collection("holdings").orderBy("ticker").get(),
    user.collection("portfolioSettings").doc("default").get(),
  ]);
  const holdings: PortfolioHoldingInput[] = holdSnap.docs.map((d) => {
    const x = d.data() as Record<string, unknown>;
    return { ticker: String(x.ticker ?? d.id).toUpperCase(), shares: Number(x.shares) || 0, avgCost: Number(x.avgCost) || 0 };
  });
  const cash = Number((settingsSnap.exists ? settingsSnap.data() : undefined)?.cashBalance) || 0;
  // Pooled: a large book shouldn't burst the shared Finnhub rate limit.
  const loaded = await runPooled(holdings.map((h) => () => getTickerQuoteFacts(h.ticker, { now })), 3);
  const facts = new Map(loaded.flatMap((f) => (f ? [[f.ticker, f] as const] : [])));
  return buildPortfolioFacts(holdings, cash, facts, now());
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/facts/portfolio.test.ts`
Expected: PASS (5 tests). `Number.isFinite(NaN)` is false, so `computePortfolio` records no day change for an unknown change; that is intended.

- [ ] **Step 5: Commit**

```bash
git add src/lib/facts/portfolio.ts src/lib/facts/portfolio.test.ts
git commit -m "feat(facts): portfolio facts with computed weights and sourced totals"
```

---

### Task 10: Test fixture for TickerFacts

**Files:**
- Create: `src/test/factsFixture.ts`

- [ ] **Step 1: Write the helper** (used by the route, quickContext and UI-adjacent tests below)

```ts
// src/test/factsFixture.ts
// A complete, plausible TickerFacts for tests. Every field sourced and dated.
import { computeFinavaScore, type ScoreInputs } from "@/lib/finavaScore";
import { grade } from "@/lib/research";
import { peerPremiumPct } from "@/lib/facts/signals";
import { fact, SCORE_VERSION, DCF_VERSION, TERMINAL_GROWTH, type TickerFacts } from "@/lib/facts/types";

export const FIXTURE_ASOF = "2026-09-15T20:00:00.000Z";

export function scoreInputs(over: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    revenueYoY: 0.11, epsYoY: 0.14, revenueCagr3y: 0.09, grossMargin: 45, operatingMargin: 30, netMargin: 25,
    roe: 28, roa: 18, roic: 22, debtToEquity: 1.1, currentRatio: 1.3, fcfConversion: 1.05,
    price: 200, dcfFair: 215, peTTM: 30, peerPe: 26, psTTM: 7, peerPs: 6,
    ratingSkew: 0.6, targetUpsidePct: null, estimateRevisionPct: null, earningsSurprisePct: 0.04,
    trendVs200: 0.08, ret3m: 0.06, relStrength6m: 0.04, newsSentiment: 62, xSentiment: 58, insiderFlow: 0.2,
    beta: 1.2, annualizedVol: 0.24, ...over,
  };
}

export function tickerFactsFixture(
  ticker = "NVDA",
  over: Partial<TickerFacts> = {},
  inputs: ScoreInputs = scoreInputs()
): TickerFacts {
  const at = (source: string, unit?: string) => ({ source, asOf: FIXTURE_ASOF, unit });
  const r = computeFinavaScore(inputs);
  return {
    ticker,
    price: fact(182.5, at("Finnhub quote", "USD")),
    change1d: fact(1.79, at("Finnhub quote", "%")),
    marketCap: fact(4.46e12, at("Computed: price × shares outstanding", "USD")),
    sharesOut: fact(24.4e9, at("SEC EDGAR cover page", "shares")),
    pe: fact(51.26, at("Computed: price ÷ EPS (TTM)", "x")),
    evEbitda: fact(40.1, at("Computed: enterprise value ÷ EBITDA (TTM)", "x")),
    epsTTM: fact(3.56, at("Finnhub basic financials", "USD")),
    range52w: fact({ low: 86.6, high: 195.6 }, at("Finnhub basic financials", "USD")),
    revenueTTM: fact(165e9, at("SEC EDGAR (last four quarters)", "USD")),
    netIncomeTTM: fact(86e9, at("SEC EDGAR (last four quarters)", "USD")),
    fcfTTM: fact(72e9, at("Computed: operating cash flow − capex (TTM)", "USD")),
    cashAndSTI: fact(56e9, at("SEC EDGAR balance sheet", "USD")),
    debt: fact(8.5e9, at("SEC EDGAR balance sheet", "USD")),
    beta: fact(1.2, at("Finnhub basic financials")),
    dividendYield: fact(0.02, at("Finnhub basic financials", "%")),
    nextEarnings: fact({ date: "2026-11-18", estimated: true }, at("Finnhub earnings calendar")),
    streetTarget: fact(225, { ...at("Finnhub price target", "USD"), note: "Mean of 40 analysts" }),
    score: fact(
      { total: r.score, grade: grade(r.score), pillars: r.pillars, confidence: r.confidence, coverage: r.coverage, peerPremiumPct: peerPremiumPct(inputs), version: SCORE_VERSION },
      at("Finava Score v2 (15 factors)")
    ),
    dcf: fact(
      {
        fairValue: inputs.dcfFair ?? 215, wacc: 0.1, growth: 0.08, terminal: TERMINAL_GROWTH, version: DCF_VERSION,
        inputs: { baseFcf: 72e9, fcfIsProxy: false, sharesOutstanding: 24.4e9, netDebt: -47.5e9, historicalGrowth: 0.3, suggestedWacc: 0.1, currentPrice: 182.5, currency: "USD" },
      },
      at("Finava DCF on SEC EDGAR filings", "USD")
    ),
    dropped: [],
    ...over,
  };
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/test/factsFixture.ts
git commit -m "test(facts): TickerFacts fixture"
```

---

### Task 11: /api/facts routes

**Files:**
- Create: `src/app/api/facts/[ticker]/route.ts`, `src/app/api/facts/route.ts`
- Test: `src/app/api/facts/[ticker]/route.test.ts`, `src/app/api/facts/route.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/facts/[ticker]/route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { tickerFactsFixture } from "@/test/factsFixture";

const deps = vi.hoisted(() => ({ rateLimitGuard: vi.fn(), getTickerFacts: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));

import { GET } from "./route";

const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.rateLimitGuard.mockResolvedValue(null);
  deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("AAPL"));
});

describe("GET /api/facts/[ticker]", () => {
  it("returns the ticker's facts, uppercased", async () => {
    const res = await GET(new Request("http://t/api/facts/aapl"), ctx("aapl"));
    expect(res.status).toBe(200);
    expect((await res.json()).ticker).toBe("AAPL");
    expect(deps.getTickerFacts).toHaveBeenCalledWith("AAPL", { cachedOnly: false });
  });

  it("passes cachedOnly through", async () => {
    await GET(new Request("http://t/api/facts/AAPL?cachedOnly=1"), ctx("AAPL"));
    expect(deps.getTickerFacts).toHaveBeenCalledWith("AAPL", { cachedOnly: true });
  });

  it("400s an invalid ticker without loading", async () => {
    expect((await GET(new Request("http://t"), ctx("not a ticker!"))).status).toBe(400);
    expect(deps.getTickerFacts).not.toHaveBeenCalled();
  });

  it("honours the rate limit", async () => {
    deps.rateLimitGuard.mockResolvedValueOnce(NextResponse.json({ error: "slow" }, { status: 429 }));
    expect((await GET(new Request("http://t"), ctx("AAPL"))).status).toBe(429);
  });

  it("502s if the loader unexpectedly throws", async () => {
    deps.getTickerFacts.mockRejectedValueOnce(new Error("boom"));
    expect((await GET(new Request("http://t"), ctx("AAPL"))).status).toBe(502);
  });
});
```

```ts
// src/app/api/facts/route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({ rateLimitGuard: vi.fn(), getTickerFactsSlim: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFactsSlim: deps.getTickerFactsSlim }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  deps.rateLimitGuard.mockResolvedValue(null);
  deps.getTickerFactsSlim.mockImplementation(async (ts: string[]) => ts.map((ticker) => ({ ticker, score: { value: null, source: "s", asOf: "a", note: "Not scored yet" } })));
});

describe("GET /api/facts?tickers=", () => {
  it("dedupes, uppercases and drops invalid symbols", async () => {
    const res = await GET(new Request("http://t/api/facts?tickers=aapl,AAPL,msft,%24%24"));
    expect(res.status).toBe(200);
    expect(deps.getTickerFactsSlim).toHaveBeenCalledWith(["AAPL", "MSFT"]);
    expect((await res.json()).facts).toHaveLength(2);
  });

  it("caps a request at 50 tickers", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`);
    await GET(new Request(`http://t/api/facts?tickers=${many.join(",")}`));
    expect(deps.getTickerFactsSlim.mock.calls[0][0].length).toBeLessThanOrEqual(50);
  });

  it("400s with no valid tickers", async () => {
    expect((await GET(new Request("http://t/api/facts"))).status).toBe(400);
  });

  it("honours the rate limit", async () => {
    deps.rateLimitGuard.mockResolvedValueOnce(NextResponse.json({}, { status: 429 }));
    expect((await GET(new Request("http://t/api/facts?tickers=AAPL"))).status).toBe(429);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/app/api/facts`
Expected: FAIL, cannot resolve `./route`.

- [ ] **Step 3: Implement**

First check the route conventions for this Next version: `ls node_modules/next/dist/docs/` and skim the route handler doc for dynamic `params` (the existing routes await `params`, keep that).

```ts
// src/app/api/facts/[ticker]/route.ts
// A ticker's facts: every number the stock page shows, sourced and dated.
// Public read-only market data (same posture as /api/stock/[ticker]/score).
// `?cachedOnly=1` skips the expensive score/DCF assembly for a fast first paint.
import { NextResponse } from "next/server";
import { rateLimitGuard } from "@/lib/rateLimit";
import { isValidTicker } from "@/lib/tickers";
import { getTickerFacts } from "@/lib/facts/ticker";

export const runtime = "nodejs";
// A cold score assembly includes the Grok read (up to ~30 s).
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const limited = await rateLimitGuard(req, "facts", { capacity: 30, refillPerSec: 0.5 });
  if (limited) return limited;

  const { ticker } = await params;
  const symbol = (ticker ?? "").trim().toUpperCase();
  if (!symbol || !isValidTicker(symbol)) return NextResponse.json({ error: "Invalid ticker." }, { status: 400 });

  const cachedOnly = new URL(req.url).searchParams.get("cachedOnly") === "1";
  try {
    return NextResponse.json(await getTickerFacts(symbol, { cachedOnly }));
  } catch (err) {
    console.error("[facts]", symbol, err);
    return NextResponse.json({ error: `Couldn't load facts for ${symbol}.` }, { status: 502 });
  }
}
```

```ts
// src/app/api/facts/route.ts
// Cache-only score headlines for list rows (watchlist, board, portfolio).
// Never computes: a name nobody has opened reads "Not scored yet".
import { NextResponse } from "next/server";
import { rateLimitGuard } from "@/lib/rateLimit";
import { isValidTicker } from "@/lib/tickers";
import { getTickerFactsSlim } from "@/lib/facts/ticker";

export const runtime = "nodejs";
const MAX_TICKERS = 50;

export async function GET(req: Request) {
  const limited = await rateLimitGuard(req, "facts-batch", { capacity: 30, refillPerSec: 1 });
  if (limited) return limited;

  const raw = new URL(req.url).searchParams.get("tickers") ?? "";
  const tickers = [...new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter((t) => t && isValidTicker(t)))].slice(0, MAX_TICKERS);
  if (tickers.length === 0) return NextResponse.json({ error: "No valid tickers." }, { status: 400 });

  try {
    return NextResponse.json({ facts: await getTickerFactsSlim(tickers) });
  } catch (err) {
    console.error("[facts batch]", err);
    return NextResponse.json({ error: "Couldn't load scores." }, { status: 502 });
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/app/api/facts`
Expected: PASS (9 tests). If `isValidTicker` rejects the synthetic `T..` tickers in the cap test, change the generator to two-to-four uppercase letters that pass it and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/facts
git commit -m "feat(facts): /api/facts/[ticker] and cache-only batch route"
```

---

### Task 12: /score and /dcf become readers of facts

**Files:**
- Modify: `src/app/api/stock/[ticker]/score/route.ts`, `src/app/api/stock/[ticker]/dcf/route.ts`
- Test: replace `src/app/api/stock/[ticker]/score/route.test.ts` and `src/app/api/stock/[ticker]/dcf/route.test.ts`

- [ ] **Step 1: Replace the tests**

```ts
// src/app/api/stock/[ticker]/score/route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tickerFactsFixture } from "@/test/factsFixture";
import { missing } from "@/lib/facts/types";

const deps = vi.hoisted(() => ({ rateLimitGuard: vi.fn(), getTickerFacts: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));

import { GET } from "./route";
const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.rateLimitGuard.mockResolvedValue(null);
});

describe("GET /api/stock/[ticker]/score", () => {
  it("returns the canonical facts score, grade, pillars and as-of", async () => {
    const f = tickerFactsFixture("NVDA");
    deps.getTickerFacts.mockResolvedValue(f);
    const body = await (await GET(new Request("http://t"), ctx("nvda"))).json();
    expect(body).toEqual({
      ticker: "NVDA", score: f.score.value!.total, grade: f.score.value!.grade, pillars: f.score.value!.pillars,
      confidence: f.score.value!.confidence, asOf: f.score.asOf, version: f.score.value!.version, note: null,
    });
  });

  it("returns a null score with the note rather than a stand-in", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("SPY", { score: missing("Finava Score v2 (15 factors)", "No factor data available for this symbol", "2026-09-15") }));
    const res = await GET(new Request("http://t"), ctx("SPY"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score).toBeNull();
    expect(body.grade).toBeNull();
    expect(body.note).toBe("No factor data available for this symbol");
  });

  it("400s a blank ticker and 502s a loader failure", async () => {
    expect((await GET(new Request("http://t"), ctx("  "))).status).toBe(400);
    deps.getTickerFacts.mockRejectedValueOnce(new Error("boom"));
    expect((await GET(new Request("http://t"), ctx("AAPL"))).status).toBe(502);
  });
});
```

```ts
// src/app/api/stock/[ticker]/dcf/route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tickerFactsFixture } from "@/test/factsFixture";
import { missing } from "@/lib/facts/types";

const deps = vi.hoisted(() => ({ rateLimitGuard: vi.fn(), getTickerFacts: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));

import { GET } from "./route";
const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.rateLimitGuard.mockResolvedValue(null);
});

describe("GET /api/stock/[ticker]/dcf", () => {
  it("returns the canonical DCF inputs from facts", async () => {
    const f = tickerFactsFixture("AAPL");
    deps.getTickerFacts.mockResolvedValue(f);
    const res = await GET(new Request("http://t"), ctx("aapl"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticker: "AAPL", inputs: f.dcf.value!.inputs });
  });

  it("404s with the facts note when no DCF is available", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("SPY", { dcf: missing("Finava DCF on SEC EDGAR filings", "No SEC filings for this symbol") }));
    const res = await GET(new Request("http://t"), ctx("SPY"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("DCF is unavailable for SPY (No SEC filings for this symbol).");
  });

  it("400s a blank ticker and 500s a loader failure", async () => {
    expect((await GET(new Request("http://t"), ctx(""))).status).toBe(400);
    deps.getTickerFacts.mockRejectedValueOnce(new Error("boom"));
    expect((await GET(new Request("http://t"), ctx("AAPL"))).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run "src/app/api/stock/[ticker]/score" "src/app/api/stock/[ticker]/dcf"`
Expected: FAIL (old routes read the universe / EDGAR directly).

- [ ] **Step 3: Replace the routes**

```ts
// src/app/api/stock/[ticker]/score/route.ts
// The canonical Finava Score for one ticker, read from the facts layer (the
// 15-factor engine). Kept for callers of this path; the stock page reads
// /api/facts/[ticker] directly. A score we can't compute is null with a note.
import { NextResponse } from "next/server";
import { rateLimitGuard } from "@/lib/rateLimit";
import { getTickerFacts } from "@/lib/facts/ticker";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const limited = await rateLimitGuard(req, "stock-score", { capacity: 20, refillPerSec: 0.5 });
  if (limited) return limited;

  const { ticker } = await params;
  const symbol = (ticker ?? "").trim().toUpperCase();
  if (!symbol) return NextResponse.json({ error: "Missing ticker." }, { status: 400 });

  try {
    const { score } = await getTickerFacts(symbol);
    const v = score.value;
    return NextResponse.json({
      ticker: symbol,
      score: v?.total ?? null,
      grade: v?.grade ?? null,
      pillars: v?.pillars ?? [],
      confidence: v?.confidence ?? null,
      asOf: score.asOf,
      version: v?.version ?? null,
      note: score.note ?? null,
    });
  } catch (err) {
    console.error("[stock score]", symbol, err);
    return NextResponse.json({ error: `Couldn't compute the score for ${symbol}.` }, { status: 502 });
  }
}
```

```ts
// src/app/api/stock/[ticker]/dcf/route.ts
// DCF base inputs, read from the facts layer so this and every other surface use
// the one input path (beta-tuned WACC, split-safe shares). The DCF tab recomputes
// locally as the user drags sliders; those tweaks never leave the browser.
import { NextResponse } from "next/server";
import { rateLimitGuard } from "@/lib/rateLimit";
import { getTickerFacts } from "@/lib/facts/ticker";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const limited = await rateLimitGuard(req, "stock-dcf", { capacity: 20, refillPerSec: 0.5 });
  if (limited) return limited;

  const { ticker } = await params;
  const symbol = (ticker ?? "").trim().toUpperCase();
  if (!symbol) return NextResponse.json({ error: "Missing ticker." }, { status: 400 });

  try {
    const { dcf } = await getTickerFacts(symbol);
    if (!dcf.value) {
      return NextResponse.json({ error: `DCF is unavailable for ${symbol} (${dcf.note ?? "insufficient data"}).` }, { status: 404 });
    }
    return NextResponse.json({ ticker: symbol, inputs: dcf.value.inputs });
  } catch (err) {
    console.error("[stock dcf]", symbol, err);
    return NextResponse.json({ error: "Failed to build DCF inputs." }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run "src/app/api/stock/[ticker]/score" "src/app/api/stock/[ticker]/dcf"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/stock/[ticker]/score" "src/app/api/stock/[ticker]/dcf"
git commit -m "refactor(stock): score and dcf routes read the facts layer"
```

---

### Task 13: finava-analysis streams the facts score

**Files:**
- Modify: `src/app/api/stock/[ticker]/finava-analysis/route.ts`
- Test: `src/app/api/stock/[ticker]/finava-analysis/route.test.ts`

- [ ] **Step 1: Update the test to the facts contract**

In `route.test.ts`:
1. In `deps`, replace `assembleScoreInputs: vi.fn()` with `getTickerFacts: vi.fn()`.
2. Replace `vi.mock("@/lib/finavaInputs", …)` with `vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));`
3. Delete the local `inputs()` helper and import the fixture: `import { tickerFactsFixture, scoreInputs as inputs } from "@/test/factsFixture";` plus `import { fact, missing } from "@/lib/facts/types";`
4. Add a helper below `events()`:
```ts
/** Facts whose score comes from `inputs` through the real engine. */
function factsFor(over: Parameters<typeof inputs>[0] = {}) {
  const i = inputs(over);
  return tickerFactsFixture("AAPL", {
    price: fact(200, { source: "Finnhub quote", asOf: "2026-09-15T20:00:00.000Z", unit: "USD" }),
    streetTarget: fact(225, { source: "Finnhub price target", asOf: "2026-09-15T20:00:00.000Z", unit: "USD" }),
  }, i);
}
```
5. In `beforeEach`, replace `deps.assembleScoreInputs.mockResolvedValue(inputs());` with `deps.getTickerFacts.mockResolvedValue(factsFor());`
6. In "marks a pillar with no data…", replace the `assembleScoreInputs` line with:
```ts
    deps.getTickerFacts.mockResolvedValueOnce(
      factsFor({ ratingSkew: null, targetUpsidePct: null, estimateRevisionPct: null, earningsSurprisePct: null })
    );
```
7. Replace the last test with two:
```ts
  it("emits an error and persists nothing when facts fail to load", async () => {
    deps.getTickerFacts.mockRejectedValueOnce(new Error("SEC down"));
    const evs = await events(await POST(new Request("http://test.local"), ctx("AAPL")));
    expect(evs).toContainEqual({ type: "error", message: "Failed to compute the Finava Score." });
    expect(deps.saveVerdict).not.toHaveBeenCalled();
  });

  it("says so when there is not enough data to score, instead of streaming 50s", async () => {
    deps.getTickerFacts.mockResolvedValueOnce(tickerFactsFixture("AAPL", { score: missing("Finava Score v2 (15 factors)", "No factor data available for this symbol") }));
    const evs = await events(await POST(new Request("http://test.local"), ctx("AAPL")));
    expect(evs.filter((e) => e.type === "signal")).toHaveLength(0);
    expect(evs).toContainEqual({ type: "error", message: "Not enough data to compute the Finava Score for AAPL." });
  });

  it("asks facts for a fresh score on a user-requested run", async () => {
    await events(await POST(new Request("http://test.local"), ctx("AAPL")));
    expect(deps.getTickerFacts).toHaveBeenCalledWith("AAPL", { refreshDerived: true });
  });
```
Every numeric expectation in "streams all six computed pillars…" stays as it is: DCF 215 and Street 225 still blend to 220, and the peer premium is still 16.03%.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run "src/app/api/stock/[ticker]/finava-analysis"`
Expected: FAIL (route still calls `assembleScoreInputs`).

- [ ] **Step 3: Update the route**

In `route.ts`:
1. Replace the `assembleScoreInputs` / `computeFinavaScore` / `PillarScore` / `PillarKey` imports with:
```ts
import { blendFairValue } from "@/lib/finavaScore";
import { getTickerFacts } from "@/lib/facts/ticker";
import { pillarsToSignals } from "@/lib/facts/signals";
```
and drop `stanceFromScore`, `SIGNAL_ORDER`, `SignalKey` from the `@/lib/finava` import if now unused.
2. Delete the local `topFactorHeadline` and `pillarToSignal` functions.
3. Delete the `street`, `newsSentiment`, `insiderTrades` and `price` consts above the stream (the bundle stays for the 404 check and `name`).
4. Replace the body of the stream's `try {` up to (not including) `// ── Narrative` with:
```ts
        // One score everywhere: the run refreshes the facts layer's score/DCF
        // (and its global cache), then streams exactly those numbers.
        const facts = await getTickerFacts(symbol, { refreshDerived: true });
        const scored = facts.score.value;
        if (!scored) {
          send({ type: "error", message: `Not enough data to compute the Finava Score for ${symbol}.` });
          return;
        }
        const price = facts.price.value;
        const street = facts.streetTarget.value;
        const dcfFair = facts.dcf.value?.fairValue ?? null;
        const fairValue = blendFairValue({ dcf: dcfFair, street });
        const upsidePct = fairValue != null && price && price > 0 ? ((fairValue - price) / price) * 100 : null;
        const peerPremiumPct = scored.peerPremiumPct;
        const result = { score: scored.total, confidence: scored.confidence, pillars: scored.pillars };

        const signals = pillarsToSignals(scored.pillars);
        for (const signal of signals) send({ type: "signal", signal });
```
The rest of the narrative block keeps using `result.score`, `result.confidence`, `result.pillars`, `price`, `fairValue`, `dcfFair` and `street`, which all still exist. The `return` inside `try` still runs `finally { controller.close() }`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run "src/app/api/stock/[ticker]/finava-analysis"`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/stock/[ticker]/finava-analysis"
git commit -m "fix(stock): Finava analysis streams the one facts score and DCF"
```

---

### Task 14: quickContext on facts

**Files:**
- Modify: `src/lib/quickContext.ts`
- Test: `src/lib/quickContext.test.ts`

- [ ] **Step 1: Update the test to mock facts**

Replace the top of `src/lib/quickContext.test.ts` (imports, `deps`, mocks, `QUOTE`, `FINANCIALS`, `beforeEach`) with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tickerFactsFixture } from "@/test/factsFixture";
import { missing } from "@/lib/facts/types";

const deps = vi.hoisted(() => ({ getTickerFacts: vi.fn(), getCompanyNews: vi.fn() }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));
vi.mock("@/lib/finnhub", () => ({ getCompanyNews: deps.getCompanyNews }));

import { UNAVAILABLE, getQuickContext, pickTickers, renderQuickContext, type QuickContext } from "./quickContext";

function hangs<T>(): Promise<T> {
  return new Promise<T>(() => {});
}
```
Keep `NEWS` as it is. New `beforeEach`:
```ts
beforeEach(() => {
  vi.clearAllMocks();
  deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA"));
  deps.getCompanyNews.mockResolvedValue(NEWS);
});
```

Replace the `getQuickContext` describe's tests that referenced the old mocks with:

```ts
  it("returns live values with a source and an as-of for each", async () => {
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.ticker).toBe("NVDA");
    expect(qc.facts.price).toEqual({ value: "$182.50", source: "Finnhub quote", asOf: "2026-09-15T20:00:00.000Z" });
    expect(qc.facts.change.value).toBe("+1.79%");
    expect(qc.facts.marketCap.value).toBe("$4.46T");
    expect(qc.facts.peTTM.value).toBe("51.3");
    expect(qc.facts.epsTTM.value).toBe("$3.56");
    expect(qc.facts.range52w.value).toBe("$86.60–$195.60");
    expect(qc.facts.dividendYield.value).toBe("0.02%");
    expect(qc.facts.nextEarnings.value).toBe("2026-11-18 (estimated)");
  });

  it("reads the facts layer cache-only under the turn's budget", async () => {
    await getQuickContext({ tickers: ["NVDA"], budgetMs: 900 });
    expect(deps.getTickerFacts).toHaveBeenCalledWith("NVDA", { cachedOnly: true, deadlineMs: 900 });
  });

  it("carries the canonical Finava score with its as-of", async () => {
    const f = tickerFactsFixture("NVDA");
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.finavaScore).toEqual({
      value: `${f.score.value!.total} (${f.score.value!.grade})`,
      source: "Finava Score v2 (15 factors)",
      asOf: f.score.asOf,
    });
  });

  it("shows a score nobody has computed yet as Unavailable, not as dropped", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { score: missing("Finava Score v2 (15 factors)", "Not scored yet") }));
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.finavaScore.value).toBe(UNAVAILABLE);
    expect(qc.dropped).not.toContain("score");
  });

  it("returns the 5 latest dated headlines, newest first", async () => {
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.headlines).toHaveLength(5);
    expect(qc.headlines[0].headline).toBe("Nvidia lifts data-centre outlook");
  });

  it("renders a missing value as Unavailable, never a stand-in", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { marketCap: missing("x", "Needs a price and a share count"), pe: missing("x", "Loss-making") }));
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.marketCap).toEqual({ value: UNAVAILABLE, source: UNAVAILABLE, asOf: UNAVAILABLE });
    expect(qc.facts.peTTM.value).toBe(UNAVAILABLE);
  });

  it("names the sources facts dropped, in the words the prompt already uses", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { price: missing("Finnhub quote", "Not retrieved in time"), dropped: ["quote", "metric", "earnings"] }));
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(qc.facts.price.value).toBe(UNAVAILABLE);
    expect(qc.dropped).toEqual(expect.arrayContaining(["quote", "key stats", "earnings date"]));
  });

  it("returns within the budget even when every source hangs", async () => {
    deps.getTickerFacts.mockReturnValue(hangs());
    deps.getCompanyNews.mockReturnValue(hangs());
    const started = Date.now();
    const qc = await getQuickContext({ tickers: ["NVDA"], budgetMs: 120 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(qc.facts.price.value).toBe(UNAVAILABLE);
    expect(qc.headlines).toEqual([]);
    expect(qc.dropped).toEqual(expect.arrayContaining(["market data", "news"]));
  });

  it("fetches facts and news in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = <T,>(v: T) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return v;
    };
    deps.getTickerFacts.mockImplementation(slow(tickerFactsFixture("NVDA")));
    deps.getCompanyNews.mockImplementation(slow(NEWS));
    await getQuickContext({ tickers: ["NVDA"] });
    expect(peak).toBe(2);
  });

  it("skips every fetch when there is no ticker to fetch for", async () => {
    const qc = await getQuickContext({ tickers: [] });
    expect(deps.getTickerFacts).not.toHaveBeenCalled();
    expect(qc.ticker).toBeNull();
    expect(qc.facts.price.value).toBe(UNAVAILABLE);
  });
```
Delete the old "carries the Finava score with the universe's as-of", "refuses a score it cannot actually compute", "survives a source that throws" and "drops whatever misses the budget and names it" tests; the new tests above cover each case against facts.

In `renderQuickContext`, change two tests:
```ts
  it("says Unavailable rather than omitting a metric", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { nextEarnings: missing("Finnhub earnings calendar", "No earnings date in the next 120 days") }));
    const md = await rendered();
    expect(md).toMatch(new RegExp(`Next earnings.*${UNAVAILABLE}`));
  });

  it("lists what was dropped so the answer can admit the gap", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("NVDA", { dropped: ["edgar"] }));
    const qc = await getQuickContext({ tickers: ["NVDA"] });
    expect(renderQuickContext(qc)).toMatch(/filings/);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/quickContext.test.ts`
Expected: FAIL (module still imports `getQuote`/`getFactorUniverse`).

- [ ] **Step 3: Re-implement the module on facts**

In `src/lib/quickContext.ts`:
1. Replace the imports with:
```ts
import { getCompanyNews } from "@/lib/finnhub";
import { getTickerFacts } from "@/lib/facts/ticker";
import type { Fact, TickerFacts } from "@/lib/facts/types";
import { isValidTicker } from "@/lib/tickers";
import type { PageContext } from "@/lib/pageContext";
```
2. Update the file's doc comment: replace "Deliberately small: the W3-1 facts layer replaces this, …" with "Since W3-1 the numbers come from the facts layer (the same ones the stock page shows); this module only formats them for the prompt and adds headlines."
3. Remove `usdFromMillions`, `value()`, `readNextEarnings` and `readScore`. Add:
```ts
/** Map a Fact to the prompt's string triple. A missing fact is Unavailable across the row. */
function show<T>(f: Fact<T> | undefined, fmt: (v: T) => string | null): QuickValue {
  if (!f || f.value == null) return unavailable();
  const v = fmt(f.value);
  return v == null ? unavailable() : { value: v, source: f.source, asOf: f.asOf };
}

/** facts' source names → the words this prompt block has always used. */
const DROPPED_LABELS: Record<string, string> = {
  quote: "quote", metric: "key stats", edgar: "filings", earnings: "earnings date", target: "street target", derived: "score",
};

function toQuickFacts(f: TickerFacts): QuickFacts {
  return {
    price: show(f.price, (v) => usd(v)),
    change: show(f.change1d, (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`),
    marketCap: show(f.marketCap, (v) => usd(v)),
    peTTM: show(f.pe, (v) => v.toFixed(1)),
    epsTTM: show(f.epsTTM, (v) => usd(v)),
    range52w: show(f.range52w, (v) => `${usd(v.low)}–${usd(v.high)}`),
    dividendYield: show(f.dividendYield, (v) => `${v.toFixed(2)}%`),
    nextEarnings: show(f.nextEarnings, (v) => (v.estimated ? `${v.date} (estimated)` : v.date)),
    finavaScore: show(f.score, (v) => `${v.total} (${v.grade})`),
  };
}
```
4. Replace the body of `getQuickContext` after `if (!ticker) return base;` with:
```ts
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const now = new Date();
  const newsFrom = isoDay(new Date(now.getTime() - 14 * DAY_MS));

  const [facts, news] = await Promise.all([
    // cachedOnly: a fast answer never waits on a cold score assembly.
    within("market data", deadline, () => getTickerFacts(ticker, { cachedOnly: true, deadlineMs: budgetMs }), dropped),
    within("news", deadline, () => getCompanyNews(ticker, newsFrom, isoDay(now)), dropped),
  ]);

  if (facts) {
    for (const name of facts.dropped) dropped.push(DROPPED_LABELS[name] ?? name);
  }
  return {
    ...base,
    facts: facts ? toQuickFacts(facts) : emptyFacts(),
    headlines: news ? readHeadlines(news) : [],
  };
```
Exports (`UNAVAILABLE`, `DEFAULT_BUDGET_MS`, `QuickValue`, `QuickHeadline`, `FactKey`, `QuickFacts`, `QuickContext`, `QuickContextInput`, `pickTickers`, `getQuickContext`, `renderQuickContext`) are unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/quickContext.test.ts src/app/api/chat`
Expected: PASS, with the chat route tests still green (they consume the unchanged exports).

- [ ] **Step 5: Commit**

```bash
git add src/lib/quickContext.ts src/lib/quickContext.test.ts
git commit -m "refactor(chat): quick context formats the facts layer"
```

---

### Task 15: Client hooks and revalidation after a run

**Files:**
- Create: `src/hooks/useTickerFacts.ts`
- Modify: `src/hooks/useDcfInputs.ts`, `src/lib/finavaStore.ts`
- Test: `src/lib/finavaStore.test.ts`

- [ ] **Step 1: Write the failing store test**

In `src/lib/finavaStore.test.ts` add `mutate: vi.fn()` to `deps`, add `vi.mock("swr", () => ({ mutate: deps.mutate }));` below the authFetch mock, and add:

```ts
  it("revalidates the ticker's facts once a run delivers its verdict", async () => {
    deps.authFetch.mockResolvedValueOnce(
      streamResponse([`data: ${JSON.stringify({ type: "verdict", verdict: { score: 60, stance: "Neutral", confidence: "High", fairValue: null, upsidePct: null, peerPremiumPct: null, take: "t", catalysts: [], risks: [], comparison: { finava: null, street: null, dcf: null } } })}\n\n`])
    );
    await runFinava("AAPL");
    expect(deps.mutate).toHaveBeenCalledTimes(1);
    const matcher = deps.mutate.mock.calls[0][0] as (k: unknown) => boolean;
    expect(matcher("/api/facts/AAPL")).toBe(true);
    expect(matcher("/api/facts/AAPL?cachedOnly=1")).toBe(true);
    expect(matcher("/api/facts/AAPLX")).toBe(false);
    expect(matcher(`/api/facts?tickers=AAPL,MSFT`)).toBe(true);
    expect(matcher("/api/stock/AAPL/verdict")).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/finavaStore.test.ts`
Expected: FAIL, `mutate` not called.

- [ ] **Step 3: Implement**

In `src/lib/finavaStore.ts` add `import { mutate } from "swr";` and this helper above `runFinava`:

```ts
/** A run recomputes the canonical score/DCF server-side; refresh every facts read of this ticker. */
function revalidateFacts(sym: string) {
  void mutate((key: unknown) => {
    if (typeof key !== "string") return false;
    if (key === `/api/facts/${sym}` || key.startsWith(`/api/facts/${sym}?`)) return true;
    const m = key.match(/^\/api\/facts\?tickers=([^&]*)/);
    return !!m && m[1].split(",").includes(sym);
  });
}
```
In the `event.type === "verdict"` branch, after `setEntry(...)`, call `revalidateFacts(sym);`.

Create the hook:

```ts
// src/hooks/useTickerFacts.ts
"use client";
// The one client read of the facts layer. Two SWR keys: a cache-only read that
// paints fast, and the full read that computes score/DCF on a miss. Callers get
// whichever is freshest. Slim is the list-row read (cache-only, batched).
import { useMemo } from "react";
import useSWR from "swr";
import type { TickerFacts, TickerFactsSlim } from "@/lib/facts/types";

const json = (url: string) =>
  fetch(url).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
    return body;
  });

const OPTS = { revalidateOnFocus: false, shouldRetryOnError: false } as const;

export function useTickerFacts(ticker: string | null) {
  const sym = ticker ? ticker.toUpperCase() : null;
  const base = sym ? `/api/facts/${encodeURIComponent(sym)}` : null;
  const quick = useSWR<TickerFacts>(base ? `${base}?cachedOnly=1` : null, json, { ...OPTS, dedupingInterval: 60_000 });
  const full = useSWR<TickerFacts>(base, json, { ...OPTS, dedupingInterval: 300_000 });
  const data = full.data ?? quick.data;
  return {
    data,
    error: !data ? (full.error as Error | undefined) ?? (quick.error as Error | undefined) : undefined,
    isLoading: !data && (quick.isLoading || full.isLoading),
    /** The full read (score/DCF) is still running. */
    computing: !full.data && !full.error && !!base,
  };
}

export function useTickerFactsSlim(tickers: string[]) {
  const syms = useMemo(() => [...new Set(tickers.map((t) => t.toUpperCase()))].sort().slice(0, 50), [tickers]);
  const key = syms.length ? `/api/facts?tickers=${syms.join(",")}` : null;
  const r = useSWR<{ facts: TickerFactsSlim[] }>(key, json, { ...OPTS, dedupingInterval: 60_000 });
  const map = useMemo(() => new Map((r.data?.facts ?? []).map((f) => [f.ticker, f])), [r.data]);
  return { map, isLoading: r.isLoading };
}
```

Replace `src/hooks/useDcfInputs.ts` with:

```ts
"use client";
// DCF inputs for the rail and the DCF chapter, from the facts layer, so the
// sliders start from exactly the inputs behind facts.dcf. User tweaks stay local.
import { useTickerFacts } from "@/hooks/useTickerFacts";
import type { DcfInputs } from "@/lib/dcf";

export function useDcfInputs(ticker: string | null): { data: DcfInputs | undefined; error: string | undefined; isLoading: boolean; asOf: string | undefined } {
  const f = useTickerFacts(ticker);
  const dcf = f.data?.dcf;
  const pending = f.isLoading || (f.computing && !dcf?.value);
  return {
    data: dcf?.value?.inputs,
    error: pending ? undefined : dcf && !dcf.value ? dcf.note ?? "DCF is unavailable for this symbol." : f.error?.message,
    isLoading: pending,
    asOf: dcf?.asOf,
  };
}
```

- [ ] **Step 4: Run to verify**

Run: `npx vitest run src/lib/finavaStore.test.ts && npm run typecheck`
Expected: PASS; typecheck may now flag `DcfTab.tsx` / `IntelligenceRail.tsx` where the hook shape changed. Those are fixed in Task 16; if typecheck fails only there, continue.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTickerFacts.ts src/hooks/useDcfInputs.ts src/lib/finavaStore.ts src/lib/finavaStore.test.ts
git commit -m "feat(facts): client hooks and facts revalidation after a run"
```

---

### Task 16: Stock page reads facts

No unit tests (`.tsx` is outside the coverage scope by design); verification is typecheck plus the browser pass in Task 20.

**Files:**
- Modify: `src/components/stock/IntelligenceRail.tsx`, `src/components/stock/StockTabs.tsx` (OverviewTab only), `src/components/stock/FinavaTab.tsx`, `src/components/stock/DcfTab.tsx`, `src/app/stock/[ticker]/page.tsx`

- [ ] **Step 1: Intelligence rail**

In `IntelligenceRail.tsx`:
1. Remove the `jsonFetcher`, `ScoreResponse`, `FactorScores` import, the `score = useSWR(...)` call and `defaultFairValue` import. Add:
```ts
import { useTickerFacts } from "@/hooks/useTickerFacts";
import { factTitle } from "@/lib/facts/format";
import { verdictLabel } from "@/lib/finava";
```
(keep `useSWR` for the lens call).
2. Replace the deterministic-cells block with:
```ts
  const facts = useTickerFacts(sym);
  const scoreFact = facts.data?.score;
  const dcfFact = facts.data?.dcf;
  const scorePending = facts.isLoading || (facts.computing && !scoreFact?.value);
  const lens = useSWR<LensResponse>(`/api/dna/lens?ticker=${encodeURIComponent(sym)}`, authFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
```
3. Replace the fair-value derivation with:
```ts
  const fairValue = dcfFact?.value?.fairValue ?? null;
  const fvPrice = livePrice ?? facts.data?.price.value ?? null;
  const upsidePct = fairValue != null && fvPrice != null && fvPrice > 0 ? ((fairValue - fvPrice) / fvPrice) * 100 : null;
  // One stance: from the canonical score. A cached narrative can be older than the score.
  const canonicalScore = scoreFact?.value?.total ?? null;
```
4. Score cell body: replace the `score.isLoading ? … : score.data ? … : …` expression with:
```tsx
          {scorePending ? (
            <div className="skeleton" style={{ width: 72, height: 22, marginTop: 4 }} />
          ) : scoreFact?.value ? (
            <div className="serif" title={factTitle(scoreFact)} style={{ fontSize: "var(--text-display)", fontWeight: 800, color: "var(--color-text)", lineHeight: 1.15 }}>
              {scoreFact.value.total}{" "}
              <span style={{ fontSize: "var(--text-sm)", color: gradeColor(scoreFact.value.grade) }}>{scoreFact.value.grade}</span>
            </div>
          ) : (
            <div title={scoreFact ? factTitle(scoreFact) : undefined}>
              <div className="serif" style={{ fontSize: "var(--text-display)", fontWeight: 800, color: "var(--color-muted)", lineHeight: 1.15 }}>—</div>
              <div className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>{scoreFact?.note ?? "Not yet scored"}</div>
            </div>
          )}
```
and `{score.data && <span className="intel-jump">→</span>}` becomes `{scoreFact?.value && <span className="intel-jump">→</span>}`.
5. Verdict pill: replace the three `stanceFromScore(verdict.score)` calls with `stanceFromScore(canonicalScore ?? verdict.score)` and `{verdict.stance}` with `{canonicalScore != null ? verdictLabel(canonicalScore) : verdict.stance}`.
6. Fair-value cell: `dcf.isLoading` → `dcfPending` where `const dcfPending = facts.isLoading || (facts.computing && !dcfFact?.value);`, add `title={dcfFact ? factTitle(dcfFact) : undefined}` on the value `div`, and change the fallback text `Insufficient data` to `{dcfFact?.note ?? "Insufficient data"}`.

- [ ] **Step 2: Overview pillar bars**

In `StockTabs.tsx` `OverviewTab`:
1. Replace the `score = useSWR<ScoreResponse>(…/score…)` call with `const facts = useTickerFacts(ticker);` and add `import { useTickerFacts } from "@/hooks/useTickerFacts";`. Remove `ScoreResponse` and the `FACTORS` import if nothing else uses them (grep the file first).
2. Replace the "Score pillars" block with:
```tsx
          {facts.data?.score.value && (
            <div style={{ marginTop: 20 }}>
              <Rule>Score pillars</Rule>
              {facts.data.score.value.pillars.map((p) =>
                p.score == null ? (
                  <div key={p.key} className="mono" style={{ display: "flex", gap: 10, padding: "4px 0", fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>
                    <span style={{ width: 86, flexShrink: 0 }}>{p.label}</span>No data
                  </div>
                ) : (
                  <PillarRow key={p.key} label={p.label} value={p.score} />
                )
              )}
            </div>
          )}
```

- [ ] **Step 3: Finava tab**

In `FinavaTab.tsx`:
1. Add imports:
```ts
import { useTickerFacts } from "@/hooks/useTickerFacts";
import { pillarsToSignals } from "@/lib/facts/signals";
import { factTitle } from "@/lib/facts/format";
import { verdictLabel } from "@/lib/finava";
import { blendFairValue } from "@/lib/finavaScore";
```
2. At the top of the component (after the existing hooks), add:
```ts
  const facts = useTickerFacts(ticker);
  const scored = facts.data?.score.value ?? null;
  // Streaming shows the live run; otherwise the canonical facts score leads, and
  // the cached narrative is shown as written earlier.
  const canonical = !streaming && scored ? scored : null;
  const signalsShown = canonical ? pillarsToSignals(canonical.pillars) : analysis.signals;
  const orbScore = canonical?.total ?? verdict?.score ?? null;
  const orbStance = canonical ? verdictLabel(canonical.total) : verdict?.stance ?? null;
  const dcfValue = facts.data?.dcf.value?.fairValue ?? null;
  const streetValue = facts.data?.streetTarget.value ?? null;
  const blended = blendFairValue({ dcf: dcfValue, street: streetValue });
  const narrativeScoreDiffers = !!(verdict && canonical && verdict.score !== canonical.total);
```
(Place it after `streaming` is defined; if `streaming` is defined later in the function, move these lines below it.)
3. Replace every render use of `analysis.signals` (the `byKey` map, the frost ribbon, the signal bars) with `signalsShown`, and the `ringColor` computation's `verdict.score` with `orbScore` (guarding null → accent colour).
4. `<ScoreOrb score={verdict?.score ?? null} stance={verdict?.stance ?? null} …/>` → `<ScoreOrb score={orbScore} stance={orbStance} …/>`, and wrap it in `<div title={facts.data ? factTitle(facts.data.score) : undefined}>`.
5. After the take/dek paragraphs, add:
```tsx
          {narrativeScoreDiffers && age && (
            <p className="mono" style={{ margin: "6px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
              Narrative written {age} when the score was {verdict!.score}. Score now {canonical!.total}.
            </p>
          )}
```
6. Replace the three `CompareBox` lines with:
```tsx
              <CompareBox src={dcfValue != null && streetValue != null ? "Blend of DCF and Street target" : "Finava"} value={blended} price={price} highlight />
              <CompareBox src="Street" value={streetValue} price={price} />
              <CompareBox src="DCF" value={dcfValue} price={price} />
```
If `CompareBox` truncates a long `src`, shorten the label to "DCF + Street blend" and keep the full phrase in a `title`.

- [ ] **Step 4: DCF tab and page header**

In `DcfTab.tsx`: `const { data: inputs, error, isLoading } = useDcfInputs(ticker);` → `const { data: inputs, error, isLoading, asOf } = useDcfInputs(ticker);`, add `import { asOfLabel } from "@/lib/facts/format";`, and append to the footnote paragraph text: `{asOf ? ` Inputs ${asOfLabel(asOf)}.` : ""}`.

In `src/app/stock/[ticker]/page.tsx`: add `import { useTickerFacts } from "@/hooks/useTickerFacts";` and `import { factTitle } from "@/lib/facts/format";`, call `const facts = useTickerFacts(ticker || null);` next to `useQuotes`, and on the sticky-bar price `<span>` add `title={facts.data ? factTitle(facts.data.price) : undefined}`. Hooks must be called before the early returns; put the call beside the other hooks at the top of `StockPageInner`.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add src/components/stock src/app/stock
git commit -m "fix(stock): rail, Overview, Finava and DCF tabs show the one facts score and DCF"
```

---

### Task 17: Watchlist and portfolio pills; retire compositeScore

**Files:**
- Modify: `src/components/watchlist/WatchlistSplitRail.tsx`, `src/app/portfolio/page.tsx` (score source only; W3-3 owns the rest)
- Delete: `src/lib/compositeScore.ts`, `src/lib/compositeScore.test.ts`

- [ ] **Step 1: Watchlist**

In `WatchlistSplitRail.tsx`:
1. Replace `import { compositeScore } from "@/lib/compositeScore";` with `import { useTickerFactsSlim } from "@/hooks/useTickerFacts";`.
2. After `const { universe } = useFactorUniverse();` add `const slim = useTickerFactsSlim(tickers);`.
3. In the row builder replace `const sc = stock ? compositeScore(stock) : 0;` with:
```ts
    const scoreFact = slim.map.get(ticker)?.score ?? null;
    const sc = scoreFact?.value?.total ?? null;
```
and put `score: sc, scoreFact,` in the returned row. Change the sort to `.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.ticker.localeCompare(b.ticker));`.
4. In `RowData`, change `score: number` to `score: number | null` and add `scoreFact: import("@/lib/facts/types").Fact<import("@/lib/facts/types").SlimScore> | null;` (or a named type import at the top).
5. In the row cell replace `{data.f ? <ScorePill score={data.score} /> : …}` with:
```tsx
        {data.score != null
          ? <span title={data.scoreFact ? factTitle(data.scoreFact) : undefined}><ScorePill score={data.score} /></span>
          : <span className="mono" title={data.scoreFact?.note} style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>—</span>}
```
with `import { factTitle } from "@/lib/facts/format";`, and update the comment above it to `{/* Finava score — the facts layer's cached score, "—" until computed */}`.
6. Grep the file for other `.score` uses (insight summary, rail) and make them null-safe.

- [ ] **Step 2: Portfolio (one call site)**

In `src/app/portfolio/page.tsx`:
1. Replace `import { scoreForTicker } from "@/lib/compositeScore";` with `import { useTickerFactsSlim } from "@/hooks/useTickerFacts";`.
2. Next to the existing `useFactorUniverse()` call add `const slimScores = useTickerFactsSlim(holdings.map((h) => h.ticker));` (use the holdings variable name already in scope).
3. Replace `const score = scoreForTicker(universe, r.holding.ticker);` with `const score = slimScores.map.get(r.holding.ticker.toUpperCase())?.score.value?.total ?? null;`
4. If `universe` / `useFactorUniverse` is now unused in the file, remove it; otherwise leave it.
5. Update the comment `"—" until the factor universe covers this ticker` to `"—" until this ticker's Finava Score has been computed`.

- [ ] **Step 3: Remove compositeScore**

Run: `grep -rn "compositeScore\|scoreForTicker" src`
Expected: only `src/lib/compositeScore.ts` and its test. Then:

```bash
git rm src/lib/compositeScore.ts src/lib/compositeScore.test.ts
```

(The spec's `factorRank` helper would have no consumer after this task, so it is not built. Ranking stays on `composite()` / `ranked()` in `research.ts`.)

- [ ] **Step 4: Typecheck, lint, test, commit**

Run: `npm run typecheck && npm run lint && npx vitest run src/lib`
Expected: exit 0 / PASS.

```bash
git add -A src/components/watchlist src/app/portfolio/page.tsx src/lib
git commit -m "fix(lists): watchlist and portfolio pills show the facts score; retire the list-only composite"
```

---

### Task 18: Research board rows

**Files:**
- Modify: `src/components/research/BoardLeaderboard.tsx`, `LadderRow.tsx`, `ScreenMode.tsx`, `VerdictHero.tsx`

- [ ] **Step 1: A shared score cell**

In `src/components/research/primitives.tsx` add:

```tsx
import type { Fact, SlimScore } from "@/lib/facts/types";
import { factTitle } from "@/lib/facts/format";

/** The canonical Finava Score for a board row, or "—" with the reason on hover. */
export function FactScoreCell({ fact, trackClass = "b-score-track" }: { fact: Fact<SlimScore> | undefined; trackClass?: string }) {
  if (!fact?.value) {
    return (
      <span className="mono" title={fact?.note ?? "Not scored yet"} style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>—</span>
    );
  }
  const v = fact.value;
  return (
    <div title={factTitle(fact)} style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <div className={trackClass}><div style={{ width: v.total + "%", height: "100%", borderRadius: 999, background: "var(--color-accent)" }} /></div>
      <span className="serif" style={{ fontSize: "var(--text-lg)", fontWeight: 800, color: "var(--color-text)", width: 24, textAlign: "right" }}>{v.total}</span>
    </div>
  );
}
```

- [ ] **Step 2: Leaderboard**

In `BoardLeaderboard.tsx`:
1. Import `useTickerFactsSlim` and `FactScoreCell`; import `type Fact, type SlimScore` from `@/lib/facts/types`.
2. `Row` props become `{ s: RankedStock; fs: Fact<SlimScore> | undefined; onOpen }`. Replace the score `<td>` with `<td><FactScoreCell fact={fs} /></td>` and the grade `<td>` with `<td style={{ textAlign: "center" }}>{fs?.value ? <GradeBadge grade={fs.value.grade} size="sm" /> : <span style={{ color: "var(--color-muted)" }}>—</span>}</td>`.
3. In the memo comparator replace the `score`/`grade` comparisons with `prev.fs?.value?.total === next.fs?.value?.total && prev.fs?.value?.grade === next.fs?.value?.grade`.
4. In the component, after `shown` is computed: `const slim = useTickerFactsSlim(shown.map((s) => s.ticker));` and render `<Row key={s.ticker} s={s} fs={slim.map.get(s.ticker)?.score} onOpen={onOpen} />`.
5. The `#` header gets `title="Rank by factor composite for this horizon"`.

- [ ] **Step 3: Screen results**

In `LadderRow.tsx` add an `fs?: Fact<SlimScore>` prop, replace the score `<td>` with `<td><FactScoreCell fact={fs} trackClass="fbar-track" /></td>` (if `fbar-track` needs `flex: 1; height: 7`, keep those inline styles by wrapping), and the grade cell with the same `fs?.value ? <GradeBadge …/> : "—"` pattern. In `ScreenMode.tsx`, compute `const shownRows = results.slice(0, visible);` `const slim = useTickerFactsSlim(shownRows.map((s) => s.ticker));` above the JSX return (hooks before any early return), and pass `fs={slim.map.get(s.ticker)?.score}`. Leave line ~90 (the AI basket summary payload) unchanged and list it under "Found, not fixed" in the PR: it still sends the factor composite as `score` to the commentary prompt, which is W4-1's territory.

- [ ] **Step 4: Hero**

In `VerdictHero.tsx`:
1. `const slim = useTickerFactsSlim([feature.ticker]); const fs = slim.map.get(feature.ticker)?.score;`
2. Replace `<ArcGauge score={feature.score} …/>` with `{fs?.value ? <ArcGauge score={fs.value.total} size={92} stroke={10} /> : <div title={fs?.note ?? "Not scored yet"} className="serif" style={{ width: 92, height: 92, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-muted)", fontSize: "var(--text-stat)" }}>—</div>}`.
3. `<GradeBadge grade={feature.grade} size="md" />` → `{fs?.value && <GradeBadge grade={fs.value.grade} size="md" />}`.
4. The "Factor score" row becomes `<span className="b1-vk">Factor rank</span><span className="serif b1-vv">#{feature.rank}</span>`.
5. Update the component doc comment: the factor read and rank come from the universe; the score and grade come from facts.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

```bash
git add src/components/research
git commit -m "fix(research): board shows the facts score; the composite is a rank only"
```

---

### Task 19: Cross-surface consistency test

**Files:**
- Create: `src/lib/facts/consistency.test.ts`

- [ ] **Step 1: Write the test**

```ts
// src/lib/facts/consistency.test.ts
// The acceptance check: for five tickers, every loader a surface reads returns
// the same score, DCF fair value and price. Upstream vendors are mocked at the
// module boundary; everything from the facts layer up runs for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import aapl from "@/lib/__fixtures__/sec/aapl.json";
import msft from "@/lib/__fixtures__/sec/msft.json";
import cost from "@/lib/__fixtures__/sec/cost.json";
import jpm from "@/lib/__fixtures__/sec/jpm.json";
import bkng from "@/lib/__fixtures__/sec/bkng.json";
import { createFakeFirestore } from "@/test/fakeFirestore";
import { scoreInputs } from "@/test/factsFixture";

const FILINGS: Record<string, unknown> = { AAPL: aapl, MSFT: msft, COST: cost, JPM: jpm, BKNG: bkng };
const PRICES: Record<string, number> = { AAPL: 230.1, MSFT: 505.2, COST: 940.4, JPM: 301.7, BKNG: 5480.9 };
const TICKERS = Object.keys(FILINGS);

const fs = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeFirestore> | null }));
const deps = vi.hoisted(() => ({
  getQuote: vi.fn(), getBasicFinancials: vi.fn(), getEarningsCalendar: vi.fn(), getPriceTarget: vi.fn(), getCompanyNews: vi.fn(),
  getCikByTicker: vi.fn(), getCompanyFacts: vi.fn(), getStockBundle: vi.fn(), assembleScoreInputs: vi.fn(),
}));

vi.mock("@/lib/firebase-admin", () => ({ get db() { return fs.current!.db; } }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: async () => null }));
vi.mock("@/lib/llm", () => ({ generate: vi.fn() }));
vi.mock("@/agents/skills", () => ({ getSkillsPrompt: () => "" }));
vi.mock("@/lib/finnhub", () => ({
  getQuote: deps.getQuote, getBasicFinancials: deps.getBasicFinancials, getEarningsCalendar: deps.getEarningsCalendar,
  getPriceTarget: deps.getPriceTarget, getCompanyNews: deps.getCompanyNews,
}));
vi.mock("@/lib/edgar", async (orig) => ({
  ...(await orig<typeof import("@/lib/edgar")>()),
  getCikByTicker: deps.getCikByTicker, getCompanyFacts: deps.getCompanyFacts,
}));
vi.mock("@/lib/stockData", async (orig) => ({
  ...(await orig<typeof import("@/lib/stockData")>()),
  getStockBundle: deps.getStockBundle,
}));
vi.mock("@/lib/finavaInputs", async (orig) => ({
  ...(await orig<typeof import("@/lib/finavaInputs")>()),
  assembleScoreInputs: deps.assembleScoreInputs,
}));

import { GET as factsRoute } from "@/app/api/facts/[ticker]/route";
import { GET as batchRoute } from "@/app/api/facts/route";
import { GET as scoreRoute } from "@/app/api/stock/[ticker]/score/route";
import { GET as dcfRoute } from "@/app/api/stock/[ticker]/dcf/route";
import { getQuickContext } from "@/lib/quickContext";
import { getPortfolioFacts } from "./portfolio";
import { clearFactsMemo } from "./cache";
import { defaultFairValue } from "@/lib/dcf";

const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(async () => {
  vi.clearAllMocks();
  clearFactsMemo();
  fs.current = createFakeFirestore();
  deps.getQuote.mockImplementation(async (t: string) => ({
    ticker: t, price: PRICES[t], change: 1, changePct: 0.5, volume: 0, high: 0, low: 0, open: 0, prevClose: 0,
    asOf: "2026-09-15T19:59:00.000Z", asOfSource: "exchange",
  }));
  deps.getBasicFinancials.mockImplementation(async () => ({ metric: { epsTTM: 7.5, beta: 1.1, "52WeekLow": 1, "52WeekHigh": 2, marketCapitalization: 1_000_000, ebitdPerShareTTM: 10 } }));
  deps.getEarningsCalendar.mockResolvedValue({ earningsCalendar: [] });
  deps.getPriceTarget.mockResolvedValue({ targetMean: 100, numberOfAnalysts: 10 });
  deps.getCompanyNews.mockResolvedValue([]);
  deps.getCikByTicker.mockImplementation(async (t: string) => `CIK-${t}`);
  deps.getCompanyFacts.mockImplementation(async (cik: string) => FILINGS[cik.slice(4)]);
  deps.getStockBundle.mockResolvedValue({ insider: null, sentiment: { score: 55 }, profile: null });
  // Give each ticker a different score so a mix-up between tickers can't pass.
  deps.assembleScoreInputs.mockImplementation(async (t: string, price: number | null, _i: unknown, _n: unknown, _c: unknown, pre: { dcf: { dcfFair: number | null } }) =>
    scoreInputs({ price, dcfFair: pre.dcf.dcfFair, ratingSkew: (TICKERS.indexOf(t) - 2) / 3 })
  );
  const u = fs.current.db.collection("users").doc("u1");
  for (const t of TICKERS) await u.collection("holdings").doc(t).set({ ticker: t, shares: 1, avgCost: 1 });
});

describe("one set of numbers", () => {
  it.each(TICKERS)("%s: score, DCF and price agree across every loader", async (t) => {
    const full = await (await factsRoute(new Request(`http://t/api/facts/${t}`), ctx(t))).json();
    expect(full.score.value).not.toBeNull();

    const score = await (await scoreRoute(new Request("http://t"), ctx(t))).json();
    const batch = await (await batchRoute(new Request(`http://t/api/facts?tickers=${TICKERS.join(",")}`))).json();
    const qc = await getQuickContext({ tickers: [t] });
    const book = await getPortfolioFacts("u1");
    const holding = book.holdings.find((h) => h.ticker === t)!;

    // Score: facts route = score route = batch = quick context = portfolio row.
    const total = full.score.value.total;
    expect(score.score).toBe(total);
    expect(score.grade).toBe(full.score.value.grade);
    expect(batch.facts.find((f: { ticker: string }) => f.ticker === t).score.value.total).toBe(total);
    expect(qc.facts.finavaScore.value).toBe(`${total} (${full.score.value.grade})`);
    expect(holding.score.value?.total).toBe(total);

    // Price: facts route = quick context = portfolio row.
    expect(full.price.value).toBe(PRICES[t]);
    expect(holding.price.value).toBe(PRICES[t]);
    expect(qc.facts.price.value).toBe(`$${PRICES[t].toFixed(2)}`);

    // DCF: facts route fair value = what the DCF tab computes from /dcf inputs.
    const dcfRes = await dcfRoute(new Request("http://t"), ctx(t));
    if (full.dcf.value) {
      const { inputs } = await dcfRes.json();
      expect(defaultFairValue(inputs)).toBeCloseTo(full.dcf.value.fairValue, 6);
    } else {
      expect(dcfRes.status).toBe(404);
    }
  });

  it("the score is assembled once per ticker no matter how many surfaces read it", async () => {
    for (const t of TICKERS) {
      await factsRoute(new Request(`http://t/api/facts/${t}`), ctx(t));
      await scoreRoute(new Request("http://t"), ctx(t));
      await dcfRoute(new Request("http://t"), ctx(t));
    }
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(TICKERS.length);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/facts/consistency.test.ts`
Expected: PASS (6 tests). A failure here is a real inconsistency: debug the loader that disagrees with superpowers:systematic-debugging. Don't loosen the assertion.

- [ ] **Step 3: Commit**

```bash
git add src/lib/facts/consistency.test.ts
git commit -m "test(facts): five tickers read identically across every loader"
```

---

### Task 20: Full verification

- [ ] **Step 1: Gates**

Run: `npm run typecheck && npm run lint && npm test && npm run test:cov 2>&1 | tail -8`
Expected: all exit 0; coverage at or above the thresholds in `vitest.config.ts` (lines 79, statements 78, functions 80, branches 69). If a threshold drops, add tests for the uncovered facts branches (don't lower the threshold).

- [ ] **Step 2: Firestore rules/indexes check**

Run: `grep -n "factsCache" firestore.rules firestore.indexes.json 2>/dev/null; sed -n 1,40p firestore.rules 2>/dev/null`
`factsCache` is written and read only via the Admin SDK (bypasses rules) and uses single-doc gets (no index). Confirm client rules don't need a change; if `firestore.rules` denies by default, that is correct and nothing is added.

- [ ] **Step 3: Live dev server on 3011**

Before any run, confirm keys don't shadow: `env | grep -c ANTHROPIC_API_KEY` (the dev script already `env -u`s it).

Start via preview_start `{ name: "finava-w3-1" }`. If it dies on start: `rm -rf .next` and retry. Enable dev auth: in the page, `localStorage.setItem("finava_dev_auth", "1")` and reload.

Check `http://localhost:3011/api/facts/AAPL` in the browser (read_network_requests or navigate): every field has `source`/`asOf`; score has `version: "finava-score-v2"`; DCF `wacc` is not a flat 0.09 unless beta is exactly 1.

- [ ] **Step 4: AAPL on every surface, desktop and 375 px**

1. `/stock/AAPL` Overview: rail Score = `facts.score.value.total` + grade; rail Fair value = `facts.dcf.value.fairValue`. Hover shows source · as-of.
2. `/stock/AAPL?tab=finava`: the orb score equals the rail score; the DCF CompareBox equals the rail fair value; the DCF chapter's intrinsic value at default sliders equals it too.
3. `/research`: the AAPL row (use the Screen tab or search if it isn't in the top rows) shows the same score and grade.
4. `/watchlist` with AAPL added: the pill shows the same score.
For each, use read_page / get_page_text to read the numbers, then screenshot. Repeat 1 and 3 at `resize_window` preset `mobile`, then reset to `desktop`.
Check `read_console_messages` (onlyErrors) and `preview_logs` level error: no new errors.

- [ ] **Step 5: Fix anything found, re-run Step 1, commit fixes**

```bash
git add -A && git commit -m "fix(facts): <what the browser pass found>"
```
(skip if nothing was found)

---

### Task 21: Pull request

- [ ] **Step 1: Push and open**

```bash
git push -u origin feat/w3-1-facts-layer
```

PR title: `feat(facts): one facts layer — one score, one DCF, sourced and dated`

Body sections (README rule 10):
- **What changed**: facts module, routes, hooks, migrated surfaces, compositeScore retired.
- **Readout issues addressed**: 30 testers saw conflicting or retracted numbers; AAPL 45 (D+) rail vs 58 Finava tab; two DCF values from different WACCs; stale prices without as-of.
- **Verification**: test files and counts, the consistency test, gate output, screenshots (rail, Finava tab, Research board, watchlist; desktop + 375 px).
- **Shared-file touches**: `src/app/portfolio/page.tsx` (score source only, W3-3 owns the file); `src/lib/finavaStore.ts` (facts revalidation); `src/lib/finavaInputs.ts` shares switched to the cover-page count (W2-4's split-safe extractor), called not changed; no `edgar.ts`/`factors.ts` changes.
- **Deviations from spec**: `TickerFactsSlim` carries score only (list prices stay on their live feeds; a 50-ticker quote fan-out would burst the Finnhub limit); `factorRank` not built (no consumer); `ScoreFact.peerPremiumPct` added for the Finava verdict card.
- **Found, not fixed**: ScreenMode basket-commentary payload and `buildResearchSnapshot` still pass the factor composite as `score` to AI prompts (W4-1); VerdictHero's "Factor read" stance still comes from the composite (labelled as such).
- **Follow-ups**: nightly warm-up of the S&P 500 score cache so board rows fill without visits.
- End with the Claude Code attribution line.

Use `mcp__ccd_pr__*` tools to watch CI after opening; don't enable auto-merge.
