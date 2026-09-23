// Valuation input validation — the gate every valuation method passes through.
//
// The module's job is to answer one question honestly: do we have what this
// method needs? It returns either a set of typed, non-null inputs the arithmetic
// in ./valuation can consume without another null check, or a `blocked` outcome
// that NAMES what was missing, wrong, or unsupported.
//
// The load-bearing property is that a missing input is never replaced. Not with
// zero, not with one, not with a sector median. The precedent this file is
// written against is `src/lib/dcf.ts`, where `enterpriseValue - (netDebt ?? 0)`
// published a fair value as if a company with unreadable filings had no debt —
// and because net debt was assembled as `(totalDebt ?? 0) - (cash ?? 0)`, a
// filing with cash but no debt figure produced phantom NET CASH. The companies
// whose filings are thinnest were the ones whose fair values were inflated most.
// That bug was not a rounding error; it was a fabricated number wearing the
// visual authority of a computed one. Every rule below exists to keep that class
// of defect out.
//
// The same discipline as `src/lib/live/mandate.ts`: MISSING DATA BLOCKS. A rail
// that passes when it cannot see is not a rail, and a valuation that runs when it
// cannot see its inputs is not a valuation.
//
// A second rule, from the same source: INVALID RELATIONSHIPS ARE REFUSED, NOT
// CLAMPED. `dcf.ts` used to clamp a terminal growth rate above WACC down to
// `wacc - 0.005`, which produced an enormous terminal value that looked precise
// and was arbitrary. We now reject the assumption and say which one it was, so
// the caller fixes the input rather than reading a number nobody chose.

import { z } from "zod";
import { ValuationGapSchema, ValuationOutcomeSchema, type ValuationOutcome } from "./contracts";
import { ScenarioIdSchema, type ValuationMethod } from "./schemas";

export type ValuationGap = z.infer<typeof ValuationGapSchema>;

/**
 * Semantics version, stamped onto every ValuationOutcome and carried in the
 * decision cache key (see `DecisionCacheKey.valuationVersion`).
 *
 * Bump it whenever the MEANING of a number this module produces changes — a new
 * required input, a different cash-flow basis, a changed realisation model. A
 * stored report computed under different semantics is not a cache hit, it is a
 * different answer, and reusing it would silently re-rate yesterday's stocks
 * under today's rules.
 */
export const VALUATION_VERSION = "valuation-v1-2026-09-22";

// ── What kind of business this is ────────────────────────────────────────────

/**
 * The structural shape of the issuer, which decides whether a method means
 * anything at all.
 *
 * This is not a sector label for display. It is the reason a method is or is not
 * applicable: for a bank, debt is raw material rather than financing, so
 * "enterprise value less net debt" has no interpretation; an insurer's float is
 * the same problem; a REIT's earnings are depressed by depreciation on assets
 * that are appreciating, so a P/E is not comparable to an operating company's.
 * A loss-making company has no positive earnings to put a multiple on — and a
 * negative EPS times a positive exit multiple is a negative share price, which
 * is not a conservative estimate, it is nonsense.
 */
export const BusinessTypeSchema = z.enum([
  "operating",
  "bank",
  "insurer",
  "reit",
  "fund",
  "loss_making",
]);
export type BusinessType = z.infer<typeof BusinessTypeSchema>;

/**
 * Business types for which the three FUNDAMENTAL methods (forward multiple and
 * both DCF flavours) are refused outright.
 *
 * `historical_range` is deliberately exempt, and the reason is worth stating
 * because it is the one place this file allows a method through on an
 * "unsupported" issuer: an empirical range of realised total returns over past
 * windows makes no structural claim about the business's cash flows. It
 * describes how the security has actually behaved. A bank has a return history
 * exactly as an operating company does. What the exemption does NOT license is
 * an earnings or cash-flow model on a balance sheet whose debt is inventory.
 */
export const UNSUPPORTED_FUNDAMENTAL_BUSINESS_TYPES: readonly BusinessType[] = [
  "bank",
  "insurer",
  "reit",
  "fund",
  "loss_making",
] as const;

// ── Cash-flow basis ─────────────────────────────────────────────────────────

/**
 * What the DCF's base cash flow actually IS. The single most misrepresented
 * quantity in retail valuation tooling.
 *
 *  - `fcff`            free cash flow to the firm, built properly: after-tax
 *                      operating profit, plus non-cash charges, less capex, less
 *                      the change in working capital, with no financing flows.
 *                      Discounts at WACC and bridges to equity via net debt.
 *  - `fcfe`            free cash flow to equity: after interest and after net
 *                      borrowing. Discounts at the COST OF EQUITY and is ALREADY
 *                      an equity flow, so there is NO second net-debt deduction.
 *  - `ocf_less_capex`  operating cash flow minus capex. This is the common proxy
 *                      and it is NOT rigorous FCFF: operating cash flow is
 *                      already net of cash interest paid, so the figure is
 *                      somewhere between FCFF and FCFE, and it omits the
 *                      interest tax shield that WACC assumes. Usable as colour,
 *                      flagged as a proxy, never described as precise.
 *  - `ocf_only`        capex was unavailable, so operating cash flow stands in
 *                      for free cash flow entirely. This overstates free cash
 *                      flow by the whole capital programme — for a capital-heavy
 *                      issuer that is not a small error. A much weaker proxy.
 */
