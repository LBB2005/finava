/**
 * Per-user AI usage metering.
 *
 * Every model call is converted from raw tokens → a normalized, cost-weighted
 * "credit" (so a heavy Claude chat counts more than a cheap Gemini screen), then
 * accumulated into a single Firestore doc per user (`userUsage/{userId}`). The
 * doc holds a date→credits map; daily and weekly figures are derived from it.
 *
 * Two things plug into this:
 *   - recordUsage(): called from the LLM choke-point (`generate()`) and the
 *     direct-Anthropic streaming paths to ADD usage. It reads the current userId
 *     from an AsyncLocalStorage store, so the ~27 `generate()` call-sites don't
 *     need a userId threaded through them — each AI route wraps its handler body
 *     in `usageStore.run({ userId }, …)`.
 *   - checkUsageLimit(): called at the top of each AI route to ENFORCE the plan
 *     allowance (hard cap) before any model spend happens.
 *
 * ⚠️ TUNE BEFORE SHIPPING — these are product/billing constants set to placeholder
 * values. Getting them wrong mis-charges every user's allowance. Before charging
 * real money, verify against live provider rate cards:
 *   1. MODEL_PRICING     — per-1M-token input/output USD for EVERY slug/id the app
 *                          actually routes to (both the OpenRouter slugs and the
 *                          direct Anthropic ids below); add any missing model so it
 *                          doesn't silently hit FALLBACK_PRICE.
 *   2. CREDIT_USD         — the USD value of one displayed credit.
 *   3. CACHE_READ_MULTIPLIER — the provider's cached-input discount.
 *   4. Plan allowances    — daily/weekly/monthly caps live in `@/lib/plans`.
 */
import * as admin from "firebase-admin";
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { resolvePlan } from "@/lib/entitlements";
import {
  CREDIT_USD,
  jsonLimit,
  nextPaidPlan,
  TRIAL_DEEP_RESEARCH_CAP,
  type RunLane,
} from "@/lib/plans";
import { logger } from "@/lib/logger";

const log = logger("usage");

// ── Request-scoped run context ───────────────────────────────────────────────
// The AsyncLocalStorage store lives in the dependency-light `runContext` module
// so the route wrapper and logger can enter/read it without importing this heavy
// (Firestore-backed) file. Re-exported here for the existing metering call-sites.
import {
  usageStore,
  makeRunContext,
  newRequestId,
  currentRunCredits,
  currentLane,
  attributeCall,
  type RunContext,
} from "@/lib/runContext";
export { usageStore, makeRunContext, newRequestId, currentRunCredits, currentLane };
export type { RunContext };

/** Run `fn` inside a fresh run context (userId/requestId/lane/credits in scope). */
export function withUsageContext<T>(
  userId: string,
  fn: () => T,
  requestId?: string,
  lane?: RunLane
): T {
  return usageStore.run(makeRunContext(userId, requestId, lane), fn);
}

// ── Pricing ──────────────────────────────────────────────────────────────────
// USD per 1M tokens. Keyed by BOTH the OpenRouter slugs `generate()` uses and the
// direct Anthropic model ids the streaming chat/CEO paths use.
// ⚠️ Placeholder rates — TUNE to live provider rate cards before billing (see header).
interface Price {
  in: number;
  out: number;
}
const MODEL_PRICING: Record<string, Price> = {
  // OpenRouter slugs (src/lib/llm.ts)
  "anthropic/claude-sonnet-4.6": { in: 3, out: 15 },
  "anthropic/claude-haiku-4.5": { in: 1, out: 5 },
  "openai/gpt-5.5": { in: 5, out: 30 },
  "x-ai/grok-4.3": { in: 1.25, out: 2.5 },
  "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  // Direct Anthropic ids (src/lib/anthropic.ts)
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  // Legacy dated Haiku id — keep priced in case any stored/queued call still uses it.
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};
// Fallback for an unrecognized model — assume the most expensive tier so we never
// under-charge a user's allowance for a model we forgot to price.
const FALLBACK_PRICE: Price = { in: 3, out: 15 };

