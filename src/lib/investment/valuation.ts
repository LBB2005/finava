// Scenario valuation — the arithmetic that turns validated inputs and named
// assumptions into a price at a dated horizon.
//
// The module's job is narrow on purpose: given inputs that ./valuationInputs has
// already vouched for and one explicit assumption set per scenario, produce a
// `ScenarioValue` for bear, base and bull, or produce nothing and say which
// assumption or input stopped it. It holds no opinions, reads no providers, and
// has no clock. Every number is reproducible from its arguments.
//
// THE LOAD-BEARING PROPERTY: a current intrinsic value is not a future sale
// price. `priceAtHorizon` means "the per-share price ON the horizon's target
// date", and every method below either models how the value gets there or
// returns unavailable. The failure this prevents is the one that makes DCF-driven
// price targets useless: computing a fair value of $180 today and printing it as
// the two-year target, which both ignores that value compounds over two years and
// silently asserts the market re-rates on a schedule nothing measured.
//
// Three consequences of that, stated once here because they recur below:
//
//  1. DISTRIBUTIONS ARE COUNTED EXACTLY ONCE. `ScenarioValue` carries cash per
//     share separately from price and assumes no reinvestment (returns.ts adds
//     them once). So a method whose price already embeds the dividend must report
//     zero distributions, and a method that compounds a value at a total-return
//     rate must remove the cash that left the security. Getting this wrong does
//     not look like a bug — it looks like an income stock with a great outlook.
//
//  2. THE DCF IS NOT REIMPLEMENTED. It is `computeDcf` from src/lib/dcf.ts, the
//     same function the stock page's DCF tab drives with its sliders. If the
//     research agent had its own copy, the two would disagree about the same
//     company on the same day, and neither would be wrong on its own terms.
//
//  3. NO CLAMPS. An impossible assumption is refused with its name attached. The
//     precedent is dcf.ts's old `Math.min(terminalGrowth, wacc - 0.005)`.

import { computeDcf, type DcfAssumptions, type DcfGap, type DcfInputs } from "@/lib/dcf";
import { ValuationOutcomeSchema, type ValuationOutcome } from "./contracts";
import {
  ScenarioValueSchema,
  type ResolvedHorizonContract,
  type ScenarioId,
  type ScenarioValue,
  type ValuationMethod,
} from "./schemas";
import {
  PROXY,
  VALUATION_VERSION,
  assumptionProxies,
  historicalSampleProxy,
  validateScenarioAssumptions,
  validateValuationInputs,
  valuationCoverage,
  type RawValuationInputs,
  type ScenarioAssumptions,
  type ValidatedDcfInputs,
  type ValidatedForwardMultipleInputs,
  type ValidatedHistoricalRangeInputs,
  type ValidatedValuationInputs,
  type ValuationGap,
} from "./valuationInputs";

export { VALUATION_VERSION };

const SCENARIO_IDS: readonly ScenarioId[] = ["bear", "base", "bull"] as const;

export type ScenarioValueResult =
  | { status: "ok"; value: ScenarioValue; proxies: string[] }
  | { status: "unavailable"; gaps: ValuationGap[] };

function gap(field: string, detail: string): ValuationGap {
  return { field, detail };
}

function unavailable(gaps: ValuationGap[]): ScenarioValueResult {
  return { status: "unavailable", gaps };
}

// ── Method selection ────────────────────────────────────────────────────────

/**
 * Method priority when more than one is available.
 *
 * `forward_multiple` leads because it is the method that actually answers the
 * question a horizon poses — what will a share be worth on a date — for the
 * ordinary case of a profitable operating company, and because its assumptions
 * (earnings growth, dilution, an exit multiple) are the ones a reader can argue
 * with. A DCF's sensitivity is concentrated in a terminal value that dominates
 * the answer and that nobody can check.
 */
const METHOD_PRIORITY: readonly ValuationMethod[] = [
  "forward_multiple",
  "fcfe_dcf",
  "fcff_dcf",
  "historical_range",
] as const;

/**
 * Horizons at or below this many years are answered empirically, never by an
 * annualized long-term model.
 */