export const CashFlowBasisSchema = z.enum(["fcff", "fcfe", "ocf_less_capex", "ocf_only"]);
export type CashFlowBasis = z.infer<typeof CashFlowBasisSchema>;

/** Where a discount rate came from. A CAPM guess is not a measurement. */
export const DiscountRateBasisSchema = z.enum(["measured", "capm_suggestion_from_beta"]);
export type DiscountRateBasis = z.infer<typeof DiscountRateBasisSchema>;

/** Whether a historical return series includes dividends. Decides double counting. */
export const ReturnBasisSchema = z.enum(["total_return", "price_return"]);
export type ReturnBasis = z.infer<typeof ReturnBasisSchema>;

// ── Proxy labels ────────────────────────────────────────────────────────────

/**
 * Stable proxy identifiers, persisted on `ValuationOutcome.proxies`.
 *
 * A proxy must survive all the way into the outcome, because its only job is to
 * suppress a precision claim downstream. A fair value derived from operating
 * cash flow standing in for free cash flow may be rendered as a range with a
 * caveat; it may not be rendered as "$142.17". Strings rather than a boolean so
 * the reader is told WHICH substitution was made.
 */
export const PROXY = {
  ocfLessCapexAsFcff: "fcff_proxied_by_operating_cash_flow_less_capex",
  ocfAsFreeCashFlow: "free_cash_flow_proxied_by_operating_cash_flow_capex_unavailable",
  waccFromBeta: "discount_rate_is_a_capm_suggestion_from_beta_not_a_measured_wacc",
  /**
   * A published total-return series is normally computed with dividends
   * REINVESTED, while `ScenarioValue` deliberately assumes no reinvestment (see
   * returns.ts). So an empirical total-return percentile carries a little of the
   * dividend's own compounding that the scenario convention does not grant. Over
   * the sub-year horizons this method exists to answer it is a second-order
   * effect, but it is a difference between what the number measures and what the
   * contract says it means, so it is declared rather than absorbed.
   */
  totalReturnEmbedsReinvestment:
    "historical_total_return_series_embeds_dividend_reinvestment_that_scenario_values_do_not_assume",
} as const;

/**
 * The historical sample's shape, as a proxy string.
 *
 * `ValuationOutcome` is a frozen cross-stage contract with no field for sample
 * metadata, and the sample size and the overlap caveat are exactly the facts a
 * reader needs in order not to over-trust an empirical range. So they ride in
 * `proxies`, which is the one array on the contract whose stated purpose is
 * "this number rests on something weaker than it looks". Overlapping windows are
 * genuinely a proxy for independent observations: 40 rolling three-month windows
 * drawn from the same three years contain nowhere near 40 observations' worth of
 * information, and a percentile taken across them looks tighter than the truth.
 */
export function historicalSampleProxy(
  sampleSize: number,
  windowMonths: number,
  overlapping: boolean
): string {
  const shape = overlapping
    ? "overlapping windows are not independent observations, so the range reads tighter than the evidence supports"
    : "non-overlapping windows";
  return `historical_range_sample n=${sampleSize} windows of ${windowMonths} months (${shape})`;
}

// ── Raw inputs ──────────────────────────────────────────────────────────────

/**
 * Every number here is nullable and null means UNKNOWN. That is the whole
 * interface: a caller assembling these from EDGAR, Finnhub or the facts layer
 * passes through what it found and passes `null` for what it did not, and this
 * module decides what that costs. A caller that substitutes a zero to get past
 * validation has defeated the module.
 *
 * One deliberate asymmetry: `distributionsPerShareAnnual` must be `0` for a
 * company that pays nothing, not `null`. Zero is a KNOWN value — "we checked,
 * it pays no dividend" — and null is "we do not know what it pays". Those are
 * different states and collapsing them is how a payer gets valued as a
 * non-payer.
 */
const RawBase = z.object({
  businessType: BusinessTypeSchema,
});

