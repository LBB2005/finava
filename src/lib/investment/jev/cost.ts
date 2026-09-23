// What a Jev call costs, and the ceilings a research run may not cross.
//
// Jev is the one provider in this feature whose price we have actually verified
// rather than estimated, so this module is deliberately narrow: a price table, a
// per-call cost, and a ledger with caps. It does NOT reuse `usage.ts`'s credit
// arithmetic, because that module's rates are documented placeholders and its
// fallback assumes the most expensive tier — a reasonable choice for metering a
// user's allowance, and the wrong one here, where we want to know the real number.
//
// The rule that shapes everything below: AN UNKNOWN RATE PRODUCES A NULL COST,
// NEVER ZERO. A zero is indistinguishable from "this call was free", so a model
// we forgot to price would silently consume an unbounded budget while every cap
// read $0.00 and every report claimed it cost nothing to produce. Null is
// contagious for the same reason — a total computed from some of the calls, shown
// as the total, understates spend by exactly the part we could not price.
//
// Note that zero is still a legal RATE. Jev charges nothing for output tokens, and
// that is a verified fact about the rate card, not a missing entry. The two cases
// are what `null` versus `0` distinguishes here, and conflating them is the bug
// this file exists to prevent.
//
// Because the cost may be unknown, the request and token caps are enforced
// independently of it. A run that cannot be priced is still bounded.

import type { JevResponse } from "./schemas";

/**
 * The usage block as the transport reports it. Derived from `JevResponse` rather
 * than redeclared, so a change to the vendor contract breaks the build here
 * instead of quietly pricing a field that no longer exists.
 */
export type JevUsage = JevResponse["usage"];

/** USD per token. Both fields are rates, so 0 means free, not unmeasured. */
export interface JevTokenRate {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
}

export type JevPriceTable = Readonly<Record<string, JevTokenRate>>;

/**
 * Verified on 2026-09-22 for Jev on Vercel AI Gateway: $0.000000042 per input
 * token — $0.042 per million — and nothing at all for output tokens.
 *
 * Kept as a per-token figure rather than a per-million one divided at the call
 * site, so the number in the code is the number that was verified.
 */
export const JEV_INPUT_USD_PER_TOKEN = 0.000000042;
export const JEV_OUTPUT_USD_PER_TOKEN = 0;

const VERIFIED_JEV_RATE: JevTokenRate = {
  inputUsdPerToken: JEV_INPUT_USD_PER_TOKEN,
  outputUsdPerToken: JEV_OUTPUT_USD_PER_TOKEN,
};

/**
 * Configurable, and keyed by model because a rate belongs to a model and not to a
 * vendor. `jev-latest` is the alias we request; `jev-1` covers the dated versions
 * the vendor resolves it to (see `rateFor`).
 */
export const JEV_PRICE_TABLE: JevPriceTable = {
  "jev-latest": VERIFIED_JEV_RATE,
  "jev-1": VERIFIED_JEV_RATE,
};

/**
 * The rate for a model, or null when we have not verified one.
 *
 * Exact match first. Failing that, the MAJOR-VERSION family: the vendor resolves
 * `jev-latest` to a dated build such as `jev-1.13.0`, and we cannot enumerate
 * builds that do not exist yet, so `jev-1.13.0` falls back to the `jev-1` entry.
 * The fallback deliberately stops at the major version — `jev-2.0.0` finds
 * nothing and is priced as unknown, because a new major version is a new rate
 * card that nobody here has read. That is the intended failure: a null cost is
 * visible in the report and in the logs, and it is the signal to go and verify.
 */
export function rateFor(model: string, table: JevPriceTable = JEV_PRICE_TABLE): JevTokenRate | null {
  const exact = table[model];
  if (exact) return exact;

  const family = /^(.+?)-(\d+)(?:[.-].*)?$/.exec(model);
  if (family) {
    const candidate = `${family[1]}-${family[2]}`;
    const byFamily = table[candidate];
    if (byFamily) return byFamily;
  }
  return null;
}

/**
 * USD for one call, or null when the model has no verified rate.
 *
 * Not rounded. Rounding belongs in presentation; a sum of rounded fractions of a
 * cent drifts, and these calls are individually worth thousandths of a cent.
 */
export function jevCallCostUsd(
  model: string,
  usage: JevUsage,
  table: JevPriceTable = JEV_PRICE_TABLE
): number | null {
  const rate = rateFor(model, table);
  if (!rate) return null;
  return usage.input_tokens * rate.inputUsdPerToken + usage.output_tokens * rate.outputUsdPerToken;
}