export const SUB_YEAR_HORIZON_YEARS = 1;

/**
 * The tolerance on how well a historical sample's window length has to match the
 * horizon. A set of 12-month windows does not answer a 3-month question: the
 * dispersion of a quarter's returns is not the dispersion of a year's, and
 * rescaling one to the other assumes an i.i.d. random walk we have not tested.
 */
export const HISTORICAL_WINDOW_TOLERANCE = 0.25;

/**
 * Pick the method for this horizon out of the ones whose inputs are available.
 *
 * Under a year, only `historical_range` is offered — and if it is not available,
 * nothing is. A three-month view has to be answered in three-month terms or not
 * at all: taking a DCF's fair-value gap and calling it the quarter's expected
 * return implies the whole re-rating lands inside the quarter, which is a
 * confident claim about market timing dressed as a valuation.
 */
export function selectValuationMethod(
  horizon: ResolvedHorizonContract,
  available: readonly ValuationMethod[]
): ValuationMethod | null {
  if (horizon.yearFraction < SUB_YEAR_HORIZON_YEARS) {
    return available.includes("historical_range") ? "historical_range" : null;
  }
  return METHOD_PRIORITY.find((m) => available.includes(m)) ?? null;
}

// ── a) Forward multiple — the primary method ─────────────────────────────────

/**
 * Projected diluted EPS at the target date, times the scenario's exit multiple.
 *
 * Share dilution is modelled explicitly and there is no default for it, because
 * the default everyone reaches for is a constant share count. That assumption
 * credits shareholders with the entire growth of a company that is funding that
 * growth by issuing equity, and it is worth several percent a year in exactly
 * the high-growth names where the exit multiple is already doing the most work.
 *
 * Distributions accrue at the annual rate over the horizon and are reported as
 * cash, not folded into the price, and they do not grow — a second growth
 * assumption on a small number buys nothing but the appearance of precision.
 */
function valueForwardMultiple(
  inputs: ValidatedForwardMultipleInputs,
  a: Extract<ScenarioAssumptions, { method: "forward_multiple" }>,
  horizon: ResolvedHorizonContract
): ScenarioValueResult {
  const years = horizon.yearFraction;
  const earningsAtHorizon = inputs.netIncomeToCommon * (1 + a.earningsGrowthAnnual) ** years;
  const sharesAtHorizon = inputs.dilutedSharesOutstanding * (1 + a.annualDilutionRate) ** years;

  if (!(sharesAtHorizon > 0)) {
    return unavailable([
      gap(
        "assumptions.annualDilutionRate",
        `projected diluted share count is ${sharesAtHorizon} at the horizon, which has no per-share interpretation.`
      ),
    ]);
  }

  const epsAtHorizon = earningsAtHorizon / sharesAtHorizon;
  const priceAtHorizon = epsAtHorizon * a.exitMultiple;

  // Distributions over the horizon at the current annual rate, added exactly
  // once by returns.ts and never reinvested.
  const distributionsPerShare = inputs.distributionsPerShareAnnual * years;

  return finish(priceAtHorizon, distributionsPerShare, "forward_multiple", a, []);
}

// ── b) Historical range — for horizons under a year ──────────────────────────

/** Linear-interpolated percentile of an ascending sample. */
function percentileOf(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  const position = p * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedAsc[lower];
  return sortedAsc[lower] + (position - lower) * (sortedAsc[upper] - sortedAsc[lower]);
}

/**
 * An empirical total-return range over comparable past windows.
 *
 * This is a separate method rather than a rescaling of a long-term model, and
 * that is the whole point of it: a three-month question gets three-month
 * evidence. Nothing is extrapolated — with fewer than the enumerated minimum
 * number of windows ./valuationInputs has already refused the inputs, and a
 * percentile outside [0, 1] is refused rather than projected past the sample.
 *
 * The sample size and the overlap caveat travel on `ValuationOutcome.proxies`,
 * because the frozen contract has no field for them and a reader who is not told
 * that 40 "observations" are 40 rolling windows drawn from three years will read
 * the range as far better evidenced than it is.
 */