const RawForwardMultiple = RawBase.extend({
  method: z.literal("forward_multiple"),
  /**
   * Net income attributable to COMMON shareholders, in USD — after preferred
   * dividends and after income attributable to minority interests. Using
   * consolidated net income here overstates EPS for every issuer with a
   * significant non-controlling stake.
   */
  netIncomeToCommon: z.number().nullable(),
  /** Diluted share count, in shares. The denominator EPS is actually reported on. */
  dilutedSharesOutstanding: z.number().nullable(),
  currentPrice: z.number().nullable(),
  /** Cash per share per year. `0` for a known non-payer; `null` for unknown. */
  distributionsPerShareAnnual: z.number().nullable(),
});

const RawDcfShape = {
  baseCashFlow: z.number().nullable(),
  cashFlowBasis: CashFlowBasisSchema,
  dilutedSharesOutstanding: z.number().nullable(),
  /**
   * Total debt less cash, in USD; negative means net cash. Required for
   * `fcff_dcf` and NOT required for `fcfe_dcf` — see the bridge note in
   * ./valuation. Null is unknown and blocks the FCFF equity bridge; it is never
   * netted to zero.
   */
  netDebt: z.number().nullable(),
  currentPrice: z.number().nullable(),
  distributionsPerShareAnnual: z.number().nullable(),
};

const RawFcffDcf = RawBase.extend({ method: z.literal("fcff_dcf"), ...RawDcfShape });
const RawFcfeDcf = RawBase.extend({ method: z.literal("fcfe_dcf"), ...RawDcfShape });

const RawHistoricalRange = RawBase.extend({
  method: z.literal("historical_range"),
  currentPrice: z.number().nullable(),
  /**
   * Realised returns over past windows of `windowMonths` length, as FRACTIONS
   * (0.08 = 8%), in any order. Not annualized: these are whole-window returns,
   * because the point of the method is to answer a short horizon in its own
   * units rather than inflate a three-month question into an annual one.
   */
  historicalWindowReturns: z.array(z.number()).nullable(),
  windowMonths: z.number().nullable(),
  returnBasis: ReturnBasisSchema.nullable(),
  /** Whether the windows overlap. Null means the caller cannot say, which blocks. */
  overlappingWindows: z.boolean().nullable(),
  distributionsPerShareAnnual: z.number().nullable(),
});

export const RawValuationInputsSchema = z.discriminatedUnion("method", [
  RawForwardMultiple,
  RawFcffDcf,
  RawFcfeDcf,
  RawHistoricalRange,
]);
export type RawValuationInputs = z.infer<typeof RawValuationInputsSchema>;

// ── Required inputs, enumerated ─────────────────────────────────────────────

/**
 * The required inputs PER METHOD, enumerated by name.
 *
 * This list is the definition of `ValuationOutcome.criticalCoverage`, which
 * `decision.ts` gates on: coverage is the fraction of THESE inputs that were
 * present, not the fraction of however many arbitrary fields a collector
 * happened to gather. The distinction matters because the second number can be
 * driven to 1.0 by collecting more irrelevant fields, which would turn a quality
 * gate into a busywork meter.
 *
 * Exported so tests, callers and the snapshot's `coverage` map can read the same
 * enumeration this module scores against, rather than each keeping its own idea
 * of what a method needs.
 */
export const REQUIRED_INPUTS: Record<ValuationMethod, readonly string[]> = {
  forward_multiple: [
    "netIncomeToCommon",
    "dilutedSharesOutstanding",
    "currentPrice",
    "distributionsPerShareAnnual",
  ],
  fcff_dcf: [
    "baseCashFlow",
    "dilutedSharesOutstanding",
    "netDebt",
    "currentPrice",
    "distributionsPerShareAnnual",
  ],
  // netDebt is absent on purpose: FCFE is already an equity flow, so there is no
  // enterprise-to-equity bridge to make and net debt is not an input to it.
  // Requiring it would fail perfectly complete FCFE inputs on a figure the model
  // never uses.
  fcfe_dcf: [
    "baseCashFlow",
    "dilutedSharesOutstanding",
    "currentPrice",
    "distributionsPerShareAnnual",
  ],
  historical_range: [
    "currentPrice",
    "historicalWindowReturns",
    "windowMonths",
    "returnBasis",
    "overlappingWindows",
  ],
} as const;

/**
 * Fewer than this many comparable windows and the empirical range is not a
 * range, it is a handful of anecdotes with percentiles drawn on it. Below the
 * floor the method returns unavailable; it does not extrapolate, fit a
 * distribution, or widen a small sample to look respectable.
 */
export const MIN_HISTORICAL_WINDOWS = 20;

/**
 * The enumerated required inputs for a SPECIFIC set of raw inputs.
 *
 * Almost always `REQUIRED_INPUTS[method]`. The one conditional requirement is
 * that a PRICE-return historical series needs a distribution figure to complete
 * the total return, while a TOTAL-return series already contains the dividend
 * and must not be given one — adding it there would count the cash twice. The
 * requirement is therefore conditional on the basis rather than always in the
 * denominator, because charging a correct total-return series for an input it
 * genuinely does not need would understate its coverage.
 */