// ── Caps and the ledger ──────────────────────────────────────────────────────

/**
 * What one research run may spend on Jev.
 *
 * Both token and request caps exist because they fail differently: the request
 * cap bounds a screen that fans out over a large universe, and the token cap
 * bounds a single candidate whose evidence bundle grew. `maxUsd` is the cap that
 * can become unenforceable, which is exactly why it is not the only one.
 */
export interface JevSpendCaps {
  /** Hard ceiling on calls. Reserved before a call, not counted after it. */
  maxCalls: number;
  /** Input tokens are the only tokens Jev charges for, so the only ones capped. */
  maxInputTokens: number;
  /** Null when no dollar cap applies. Unenforceable while any cost is unknown. */
  maxUsd: number | null;
}

/**
 * Defaults sized for one analyze run: a first pass and up to two second-pass
 * calls per candidate, with headroom for a handful of candidates. These are
 * product choices, not measured optima — a screen over a wide universe is
 * expected to pass its own, larger caps.
 */
export const JEV_DEFAULT_CAPS: JevSpendCaps = {
  maxCalls: 24,
  maxInputTokens: 500_000,
  maxUsd: 0.05,
};

export interface JevLedger {
  /** Calls reserved, which is calls that were or are about to be sent. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Null once ANY recorded call had no verified rate. Never a partial total. */
  usd: number | null;
  /** The models that made `usd` null, so the log names what to go and price. */
  unpricedModels: string[];
}

export function emptyJevLedger(): JevLedger {
  return { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0, unpricedModels: [] };
}

export type JevSpendDecision = { ok: true } | { ok: false; reason: string };

/**
 * Whether one more call fits under the caps.
 *
 * The dollar cap is skipped — not failed — while `usd` is null, and the token and
 * request caps carry the run on their own. Failing closed on an unknown cost
 * would turn a missing price-table entry into a total outage of the feature;
 * failing open on all three would turn it into an unbounded bill. Bounding what
 * we can still measure is the only option that is neither.
 */
export function jevSpendAllowed(ledger: JevLedger, caps: JevSpendCaps): JevSpendDecision {
  if (ledger.calls >= caps.maxCalls) {
    return { ok: false, reason: `Jev request cap reached (${ledger.calls}/${caps.maxCalls} calls)` };
  }
  if (ledger.inputTokens >= caps.maxInputTokens) {
    return {
      ok: false,
      reason: `Jev input-token cap reached (${ledger.inputTokens}/${caps.maxInputTokens})`,
    };
  }
  if (caps.maxUsd != null && ledger.usd != null && ledger.usd >= caps.maxUsd) {
    return {
      ok: false,
      reason: `Jev spend cap reached ($${ledger.usd.toFixed(6)}/$${caps.maxUsd.toFixed(6)})`,
    };
  }
  return { ok: true };
}

/**
 * A run's spend, as a small object rather than threaded totals.
 *
 * `reserve()` increments the call count BEFORE the request is sent. Candidates are
 * assessed concurrently, so a check that only counted completed calls would let
 * every in-flight worker see room for the last one and overshoot the cap by the
 * width of the pool.
 */
export interface JevBudget {
  readonly caps: JevSpendCaps;
  /** A snapshot. Mutating the returned object does not change the budget. */
  ledger(): JevLedger;
  /** Claims one call slot, or refuses with the cap that blocked it. */
  reserve(): JevSpendDecision;
  /** Records what a completed call actually used. Cost may be unknown. */
  record(model: string, usage: JevUsage): void;
}

export function createJevBudget(
  caps: JevSpendCaps = JEV_DEFAULT_CAPS,
  table: JevPriceTable = JEV_PRICE_TABLE
): JevBudget {
  const state = emptyJevLedger();

  return {
    caps,
    ledger: () => ({ ...state, unpricedModels: [...state.unpricedModels] }),
    reserve() {
      const decision = jevSpendAllowed(state, caps);
      if (decision.ok) state.calls += 1;
      return decision;
    },
    record(model, usage) {
      state.inputTokens += usage.input_tokens;
      state.outputTokens += usage.output_tokens;
      const cost = jevCallCostUsd(model, usage, table);
      if (cost == null) {
        // Once unknown, permanently unknown: a total that omits this call is not
        // this run's total, and presenting it as one is the lie the caps exist to
        // prevent.
        state.usd = null;
        if (!state.unpricedModels.includes(model)) state.unpricedModels.push(model);
        return;
      }
      if (state.usd != null) state.usd += cost;
    },
  };
}