function valueHistoricalRange(
  inputs: ValidatedHistoricalRangeInputs,
  a: Extract<ScenarioAssumptions, { method: "historical_range" }>,
  horizon: ResolvedHorizonContract
): ScenarioValueResult {
  const horizonMonths = horizon.yearFraction * 12;
  const drift = Math.abs(inputs.windowMonths - horizonMonths);
  if (drift > HISTORICAL_WINDOW_TOLERANCE * horizonMonths) {
    return unavailable([
      gap(
        "windowMonths",
        `the sample is ${inputs.windowMonths}-month windows but the horizon is ${horizonMonths.toFixed(2)} months. A window of one length does not answer a horizon of another, and rescaling it would assume returns are i.i.d., which is untested here.`
      ),
    ]);
  }

  const sorted = [...inputs.historicalWindowReturns].sort((x, y) => x - y);
  const windowReturn = percentileOf(sorted, a.percentile);

  const proxies = [
    historicalSampleProxy(sorted.length, inputs.windowMonths, inputs.overlappingWindows),
  ];

  // On a TOTAL-return series the dividend is already inside `windowReturn`, so
  // the terminal value it implies is a price-equivalent that includes the cash,
  // and distributions must be zero or the cash is counted twice. On a PRICE-
  // return series the dividend is genuinely absent and is added as cash.
  let distributionsPerShare: number;
  if (inputs.returnBasis === "total_return") {
    distributionsPerShare = 0;
    proxies.push(PROXY.totalReturnEmbedsReinvestment);
  } else {
    distributionsPerShare = inputs.distributionsPerShareAnnual * horizon.yearFraction;
  }

  const priceAtHorizon = inputs.currentPrice * (1 + windowReturn);
  return finish(priceAtHorizon, distributionsPerShare, "historical_range", a, proxies);
}

// ── c) DCF bridge ───────────────────────────────────────────────────────────

/**
 * AUDIT OF THE CASH-FLOW BASIS — the comment this module most needed.
 *
 * `computeDcf` projects a base cash flow for `years`, adds a Gordon terminal
 * value, discounts everything at `wacc`, subtracts `netDebt`, and divides by
 * shares. That is an FCFF model: the discount rate is a blended cost of capital,
 * so the present value it produces is an ENTERPRISE value, and the net-debt
 * subtraction is the bridge from enterprise to equity.
 *
 * Which means two distinct things have to be true for its output to mean
 * anything, and this module enforces both:
 *
 *  FCFF: the flow must be pre-financing — after-tax operating profit plus
 *  non-cash charges, less capex, less the change in working capital, with no
 *  interest and no net borrowing in it. Discounted at WACC, bridged by net debt.
 *  Net debt is REQUIRED; `dcf.ts` now refuses a null rather than netting it to
 *  zero, and ./valuationInputs enumerates it so a missing one is a named gap.
 *
 *  FCFE: the flow is already after interest and after net borrowing, so it
 *  belongs to equity holders. It is discounted at the COST OF EQUITY and there
 *  is NO second net-debt deduction — the debt has already been serviced inside
 *  the flow, and deducting it again subtracts the same obligation twice. So the
 *  call below passes `netDebt: 0` for `fcfe_dcf`. That zero is NOT an unknown
 *  being defaulted, which is the thing this whole feature refuses to do: it is
 *  the identity bridge, the arithmetic statement that no bridge is needed. Net
 *  debt is correspondingly absent from `REQUIRED_INPUTS.fcfe_dcf`, so a missing
 *  net-debt figure never blocks an FCFE model that does not use it.
 *
 * And the honest caveat about the data we actually have: EDGAR's capex coverage
 * is patchy, so `finavaInputs.extractDcfBase` computes `baseFcf` as operating
 * cash flow less capex, or as operating cash flow alone when capex is missing
 * (`fcfIsProxy`). OPERATING CASH FLOW LESS CAPEX IS NOT RIGOROUS FCFF. Operating
 * cash flow is already net of cash interest paid, so the figure sits somewhere
 * between FCFF and FCFE and omits the interest tax shield that WACC assumes;
 * discounting it at WACC and then deducting net debt double-counts part of the
 * financing cost. Operating cash flow with no capex deduction at all is worse
 * still — it overstates free cash flow by the entire capital programme. Both are
 * usable as research colour and both carry a `proxies` entry that must suppress
 * any precision claim downstream. Neither earns a two-decimal price target.
 *
 * Finally: `suggestedWaccFromBeta` is 4% plus beta times a 5% premium, clamped
 * into a 7–13% band. It is a slider's starting position. When a scenario's
 * `discountRateBasis` says it came from there, the outcome says so too, and the
 * result is never described as resting on a measured cost of capital.
 */