export function requiredInputsFor(raw: RawValuationInputs): readonly string[] {
  const base = REQUIRED_INPUTS[raw.method];
  if (raw.method === "historical_range" && raw.returnBasis === "price_return") {
    return [...base, "distributionsPerShareAnnual"];
  }
  return base;
}

/**
 * Whether an enumerated input is actually usable.
 *
 * `historicalWindowReturns` is special-cased: a three-element array is not a
 * present sample for a method whose enumerated requirement is "at least
 * MIN_HISTORICAL_WINDOWS comparable windows". Scoring it as present would report
 * full coverage on a valuation that then refuses to produce a number, which is
 * precisely the coverage-as-theatre failure the enumeration exists to stop.
 */
function inputIsPresent(field: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (field === "historicalWindowReturns") {
    return Array.isArray(value) && value.length >= MIN_HISTORICAL_WINDOWS;
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

// ── Validated inputs ────────────────────────────────────────────────────────

export interface ValidatedForwardMultipleInputs {
  method: "forward_multiple";
  netIncomeToCommon: number;
  dilutedSharesOutstanding: number;
  currentPrice: number;
  distributionsPerShareAnnual: number;
}

export interface ValidatedDcfInputs {
  method: "fcff_dcf" | "fcfe_dcf";
  baseCashFlow: number;
  cashFlowBasis: CashFlowBasis;
  dilutedSharesOutstanding: number;
  /** Null ONLY on `fcfe_dcf`, where there is no bridge to make. */
  netDebt: number | null;
  currentPrice: number;
  distributionsPerShareAnnual: number;
}

export interface ValidatedHistoricalRangeInputs {
  method: "historical_range";
  currentPrice: number;
  historicalWindowReturns: readonly number[];
  windowMonths: number;
  returnBasis: ReturnBasis;
  overlappingWindows: boolean;
  /** Zero on a total-return series, where the dividend is already in the returns. */
  distributionsPerShareAnnual: number;
}

export type ValidatedValuationInputs =
  | ValidatedForwardMultipleInputs
  | ValidatedDcfInputs
  | ValidatedHistoricalRangeInputs;

/** Why validation stopped. Named so a caller can explain it without re-deriving it. */
export type BlockedReason =
  | "missing_inputs"
  | "invalid_inputs"
  | "method_not_supported";

export type ValuationInputsResult =
  | {
      status: "ok";
      inputs: ValidatedValuationInputs;
      /** Substitutions that must survive into the outcome. */
      proxies: string[];
      /** 1 by construction — every enumerated input was present. */
      criticalCoverage: number;
    }
  | {
      status: "blocked";
      reason: BlockedReason;
      /** Ready to persist as-is: scenarios null, gaps named, coverage honest. */
      outcome: ValuationOutcome;
    };

function gap(field: string, detail: string): ValuationGap {
  return { field, detail };
}

/**
 * Coverage over the enumerated requirement. Note what this number is NOT: it is
 * not accuracy, and it is not adequacy. Full coverage on inputs that are all
 * present and all stale is still 1.0 — freshness is a separate gate in
 * `decision.ts`, and conflating the two would let one hide the other.
 */
export function valuationCoverage(raw: RawValuationInputs): number {
  const required = requiredInputsFor(raw);
  if (required.length === 0) return 1;
  // One cast, at the boundary, so the enumerated names can be read off the
  // discriminated union by key. Nothing persisted is typed through it.
  const bag = raw as unknown as Record<string, unknown>;
  const present = required.filter((f) => inputIsPresent(f, bag[f])).length;
  return present / required.length;
}

/** Proxy substitutions visible in the raw inputs alone. Reported even when blocked. */
function proxiesOf(raw: RawValuationInputs): string[] {
  if (raw.method !== "fcff_dcf" && raw.method !== "fcfe_dcf") return [];
  if (raw.cashFlowBasis === "ocf_less_capex") return [PROXY.ocfLessCapexAsFcff];
  if (raw.cashFlowBasis === "ocf_only") return [PROXY.ocfAsFreeCashFlow];
  return [];
}

function blocked(
  raw: RawValuationInputs,
  reason: BlockedReason,
  gaps: ValuationGap[]
): ValuationInputsResult {
  return {
    status: "blocked",
    reason,
    outcome: ValuationOutcomeSchema.parse({
      method: raw.method,
      gaps,
      // Never a placeholder. A reader who sees no scenarios knows there is no
      // number, which is a far more useful thing to know than a number nobody
      // stands behind.
      scenarios: null,
      proxies: proxiesOf(raw),
      criticalCoverage: valuationCoverage(raw),
      valuationVersion: VALUATION_VERSION,
    } satisfies ValuationOutcome),
  };
}

/**
 * Validate raw inputs for one method.
 *
 * Order of checks is deliberate. Structural applicability comes first, because
 * "this method does not apply to a bank" is a more useful answer than "your
 * bank is missing a capex figure" — chasing the second would eventually produce
 * a complete set of inputs to a model that still means nothing. Missing inputs
 * come next, then relationships between the inputs that are present.
 */
export function validateValuationInputs(raw: RawValuationInputs): ValuationInputsResult {
  const parsed = RawValuationInputsSchema.safeParse(raw);
  if (!parsed.success) {
    return blocked(
      raw,
      "invalid_inputs",
      parsed.error.issues.map((i) =>
        gap(i.path.join(".") || "inputs", `${i.message} (received an unusable value)`)
      )
    );
  }
  const input = parsed.data;

  // ── 1. Is the method applicable to this issuer at all? ────────────────────
  const fundamental = input.method !== "historical_range";
  if (fundamental && UNSUPPORTED_FUNDAMENTAL_BUSINESS_TYPES.includes(input.businessType)) {
    return blocked(input, "method_not_supported", [
      gap(
        "businessType",
        `${input.method} is not supported for a ${input.businessType}: ` +
          notSupportedBecause(input.businessType) +
          " No value is produced. An empirical historical_range over this security's own realised returns remains available, because it makes no claim about the business's cash flows."
      ),
    ]);
  }

  // ── 2. Are the enumerated inputs present? ─────────────────────────────────
  const required = requiredInputsFor(input);
  const bag = input as unknown as Record<string, unknown>;
  const missing = required.filter((f) => !inputIsPresent(f, bag[f]));
  if (missing.length > 0) {
    return blocked(
      input,
      "missing_inputs",
      missing.map((f) => gap(f, missingDetail(f, bag[f])))
    );
  }

  // ── 3. Relationships among the inputs we do have ──────────────────────────
  switch (input.method) {
    case "forward_multiple":
      return validateForwardMultiple(input);
    case "fcff_dcf":
    case "fcfe_dcf":
      return validateDcf(input);
    case "historical_range":
      return validateHistoricalRange(input);
  }
}

function notSupportedBecause(type: BusinessType): string {
  switch (type) {
    case "bank":
      return "for a bank, debt is raw material rather than financing, so an enterprise-value-less-net-debt bridge has no interpretation and a free-cash-flow definition built for an operating company does not describe it.";
    case "insurer":
      return "an insurer's float is borrowed money held as investable assets, so the same bridge and the same cash-flow definition misread the balance sheet.";
    case "reit":
      return "a REIT's reported earnings are depressed by depreciation on assets that are typically appreciating, so a P/E is not comparable and a capex line is not discretionary investment.";
    case "fund":
      return "a fund or ETF has no operations of its own; its value is its holdings, so an earnings or cash-flow model on the wrapper is meaningless.";
    case "loss_making":
      return "there are no positive earnings to put a multiple on, and a negative EPS multiplied by a positive exit multiple is a negative share price rather than a conservative estimate.";
    case "operating":
      return "";
  }
}

function missingDetail(field: string, value: unknown): string {
  if (field === "historicalWindowReturns") {
    const n = Array.isArray(value) ? value.length : 0;
    return `needs at least ${MIN_HISTORICAL_WINDOWS} comparable historical windows, got ${n}. An empirical range is not extrapolated from a smaller sample.`;
  }
  if (field === "netDebt") {
    return "total debt less cash is unknown. It is not netted to zero: doing so values the company as if it had neither debt nor cash, which inflates exactly the issuers whose filings are thinnest.";
  }
  if (field === "distributionsPerShareAnnual") {
    return "cash per share is unknown. Pass 0 for a confirmed non-payer; null is not the same statement and is not defaulted to 0.";
  }
  return "required input is unavailable and is not substituted with a default.";
}

function validateForwardMultiple(
  input: Extract<RawValuationInputs, { method: "forward_multiple" }>
): ValuationInputsResult {
  const gaps: ValuationGap[] = [];
  // A loss-making issuer reaching here means the caller classified the business
  // as operating while the earnings say otherwise. Refuse on the arithmetic
  // rather than trusting the label: this is the check that actually prevents a
  // negative share price, and it is not a gap — more data will not fix it.
  if (input.netIncomeToCommon! <= 0) {
    return blocked(input, "method_not_supported", [
      gap(
        "netIncomeToCommon",
        `forward_multiple needs positive earnings attributable to common, got ${input.netIncomeToCommon}. ` +
          notSupportedBecause("loss_making")
      ),
    ]);
  }
  if (input.dilutedSharesOutstanding! <= 0) {
    gaps.push(gap("dilutedSharesOutstanding", "share count must be positive; a zero denominator is not a large EPS."));
  }
  if (input.currentPrice! <= 0) {
    gaps.push(gap("currentPrice", "current price must be positive to measure a return from."));
  }
  if (input.distributionsPerShareAnnual! < 0) {
    gaps.push(gap("distributionsPerShareAnnual", "distributions cannot be negative; a capital call is not a dividend."));
  }
  if (gaps.length > 0) return blocked(input, "invalid_inputs", gaps);
  return {
    status: "ok",
    inputs: {
      method: "forward_multiple",
      netIncomeToCommon: input.netIncomeToCommon!,
      dilutedSharesOutstanding: input.dilutedSharesOutstanding!,
      currentPrice: input.currentPrice!,
      distributionsPerShareAnnual: input.distributionsPerShareAnnual!,
    },
    proxies: [],
    criticalCoverage: 1,
  };
}

function validateDcf(
  input: Extract<RawValuationInputs, { method: "fcff_dcf" | "fcfe_dcf" }>
): ValuationInputsResult {
  const gaps: ValuationGap[] = [];

  // A negative base cash flow is not a gap and it is not a small fair value:
  // a Gordon terminal value on a negative flow grows the loss forever and then
  // reports it as an intrinsic value. `dcf.ts` refuses it as `no_fcf`; refuse it
  // here too, with a reason the reader can act on.
  if (input.baseCashFlow! <= 0) {
    return blocked(input, "method_not_supported", [
      gap(
        "baseCashFlow",
        `a discounted-cash-flow model needs a positive base cash flow, got ${input.baseCashFlow}. Growing a negative flow in perpetuity does not produce a conservative value, it produces a meaningless one.`
      ),
    ]);
  }

  // The basis has to match the model. Discounting a firm-level flow at the cost
  // of equity is not a conservative FCFE, it is the wrong model: the flow still
  // contains the cash the lenders are owed, so the equity value comes out too
  // high and no net-debt deduction is left to correct it.
  if (input.method === "fcfe_dcf" && input.cashFlowBasis !== "fcfe") {
    gaps.push(
      gap(
        "cashFlowBasis",
        `fcfe_dcf requires an fcfe basis, got ${input.cashFlowBasis}. A firm-level flow discounted at the cost of equity overstates equity value and leaves no bridge to correct it.`
      )
    );
  }
  if (input.method === "fcff_dcf" && input.cashFlowBasis === "fcfe") {
    gaps.push(
      gap(
        "cashFlowBasis",
        "fcff_dcf cannot take an fcfe basis: an equity flow discounted at WACC and then reduced by net debt deducts the debt twice."
      )
    );
  }
  if (input.dilutedSharesOutstanding! <= 0) {
    gaps.push(gap("dilutedSharesOutstanding", "share count must be positive; a zero denominator is not a large per-share value."));
  }
  if (input.currentPrice! <= 0) {
    gaps.push(gap("currentPrice", "current price must be positive to measure a return from."));
  }
  if (input.distributionsPerShareAnnual! < 0) {
    gaps.push(gap("distributionsPerShareAnnual", "distributions cannot be negative; a capital call is not a dividend."));
  }
  if (gaps.length > 0) return blocked(input, "invalid_inputs", gaps);

  return {
    status: "ok",
    inputs: {
      method: input.method,
      baseCashFlow: input.baseCashFlow!,
      cashFlowBasis: input.cashFlowBasis,
      dilutedSharesOutstanding: input.dilutedSharesOutstanding!,
      // Read as null for FCFE even when a caller supplied one, so the arithmetic
      // downstream cannot accidentally apply a bridge the model does not have.
      netDebt: input.method === "fcff_dcf" ? input.netDebt! : null,
      currentPrice: input.currentPrice!,
      distributionsPerShareAnnual: input.distributionsPerShareAnnual!,
    },
    proxies: proxiesOf(input),
    criticalCoverage: 1,
  };
}

function validateHistoricalRange(
  input: Extract<RawValuationInputs, { method: "historical_range" }>
): ValuationInputsResult {
  const gaps: ValuationGap[] = [];
  if (input.currentPrice! <= 0) {
    gaps.push(gap("currentPrice", "current price must be positive to convert a return into a price."));
  }
  if (input.windowMonths! <= 0) {
    gaps.push(gap("windowMonths", "the historical window length must be positive."));
  }
  const returns = input.historicalWindowReturns!;
  if (returns.some((r) => r <= -1)) {
    gaps.push(
      gap(
        "historicalWindowReturns",
        "a window return of -100% or worse implies the security went to zero and kept going; the series is not a set of total returns as fractions."
      )
    );
  }
  // On a total-return series the dividend is ALREADY inside every window return.
  // Carrying a non-zero distribution alongside it and adding both is the classic
  // double count, and it inflates every income name. Refuse rather than silently
  // zeroing the caller's figure, so whoever assembled it learns which basis they
  // are on.
  if (input.returnBasis === "total_return" && (input.distributionsPerShareAnnual ?? 0) !== 0) {
    gaps.push(
      gap(
        "distributionsPerShareAnnual",
        `a total_return series already contains the dividend, so distributions must be 0 here, got ${input.distributionsPerShareAnnual}. Adding both counts the cash twice.`
      )
    );
  }
  if ((input.distributionsPerShareAnnual ?? 0) < 0) {
    gaps.push(gap("distributionsPerShareAnnual", "distributions cannot be negative."));
  }
  if (gaps.length > 0) return blocked(input, "invalid_inputs", gaps);

  return {
    status: "ok",
    inputs: {
      method: "historical_range",
      currentPrice: input.currentPrice!,
      historicalWindowReturns: returns,
      windowMonths: input.windowMonths!,
      returnBasis: input.returnBasis!,
      overlappingWindows: input.overlappingWindows!,
      // Zero on a total-return series is not a default standing in for unknown
      // data: it is the correct value, because the cash is already counted.
      distributionsPerShareAnnual:
        input.returnBasis === "total_return" ? 0 : input.distributionsPerShareAnnual!,
    },
    proxies: [],
    criticalCoverage: 1,
  };
}

// ── Scenario assumptions ────────────────────────────────────────────────────

/**
 * How a DCF's value-today becomes a price-at-horizon.
 *
 * This type exists because of the single most common category error in
 * DCF-driven price targets: a current intrinsic value is NOT a future sale
 * price. Handing a fair value of $180 to a reader as the 24-month target both
 * ignores that the value itself compounds and pretends the market closes the
 * gap on a schedule nobody measured. Requiring an explicit realisation model
 * means the assumption is visible and arguable instead of accidental.
 *
 *  - `converge_to_fair_value`  the price closes `convergenceFraction` of the gap
 *    between today's price and today's fair value by the target date. Purely a
 *    re-rating assumption; it does not compound the value, so it understates a
 *    long horizon. A fraction of 1 asserts the market fully agrees with us by a
 *    date we chose, which nothing in this repository measures.
 *  - `intrinsic_grows_at_discount_rate`  in equilibrium a security's total
 *    return is its discount rate, so value compounds at that rate and cash paid
 *    out leaves the security. See ./valuation for the arithmetic, including why
 *    the accumulated distributions are subtracted from the compounded value.
 */
export const ValueRealisationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("converge_to_fair_value"),
    convergenceFraction: z.number().min(0).max(1),
  }),
  z.object({ kind: z.literal("intrinsic_grows_at_discount_rate") }),
]);
export type ValueRealisation = z.infer<typeof ValueRealisationSchema>;