// The USD value of one credit lives with the rest of the pricing data in
// `@/lib/plans`; re-exported here for the metering call-sites that already
// import from this module.
export { CREDIT_USD };
// Anthropic prompt-cache pricing relative to fresh input: a cache READ costs
// ~10%, a cache WRITE (5-minute TTL, the only kind this app requests) 125%.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

function priceFor(model: string): Price {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Tolerate slug/id drift (e.g. an "anthropic/" prefix or a date suffix).
  const stripped = model.replace(/^anthropic\//, "");
  for (const key of Object.keys(MODEL_PRICING)) {
    if (key.replace(/^anthropic\//, "") === stripped) return MODEL_PRICING[key];
  }
  console.warn(`[usage] no price for model "${model}" — using fallback`);
  return FALLBACK_PRICE;
}

/**
 * Convert a single call's token counts into cost-weighted credits.
 *
 * Counts follow ANTHROPIC's convention: `inputTokens` is fresh (uncached) input
 * only, and cache reads/writes are reported separately — they are NOT inside
 * `inputTokens`, so nothing is subtracted. (The old code subtracted cache reads
 * from it, so a turn with a big cached prompt metered ~0 input, and cache writes
 * weren't metered at all — a client could park ~190K tokens of its own text in
 * the cached system prompt and be charged for a one-word answer.) A caller with
 * an OpenAI-style `prompt_tokens`, which already INCLUDES cached tokens, passes
 * it as `inputTokens` and omits the cache fields: that bills cached tokens at the
 * full rate — over-metering, never under-metering.
 */
export function creditsFor(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): number {
  const p = priceFor(model);
  const usd =
    (inputTokens * p.in +
      cacheReadTokens * p.in * CACHE_READ_MULTIPLIER +
      cacheWriteTokens * p.in * CACHE_WRITE_MULTIPLIER +
      outputTokens * p.out) /
    1_000_000;
  return Math.round((usd / CREDIT_USD) * 100) / 100;
}

// ── Plan allowances ──────────────────────────────────────────────────────────
// Credit caps (daily / weekly / monthly) and Deep Research caps now live in the
// single source of truth `@/lib/plans` and are resolved per-user through
// `resolvePlan()` (which honors subscription, trial, and admin/dev access).

// ── Date helpers (UTC buckets) ───────────────────────────────────────────────
const MS_PER_DAY = 86_400_000;
/** UTC date key, e.g. "2026-06-09". */
function dayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
/** UTC month key, e.g. "2026-06". */
function monthKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}
function sumLastNDays(days: Record<string, number>, n: number): number {
  const now = Date.now();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += days[dayKey(new Date(now - i * MS_PER_DAY))] ?? 0;
  }
  return Math.round(sum * 100) / 100;
}
/** Sum credits for the current calendar month from the day-keyed map. */
function sumCurrentMonth(days: Record<string, number>): number {
  const mk = monthKey();
  let sum = 0;
  for (const [k, v] of Object.entries(days)) {
    if (k.startsWith(mk)) sum += v;
  }
  return Math.round(sum * 100) / 100;
}

interface UsageDoc {
  days?: Record<string, number>;
  totalCredits?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  updatedAt?: string;
  /** Month-keyed Deep Research run counts, e.g. { "2026-06": 12 }. */
  deepRuns?: Record<string, number>;
  /** Lifetime Deep Research runs consumed during the no-card trial. */
  trialDeepRuns?: number;
}

// ── Recording ────────────────────────────────────────────────────────────────
export interface RecordUsageInput {
  /** Routable agent name, for debugging/logging only. */
  agent?: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Anthropic cache_read_input_tokens, if any (billed at a fraction of input). */
  cacheRead?: number | null;
  /** Anthropic cache_creation_input_tokens, if any (billed at a premium over input). */
  cacheWrite?: number | null;
  /** Explicit userId; falls back to the AsyncLocalStorage store when omitted. */
  userId?: string;
  /**
   * Fixed credit amount to charge, bypassing the token→credit math. Use for
   * providers that don't return token counts (e.g. Perplexity/Sonar), where we
   * record an estimated per-call cost instead.
   */
  flatCredits?: number | null;
}

/**
 * Add one model call's usage to the user's running totals. Fire-and-forget: it
 * returns the Firestore write promise (so a caller may await the big captures),
 * but it never throws — a metering failure must never break a user's request.
 * No-ops when there is no userId in scope (e.g. unauthenticated/cron calls).
 */
export function recordUsage(input: RecordUsageInput): Promise<void> {
  const userId = input.userId ?? usageStore.getStore()?.userId;
  if (!userId) return Promise.resolve();

  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const cacheRead = input.cacheRead ?? 0;
  const cacheWrite = input.cacheWrite ?? 0;
  const flat = input.flatCredits ?? 0;
  if (inputTokens <= 0 && outputTokens <= 0 && cacheRead <= 0 && cacheWrite <= 0 && flat <= 0) {
    return Promise.resolve();
  }

  const credits =
    flat > 0
      ? flat
      : creditsFor(input.model, inputTokens, outputTokens, cacheRead, cacheWrite);

  // Attribute the call to the run in scope: the running total is what lets a long
  // crew abort before it blows its per-run cap, and the per-call entry is what
  // the run_cost report breaks down. Hooked HERE (the single metering
  // choke-point) so it catches both awaited (pendingWrites) and fire-and-forget
  // recordUsage paths, and every paid provider that reports a flat cost.
  attributeCall({
    agent: input.agent,
    model: input.model,
    credits,
    inputTokens,
    outputTokens,
  });

  const key = dayKey();
  const inc = admin.firestore.FieldValue.increment;

  return db
    .collection("userUsage")
    .doc(userId)
    .set(
      {
        days: { [key]: inc(credits) },
        totalCredits: inc(credits),
        totalInputTokens: inc(inputTokens),
        totalOutputTokens: inc(outputTokens),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    )
    .then(() => undefined)
    .catch((e) => {
      console.error("[usage] record failed:", e);
    });
}

// ── Enforcement ──────────────────────────────────────────────────────────────
/**
 * Hard cap. Returns a 429 NextResponse when the user is already at/over their
 * daily or weekly allowance, or null when they're clear to proceed. Call this
 * right after requireAuth() in every route that initiates model spend.
 */
export async function checkUsageLimit(
  userId: string
): Promise<NextResponse | null> {
  const ent = await resolvePlan(userId);
  // Degraded read (plan couldn't be resolved): tier is unknown, so fail OPEN to
  // avoid locking out paying users on a Firestore blip. The per-run cost cap
  // (ceo.ts) still bounds each run; logged so sustained degradation is visible.
  if (ent.degraded) {
    log.warn("entitlement degraded — allowing request (fail-open)", { userId });
    return null;
  }
  // Admin/dev access is uncapped — usage is still recorded, never blocked.
  if (ent.source === "admin" || ent.source === "dev") return null;
  const limits = ent.config;

  let days: Record<string, number> = {};
  try {
    const usageSnap = await db.collection("userUsage").doc(userId).get();
    days = ((usageSnap.data() as UsageDoc | undefined)?.days ?? {}) as Record<
      string,
      number
    >;
  } catch (e) {
    // Tier-based fail policy on a usage-read error: don't lock out paying users on
    // a Firestore blip, but bound COGS for free/anon by failing CLOSED (503).
    const paid = ent.source === "subscription" || ent.source === "trial";
    if (paid) {
      log.warn("usage read failed — allowing paid user (fail-open)", {
        userId,
        plan: ent.plan,
        err: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
    log.warn("usage read failed — soft-blocking free/anon (fail-closed)", { userId });
    return NextResponse.json(
      {
        error: "usage_unavailable",
        message: "Usage check is temporarily unavailable. Please retry shortly.",
      },
      { status: 503 }
    );
  }

  const today = days[dayKey()] ?? 0;
  const week = sumLastNDays(days, 7);
  const month = sumCurrentMonth(days);

  const over =
    today >= limits.daily
      ? { scope: "daily" as const, limit: limits.daily, used: today }
      : week >= limits.weekly
      ? { scope: "weekly" as const, limit: limits.weekly, used: week }
      : month >= limits.monthly
      ? { scope: "monthly" as const, limit: limits.monthly, used: month }
      : null;
  if (!over) return null;

  return NextResponse.json(
    {
      error: "limit_reached",
      scope: over.scope,
      used: over.used,
      limit: over.limit,
      plan: ent.plan,
      upgradeTo: nextPaidPlan(ent.plan),
      resetsAt:
        over.scope === "daily"
          ? nextUtcMidnight()
          : over.scope === "monthly"
          ? nextUtcMonthStart()
          : "rolling",
    },
    { status: 429 }
  );
}

function nextUtcMidnight(): string {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  ).toISOString();
}

function nextUtcMonthStart(): string {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  ).toISOString();
}

// ── Deep Research run enforcement ─────────────────────────────────────────────
// Deep Research is the one explicitly-counted expensive op. Beyond the credit
// caps above, each plan has a monthly RUN allowance; the no-card trial has its
// own lifetime cap.

function deepResearchLimitResponse(
  ent: Awaited<ReturnType<typeof resolvePlan>>,
  scope: "trial" | "monthly",
  used: number,
  limit: number
): NextResponse {
  return NextResponse.json(
    {
      error: "deep_research_limit",
      scope,
      used,
      limit,
      plan: ent.plan,
      upgradeTo: nextPaidPlan(ent.plan),
      ...(scope === "monthly" ? { resetsAt: nextUtcMonthStart() } : {}),
    },
    { status: 429 }
  );
}

/**
 * Check AND count one Deep Research run, atomically. Returns a 429 when the
 * allowance is spent; otherwise the run is counted and null is returned.
 *
 * One Firestore transaction (read the count, write count+1) so a burst of
 * concurrent requests can't all read the same "used" and slip past the cap —
 * the old check followed by a fire-and-forget increment let a Free user's
 * four-request burst start four deep runs against a one-run month. Counted at
 * START, not completion: a failed run still counts, an accepted anti-abuse
 * trade-off. Fails OPEN (like the credit cap) on a degraded plan read or a
 * Firestore error — the per-run cost cap still bounds each run.
 */
export async function reserveDeepResearchRun(
  userId: string
): Promise<NextResponse | null> {
  const ent = await resolvePlan(userId);
  const ref = db.collection("userUsage").doc(userId);
  const mk = monthKey();
  const updatedAt = new Date().toISOString();

  if (ent.degraded) {
    // Tier unknown: allow, but still count the month bucket (best-effort).
    await ref
      .set({ deepRuns: { [mk]: admin.firestore.FieldValue.increment(1) }, updatedAt }, { merge: true })
      .catch((e) => console.error("[usage] deep-run record failed:", e));
    return null;
  }

  const trial = ent.source === "trial";
  const limit = trial ? TRIAL_DEEP_RESEARCH_CAP : ent.config.deepResearchPerMonth;
  try {
    return await db.runTransaction(async (tx) => {
      const doc = (await tx.get(ref)).data() as UsageDoc | undefined;
      const monthUsed = doc?.deepRuns?.[mk] ?? 0;
      const used = trial ? doc?.trialDeepRuns ?? 0 : monthUsed;
      if (Number.isFinite(limit) && used >= limit) {
        return deepResearchLimitResponse(ent, trial ? "trial" : "monthly", used, limit);
      }
      // Absolute values we just read, inside the transaction — set-with-merge
      // deep-merges the month map, so other months' counts are untouched.
      const patch: Record<string, unknown> = { deepRuns: { [mk]: monthUsed + 1 }, updatedAt };
      if (trial) patch.trialDeepRuns = (doc?.trialDeepRuns ?? 0) + 1;
      tx.set(ref, patch, { merge: true });
      return null;
    });
  } catch (e) {
    console.error("[usage] deep-research reservation failed (allowing):", e);
    return null;
  }
}

// ── Summary for the UI ───────────────────────────────────────────────────────
export interface UsageSummary {
  plan: string;
  /** Where the effective plan comes from — lets the UI show a trial badge. */
  source: string;
  trialEndsAt: string | null;
  /** `limit: null` means unlimited ("fair use"). */
  daily: { used: number; limit: number | null; pct: number };
  weekly: { used: number; limit: number | null; pct: number };
  monthly: { used: number; limit: number | null; pct: number };
  /** Deep Research runs used vs allowed this period (limit null = unlimited). */
  deepResearch: { used: number; limit: number | null };
  /** Last 30 UTC days, ascending — drives the sparkline + Settings chart. */
  series: { date: string; credits: number }[];
  resets: { daily: string; weekly: string; monthly: string };
}

function pct(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export async function getUsageSummary(userId: string): Promise<UsageSummary> {
  const ent = await resolvePlan(userId);
  // Admin/dev access has no credit caps — surface unlimited to the UI.
  const uncapped = ent.source === "admin" || ent.source === "dev";
  const limits = uncapped
    ? { ...ent.config, daily: Infinity, weekly: Infinity, monthly: Infinity }
    : ent.config;

  const usageSnap = await db.collection("userUsage").doc(userId).get();
  const data = usageSnap.data() as UsageDoc | undefined;
  const days = (data?.days ?? {}) as Record<string, number>;

  const today = Math.round((days[dayKey()] ?? 0) * 100) / 100;
  const week = sumLastNDays(days, 7);
  const month = sumCurrentMonth(days);

  // Deep Research usage for the current period (trial → lifetime trial counter).
  const deepUsed =
    ent.source === "trial"
      ? data?.trialDeepRuns ?? 0
      : data?.deepRuns?.[monthKey()] ?? 0;
  const deepLimit =
    ent.source === "trial" ? TRIAL_DEEP_RESEARCH_CAP : limits.deepResearchPerMonth;

  const now = Date.now();
  const series: { date: string; credits: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const key = dayKey(new Date(now - i * MS_PER_DAY));
    series.push({ date: key, credits: Math.round((days[key] ?? 0) * 100) / 100 });
  }

  // Best-effort prune: drop day-buckets older than 35 days so the doc stays small.
  void pruneOldDays(userId, days, now);

  return {
    plan: ent.plan,
    source: ent.source,
    trialEndsAt: ent.trialEndsAt,
    daily: { used: today, limit: jsonLimit(limits.daily), pct: pct(today, limits.daily) },
    weekly: { used: week, limit: jsonLimit(limits.weekly), pct: pct(week, limits.weekly) },
    monthly: { used: month, limit: jsonLimit(limits.monthly), pct: pct(month, limits.monthly) },
    deepResearch: { used: deepUsed, limit: jsonLimit(deepLimit) },
    series,
    resets: {
      daily: nextUtcMidnight(),
      weekly: "rolling",
      monthly: nextUtcMonthStart(),
    },
  };
}

function pruneOldDays(
  userId: string,
  days: Record<string, number>,
  now: number
): Promise<void> {
  const cutoff = dayKey(new Date(now - 35 * MS_PER_DAY));
  const stale = Object.keys(days).filter((k) => k < cutoff);
  if (stale.length === 0) return Promise.resolve();
  const del = admin.firestore.FieldValue.delete();
  const patch: Record<string, unknown> = {};
  for (const k of stale) patch[`days.${k}`] = del;
  return db
    .collection("userUsage")
    .doc(userId)
    .update(patch)
    .then(() => undefined)
    .catch((e) => console.error("[usage] prune failed:", e));
}