function valueDcf(
  inputs: ValidatedDcfInputs,
  a: Extract<ScenarioAssumptions, { method: "fcff_dcf" | "fcfe_dcf" }>,
  horizon: ResolvedHorizonContract
): ScenarioValueResult {
  const dcfInputs: DcfInputs = {
    baseFcf: inputs.baseCashFlow,
    fcfIsProxy: inputs.cashFlowBasis === "ocf_less_capex" || inputs.cashFlowBasis === "ocf_only",
    sharesOutstanding: inputs.dilutedSharesOutstanding,
    // See the audit above: 0 for FCFE is the identity bridge, not a defaulted
    // unknown. For FCFF this is the validated, non-null net debt.
    netDebt: inputs.method === "fcff_dcf" ? inputs.netDebt : 0,
    // Not read by computeDcf when explicit assumptions are supplied; carried as
    // null rather than a guess so nothing downstream can mistake it for data.
    historicalGrowth: null,
    suggestedWacc: a.discountRate,
    currentPrice: inputs.currentPrice,
    currency: null,
  };
  const dcfAssumptions: DcfAssumptions = {
    wacc: a.discountRate,
    growth: a.cashFlowGrowthAnnual,
    years: a.explicitYears,
    terminalGrowth: a.terminalGrowth,
  };

  const result = computeDcf(dcfInputs, dcfAssumptions);
  if (result.gaps.length > 0) {
    return unavailable(result.gaps.map(dcfGapToValuationGap));
  }
  if (result.fairValue == null) {
    return unavailable([
      gap("fairValue", "the shared DCF returned no fair value and named no gap; refusing to invent one."),
    ]);
  }

  const years = horizon.yearFraction;
  const r = a.discountRate;
  const dividend = inputs.distributionsPerShareAnnual;
  let priceAtHorizon: number;

  switch (a.realisation.kind) {
    case "intrinsic_grows_at_discount_rate": {
      // In equilibrium a security's expected total return IS its discount rate,
      // so the intrinsic value compounds at r while cash paid out leaves the
      // security. The accumulated distributions are therefore SUBTRACTED from the
      // compounded value to get the price: the annuity factor
      // ((1+r)^T - 1)/r values T annual payments at the horizon, and removing it
      // leaves the price the share alone commands. The nominal cash is reported
      // separately below, so the dividend is counted exactly once — and the gap
      // between the two (the payments' own compounding) is the reinvestment this
      // contract deliberately does not assume.
      const compounded = result.fairValue * (1 + r) ** years;
      const accumulatedDistributions = dividend * (((1 + r) ** years - 1) / r);
      priceAtHorizon = compounded - accumulatedDistributions;
      break;
    }
    case "converge_to_fair_value": {
      // A pure re-rating assumption: the price closes a stated fraction of
      // today's gap by the target date. It does NOT compound the value, so it
      // understates a long horizon, and a fraction of 1 asserts the market fully
      // agrees with us by a date we picked. Neither the fraction nor the date is
      // measured, which is exactly why the caller has to state it.
      priceAtHorizon =
        inputs.currentPrice +
        a.realisation.convergenceFraction * (result.fairValue - inputs.currentPrice);
      break;
    }
  }

  if (!(priceAtHorizon >= 0)) {
    return unavailable([
      gap(
        "priceAtHorizon",
        `the realisation model produced a price of ${priceAtHorizon} at the horizon. A negative share price is refused rather than floored at zero, because a floored zero would read as a confident forecast of total loss instead of as broken assumptions.`
      ),
    ]);
  }

  return finish(priceAtHorizon, dividend * years, a.method, a, assumptionProxies(a));
}