const AssumptionsBase = z.object({
  scenarioId: ScenarioIdSchema,
  /** Points at the stored assumption set, so a number can be traced to its story. */
  assumptionsRef: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
});

const ForwardMultipleAssumptionsSchema = AssumptionsBase.extend({
  method: z.literal("forward_multiple"),
  /** Annual growth in earnings attributable to common, as a fraction. */
  earningsGrowthAnnual: z.number(),
  /**
   * Annual change in the diluted share count, as a fraction. Negative for a
   * buyback. Required with no default, because the default everyone reaches for
   * is zero, and a constant share count quietly credits shareholders with the
   * whole of a growing company's earnings while it is issuing equity to fund
   * that growth.
   */
  annualDilutionRate: z.number(),
  /** Exit P/E applied to projected diluted EPS at the target date. */
  exitMultiple: z.number(),
});

const DcfAssumptionsSchema = AssumptionsBase.extend({
  method: z.enum(["fcff_dcf", "fcfe_dcf"]),
  /** WACC for fcff_dcf, cost of equity for fcfe_dcf. Fraction. */
  discountRate: z.number(),
  discountRateBasis: DiscountRateBasisSchema,
  cashFlowGrowthAnnual: z.number(),
  terminalGrowth: z.number(),
  explicitYears: z.number().int().min(1).max(15),
  realisation: ValueRealisationSchema,
});