function dcfGapToValuationGap(g: DcfGap): ValuationGap {
  switch (g) {
    case "no_fcf":
      return gap("baseCashFlow", "the shared DCF needs a positive base cash flow.");
    case "invalid_wacc":
      return gap("assumptions.discountRate", "the discount rate must be a positive finite fraction.");
    case "net_debt_unknown":
      return gap(
        "netDebt",
        "total debt less cash is unknown, so the enterprise-to-equity bridge cannot be made. It is not netted to zero."
      );
    case "shares_unknown":
      return gap("dilutedSharesOutstanding", "a positive share count is required for a per-share value.");
    case "terminal_growth_exceeds_wacc":
      return gap(
        "assumptions.terminalGrowth",
        "terminal growth is at or above the discount rate, so the perpetuity has no finite value. Refused rather than clamped."
      );
  }
}

// ── Assembly ────────────────────────────────────────────────────────────────

/** Build and validate the ScenarioValue, so a bad number fails here, not later. */
function finish(
  priceAtHorizon: number,
  distributionsPerShare: number,
  method: ValuationMethod,
  a: ScenarioAssumptions,
  proxies: string[]
): ScenarioValueResult {
  if (!Number.isFinite(priceAtHorizon) || !Number.isFinite(distributionsPerShare)) {
    return unavailable([
      gap("priceAtHorizon", `the projection did not resolve to a finite number (price ${priceAtHorizon}, distributions ${distributionsPerShare}).`),
    ]);
  }
  if (priceAtHorizon < 0) {
    return unavailable([
      gap(
        "priceAtHorizon",
        `a negative price at the horizon (${priceAtHorizon}) is refused, not clamped to zero: a clamped zero reads as a forecast of total loss rather than as assumptions that do not hold together.`
      ),
    ]);
  }
  const parsed = ScenarioValueSchema.safeParse({
    id: a.scenarioId,
    priceAtHorizon,
    distributionsPerShare,
    assumptionsRef: a.assumptionsRef,
    method,
    evidenceIds: a.evidenceIds,
  } satisfies ScenarioValue);
  if (!parsed.success) {
    return unavailable(
      parsed.error.issues.map((i) => gap(i.path.join(".") || "scenario", i.message))
    );
  }
  return { status: "ok", value: parsed.data, proxies };
}

/**
 * Value one scenario.
 *
 * `inputs` must already have passed `validateValuationInputs`, and `assumptions`
 * must be for the same method — a mismatch is a programming error and is
 * reported as a gap rather than coerced, because coercing it would run one
 * method's arithmetic on another's assumptions.
 */
export function valueScenario(
  inputs: ValidatedValuationInputs,
  assumptions: ScenarioAssumptions,
  horizon: ResolvedHorizonContract
): ScenarioValueResult {
  if (!Number.isFinite(horizon.yearFraction) || horizon.yearFraction <= 0) {
    return unavailable([
      gap("horizon.yearFraction", `the horizon's year fraction must be positive, got ${horizon.yearFraction}.`),
    ]);
  }
  if (inputs.method !== assumptions.method) {
    return unavailable([
      gap(
        "assumptions.method",
        `assumptions are for ${assumptions.method} but the inputs are for ${inputs.method}; one method's arithmetic is not run on another's assumptions.`
      ),
    ]);
  }
  const assumptionGaps = validateScenarioAssumptions(assumptions);
  if (assumptionGaps.length > 0) return unavailable(assumptionGaps);

  switch (inputs.method) {
    case "forward_multiple":
      return valueForwardMultiple(
        inputs,
        assumptions as Extract<ScenarioAssumptions, { method: "forward_multiple" }>,
        horizon
      );
    case "fcff_dcf":
    case "fcfe_dcf":
      return valueDcf(
        inputs,
        assumptions as Extract<ScenarioAssumptions, { method: "fcff_dcf" | "fcfe_dcf" }>,
        horizon
      );
    case "historical_range":
      return valueHistoricalRange(
        inputs,
        assumptions as Extract<ScenarioAssumptions, { method: "historical_range" }>,
        horizon
      );
  }
}