const HistoricalRangeAssumptionsSchema = AssumptionsBase.extend({
  method: z.literal("historical_range"),
  /** Which percentile of the empirical window returns this scenario reads. */
  percentile: z.number(),
});

export const ScenarioAssumptionsSchema = z.discriminatedUnion("method", [
  ForwardMultipleAssumptionsSchema,
  DcfAssumptionsSchema,
  HistoricalRangeAssumptionsSchema,
]);
export type ScenarioAssumptions = z.infer<typeof ScenarioAssumptionsSchema>;
export type ForwardMultipleAssumptions = z.infer<typeof ForwardMultipleAssumptionsSchema>;
export type DcfScenarioAssumptions = z.infer<typeof DcfAssumptionsSchema>;
export type HistoricalRangeAssumptions = z.infer<typeof HistoricalRangeAssumptionsSchema>;

/**
 * A conventional reading of an empirical range, offered so three callers do not
 * invent three different ones.
 *
 * It is a CONVENTION, not a forecast: the 10th percentile of realised windows is
 * not a 10% probability of that outcome. Scenario probabilities come from
 * `ScenarioWeights` with their own declared basis, and nothing here promotes a
 * percentile into one.
 */
export const HISTORICAL_RANGE_PERCENTILES = { bear: 0.1, base: 0.5, bull: 0.9 } as const;

/**
 * Validate one scenario's assumptions. Empty result means usable.
 *
 * These are refusals, not clamps. The precedent is `dcf.ts`'s old
 * `Math.min(terminalGrowth, wacc - 0.005)`, which turned an impossible
 * assumption into an enormous terminal value at a growth rate the user never
 * chose and could not see. An assumption the caller cannot state coherently is
 * an assumption we decline to compute on.
 */
export function validateScenarioAssumptions(
  assumptions: ScenarioAssumptions
): ValuationGap[] {
  const parsed = ScenarioAssumptionsSchema.safeParse(assumptions);
  if (!parsed.success) {
    return parsed.error.issues.map((i) =>
      gap(`assumptions.${i.path.join(".") || "root"}`, i.message)
    );
  }
  const a = parsed.data;
  const gaps: ValuationGap[] = [];

  switch (a.method) {
    case "forward_multiple": {
      if (a.exitMultiple <= 0) {
        gaps.push(
          gap(
            "assumptions.exitMultiple",
            `exit multiple must be positive, got ${a.exitMultiple}. A non-positive P/E on positive earnings is a negative price.`
          )
        );
      }
      if (a.earningsGrowthAnnual <= -1) {
        gaps.push(
          gap(
            "assumptions.earningsGrowthAnnual",
            `annual earnings growth of ${a.earningsGrowthAnnual} destroys more than all earnings each year; a company that stops earning is a loss-making case, not a multiple case.`
          )
        );
      }
      if (a.annualDilutionRate <= -1) {
        gaps.push(
          gap(
            "assumptions.annualDilutionRate",
            `annual share-count change of ${a.annualDilutionRate} retires the entire float each year, which has no per-share interpretation.`
          )
        );
      }
      break;
    }
    case "fcff_dcf":
    case "fcfe_dcf": {
      if (a.discountRate <= 0) {
        gaps.push(
          gap("assumptions.discountRate", `discount rate must be positive, got ${a.discountRate}.`)
        );
      }
      // Gordon growth needs g < r or the denominator is zero or negative. dcf.ts
      // refuses this too; refusing here as well means the reader is told which
      // ASSUMPTION was impossible rather than only that the model declined.
      if (a.terminalGrowth >= a.discountRate) {
        gaps.push(
          gap(
            "assumptions.terminalGrowth",
            `terminal growth ${a.terminalGrowth} must be below the discount rate ${a.discountRate}; a perpetuity growing at or above its discount rate has no finite value. It is refused, not clamped down to just under the rate, because a clamped rate produces an enormous terminal value at a growth assumption nobody chose.`
          )
        );
      }
      if (a.cashFlowGrowthAnnual <= -1) {
        gaps.push(
          gap(
            "assumptions.cashFlowGrowthAnnual",
            `annual cash-flow growth of ${a.cashFlowGrowthAnnual} eliminates the whole cash flow each year.`
          )
        );
      }
      break;
    }
    case "historical_range": {
      if (!(a.percentile >= 0 && a.percentile <= 1)) {
        gaps.push(
          gap(
            "assumptions.percentile",
            `percentile must be within [0, 1], got ${a.percentile}. A percentile outside the sample would have to be extrapolated.`
          )
        );
      }
      break;
    }
  }
  return gaps;
}

/** Proxy labels implied by the assumptions rather than by the data. */
export function assumptionProxies(assumptions: ScenarioAssumptions): string[] {
  if (assumptions.method === "fcff_dcf" || assumptions.method === "fcfe_dcf") {
    // `suggestedWaccFromBeta` is a CAPM-flavoured guess (4% risk-free plus beta
    // times a 5% premium) clamped into a 7–13% band. It is a starting point for
    // a slider, not a measured cost of capital, and a fair value that rests on
    // it must not be presented as one that rests on a measurement.
    if (assumptions.discountRateBasis === "capm_suggestion_from_beta") {
      return [PROXY.waccFromBeta];
    }
  }
  return [];
}