export interface ValuationRequest {
  raw: RawValuationInputs;
  /** Exactly one assumption set per scenario id, all for the inputs' method. */
  assumptions: readonly ScenarioAssumptions[];
  horizon: ResolvedHorizonContract;
}

function outcome(
  method: ValuationMethod,
  gaps: ValuationGap[],
  scenarios: ScenarioValue[] | null,
  proxies: string[],
  criticalCoverage: number
): ValuationOutcome {
  return ValuationOutcomeSchema.parse({
    method,
    gaps,
    scenarios,
    // Order-stable and de-duplicated, so two scenarios resting on the same proxy
    // do not make the caveat look like two separate problems.
    proxies: [...new Set(proxies)],
    criticalCoverage,
    valuationVersion: VALUATION_VERSION,
  } satisfies ValuationOutcome);
}

/**
 * The dispatcher: validate, check the horizon is answerable by this method, value
 * all three scenarios, and assemble a `ValuationOutcome`.
 *
 * All-or-nothing on the scenarios. A partial set would leave part of the
 * probability distribution unpriced, and returns.ts would refuse it anyway — so
 * the failure is reported here, with the gaps that caused it, rather than one
 * stage later as an unexplained absence.
 */
export function computeValuation(request: ValuationRequest): ValuationOutcome {
  const { raw, horizon } = request;

  // The horizon check comes first because it is about the QUESTION, not the data.
  // Telling a caller their 3-month request is missing a capex figure would send
  // them off to complete the inputs to a model that still must not answer it.
  if (horizon.yearFraction < SUB_YEAR_HORIZON_YEARS && raw.method !== "historical_range") {
    return outcome(
      raw.method,
      [
        gap(
          "method",
          `a horizon of ${(horizon.yearFraction * 12).toFixed(2)} months is answered by historical_range, not by ${raw.method}. Treating a long-term model's fair-value gap as the expected return over a sub-year horizon asserts that the entire re-rating lands inside it, which is a market-timing claim rather than a valuation.`
        ),
      ],
      null,
      [],
      valuationCoverage(raw)
    );
  }

  const validated = validateValuationInputs(raw);
  if (validated.status === "blocked") return validated.outcome;

  // Exactly one assumption set per scenario: a duplicate would be weighted twice
  // downstream and a missing one would leave a scenario unpriced.
  const byId = new Map<ScenarioId, ScenarioAssumptions>();
  const structuralGaps: ValuationGap[] = [];
  for (const a of request.assumptions) {
    if (byId.has(a.scenarioId)) {
      structuralGaps.push(gap("assumptions", `duplicate assumptions for the ${a.scenarioId} scenario.`));
      continue;
    }
    byId.set(a.scenarioId, a);
  }
  for (const id of SCENARIO_IDS) {
    if (!byId.has(id)) {
      structuralGaps.push(gap("assumptions", `no assumptions supplied for the ${id} scenario.`));
    }
  }
  if (structuralGaps.length > 0) {
    return outcome(raw.method, structuralGaps, null, validated.proxies, validated.criticalCoverage);
  }

  const scenarios: ScenarioValue[] = [];
  const proxies = [...validated.proxies];
  const gaps: ValuationGap[] = [];
  for (const id of SCENARIO_IDS) {
    const result = valueScenario(validated.inputs, byId.get(id)!, horizon);
    if (result.status === "unavailable") {
      gaps.push(...result.gaps.map((g) => gap(g.field, `${id}: ${g.detail}`)));
      continue;
    }
    scenarios.push(result.value);
    proxies.push(...result.proxies);
  }

  if (gaps.length > 0) {
    return outcome(raw.method, gaps, null, proxies, validated.criticalCoverage);
  }
  return outcome(raw.method, [], scenarios, proxies, validated.criticalCoverage);
}
