import { describe, it, expect } from "vitest";
import { ValuationOutcomeSchema } from "./contracts";
import type { ResolvedHorizonContract, ScenarioId } from "./schemas";
import {
  HISTORICAL_WINDOW_TOLERANCE,
  SUB_YEAR_HORIZON_YEARS,
  VALUATION_VERSION,
  computeValuation,
  selectValuationMethod,
  valueScenario,
} from "./valuation";
import {
  MIN_HISTORICAL_WINDOWS,
  PROXY,
  validateValuationInputs,
  type RawValuationInputs,
  type ScenarioAssumptions,
  type ValidatedValuationInputs,
} from "./valuationInputs";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A horizon of `months`, with the year fraction it implies exactly. */
function horizon(months: number): ResolvedHorizonContract {
  return {
    count: months,
    unit: "calendar_months",
    assumed: false,
    targetDate: "2027-09-22",
    yearFraction: months / 12,
    note: null,
  };
}

function ok(raw: RawValuationInputs): ValidatedValuationInputs {
  const r = validateValuationInputs(raw);
  if (r.status !== "ok") throw new Error(`fixture did not validate: ${JSON.stringify(r.outcome.gaps)}`);
  return r.inputs;
}

const FM_RAW: RawValuationInputs = {
  method: "forward_multiple",
  businessType: "operating",
  netIncomeToCommon: 12_000_000_000,
  dilutedSharesOutstanding: 1_000_000_000,
  currentPrice: 150,
  distributionsPerShareAnnual: 0,
};

function fmAssumptions(over: Partial<Extract<ScenarioAssumptions, { method: "forward_multiple" }>> = {}) {
  return {
    method: "forward_multiple",
    scenarioId: "base",
    assumptionsRef: "a-base",
    evidenceIds: ["e1"],
    earningsGrowthAnnual: 0,
    annualDilutionRate: 0,
    exitMultiple: 20,
    ...over,
  } satisfies ScenarioAssumptions;
}

const FCFF_RAW: RawValuationInputs = {
  method: "fcff_dcf",
  businessType: "operating",
  baseCashFlow: 100_000_000,
  cashFlowBasis: "fcff",
  dilutedSharesOutstanding: 10_000_000,
  netDebt: 500_000_000,
  currentPrice: 80,
  distributionsPerShareAnnual: 0,
};

const FCFE_RAW: RawValuationInputs = {
  method: "fcfe_dcf",
  businessType: "operating",
  baseCashFlow: 100_000_000,
  cashFlowBasis: "fcfe",
  dilutedSharesOutstanding: 10_000_000,
  netDebt: null,
  currentPrice: 80,
  distributionsPerShareAnnual: 0,
};

/**
 * A zero-growth, zero-terminal-growth DCF at a 10% rate. Chosen because its
 * enterprise value is exactly a perpetuity, so every figure below is checkable by
 * hand with no long decimals:
 *
 *   explicit PV   = 100m × (1 − 1.1⁻⁵)/0.10          = 100m × 3.790786769 = 379,078,676.9
 *   terminal      = 100m / 0.10                       = 1,000,000,000
 *   PV(terminal)  = 1,000,000,000 × 1.1⁻⁵             = 620,921,323.1
 *   enterprise    = 379,078,676.9 + 620,921,323.1     = 1,000,000,000   (= 100m / 0.10)
 */
function dcfAssumptions(over: Partial<Extract<ScenarioAssumptions, { method: "fcff_dcf" | "fcfe_dcf" }>> = {}) {
  return {
    method: "fcff_dcf",
    scenarioId: "base",
    assumptionsRef: "a-base",
    evidenceIds: ["e1"],
    discountRate: 0.1,
    discountRateBasis: "measured",
    cashFlowGrowthAnnual: 0,
    terminalGrowth: 0,
    explicitYears: 5,
    realisation: { kind: "converge_to_fair_value", convergenceFraction: 1 },
    ...over,
  } satisfies ScenarioAssumptions;
}

/** 21 window returns, -10% to +10% in 1% steps: percentiles land on exact values. */
const WINDOW_RETURNS = Array.from({ length: 21 }, (_, i) => (i - 10) / 100);

const HIST_RAW: RawValuationInputs = {
  method: "historical_range",
  businessType: "operating",
  currentPrice: 50,
  historicalWindowReturns: WINDOW_RETURNS,
  windowMonths: 3,
  returnBasis: "total_return",
  overlappingWindows: true,
  distributionsPerShareAnnual: 0,
};

function histAssumptions(scenarioId: ScenarioId, percentile: number) {
  return {
    method: "historical_range",
    scenarioId,
    assumptionsRef: `a-${scenarioId}`,
    evidenceIds: ["e1"],
    percentile,
  } satisfies ScenarioAssumptions;
}

// ── a) Forward multiple ─────────────────────────────────────────────────────

describe("forward_multiple — the worked example", () => {
  it("is exactly (12_000_000_000 / 1_000_000_000) * 20 === 240", () => {
    // The identity the plan specifies, asserted on its own before any model runs.
    expect((12_000_000_000 / 1_000_000_000) * 20).toBe(240);

    const r = valueScenario(ok(FM_RAW), fmAssumptions(), horizon(12));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    // $12bn of earnings on 1bn diluted shares is $12.00 of EPS; at a 20× exit
    // multiple that is $240.00 a share. No growth, no dilution, no dividend.
    expect(r.value.priceAtHorizon).toBe(240);
    expect(r.value.distributionsPerShare).toBe(0);
    expect(r.value.method).toBe("forward_multiple");
  });

  it("models dilution explicitly rather than holding the share count constant", () => {
    // Hand-calculated over a 2-year horizon at 10% earnings growth and 3% annual
    // share issuance, with an 18× exit multiple:
    //   earnings = 12,000,000,000 × 1.10² = 14,520,000,000
    //   shares   =  1,000,000,000 × 1.03² =  1,060,900,000
    //   EPS      = 14,520,000,000 / 1,060,900,000 = 13.68649260062211
    //   price    = 13.68649260062211 × 18         = 246.35686681119804
    const diluted = valueScenario(
      ok(FM_RAW),
      fmAssumptions({ earningsGrowthAnnual: 0.1, annualDilutionRate: 0.03, exitMultiple: 18 }),
      horizon(24)
    );
    if (diluted.status !== "ok") throw new Error("expected ok");
    expect(diluted.value.priceAtHorizon).toBeCloseTo(246.35686681119804, 8);

    // The same projection with a constant share count:
    //   EPS   = 14,520,000,000 / 1,000,000,000 = 14.52
    //   price = 14.52 × 18                     = 261.36
    // The $15.00 difference is exactly what assuming constant shares would have
    // handed to shareholders for free, and it is 6% of the answer.
    const constantShares = valueScenario(
      ok(FM_RAW),
      fmAssumptions({ earningsGrowthAnnual: 0.1, annualDilutionRate: 0, exitMultiple: 18 }),
      horizon(24)
    );
    if (constantShares.status !== "ok") throw new Error("expected ok");
    expect(constantShares.value.priceAtHorizon).toBeCloseTo(261.36, 8);
    expect(constantShares.value.priceAtHorizon - diluted.value.priceAtHorizon).toBeCloseTo(
      261.36 - 246.35686681119804,
      8
    );
  });

  it("credits a buyback the same way, through the share count", () => {
    // 2 years of 5% annual retirement: shares = 1bn × 0.95² = 902,500,000.
    //   EPS   = 12,000,000,000 / 902,500,000 = 13.29639889196676
    //   price = × 20                          = 265.9279778393352
    const r = valueScenario(
      ok(FM_RAW),
      fmAssumptions({ annualDilutionRate: -0.05 }),
      horizon(24)
    );
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.value.priceAtHorizon).toBeCloseTo(265.9279778393352, 8);
  });

  it("accrues distributions over the horizon exactly once, with no reinvestment", () => {
    // $2.00 a year over 2 years is $4.00 of cash. It is reported as cash and is
    // NOT added to the price as well, and it is not compounded at any rate — a
    // reinvestment assumption we do not have would inflate every long horizon.
    const r = valueScenario(
      ok({ ...FM_RAW, distributionsPerShareAnnual: 2 } as RawValuationInputs),
      fmAssumptions(),
      horizon(24)
    );
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.value.distributionsPerShare).toBe(4);
    // The price is untouched by the dividend: 12.00 EPS × 20 = 240.
    expect(r.value.priceAtHorizon).toBe(240);
  });
});

// ── b) Historical range ─────────────────────────────────────────────────────

describe("historical_range — a sub-year horizon answered in its own units", () => {
  it("selects the empirical method under a year, even when a DCF is available", () => {
    expect(SUB_YEAR_HORIZON_YEARS).toBe(1);
    expect(
      selectValuationMethod(horizon(3), ["fcff_dcf", "forward_multiple", "historical_range"])
    ).toBe("historical_range");
    // And prefers the forward multiple once the horizon is long enough for it.
    expect(
      selectValuationMethod(horizon(24), ["fcff_dcf", "forward_multiple", "historical_range"])
    ).toBe("forward_multiple");
  });

  it("answers nothing at all for a sub-year horizon with no historical coverage", () => {
    expect(selectValuationMethod(horizon(3), ["fcff_dcf", "forward_multiple"])).toBeNull();
  });

  it("refuses to answer a 3-month horizon with an annualized DCF", () => {
    const outcome = computeValuation({
      raw: FCFF_RAW,
      assumptions: (["bear", "base", "bull"] as const).map((id) =>
        dcfAssumptions({ scenarioId: id })
      ),
      horizon: horizon(3),
    });
    expect(outcome.scenarios).toBeNull();
    expect(outcome.gaps.map((g) => g.field)).toEqual(["method"]);
    expect(outcome.gaps[0].detail).toMatch(/market-timing claim/);
  });

  it("reads exact percentiles off the empirical sample", () => {
    // 21 sorted returns from -0.10 to +0.10 in 0.01 steps. With linear
    // interpolation at p·(n−1) = p·20 the indices are whole numbers:
    //   p=0.10 → index 2  → -0.08  → price 50 × 0.92 = 46
    //   p=0.50 → index 10 →  0.00  → price 50 × 1.00 = 50
    //   p=0.90 → index 18 → +0.08  → price 50 × 1.08 = 54
    const outcome = computeValuation({
      raw: HIST_RAW,
      assumptions: [
        histAssumptions("bear", 0.1),
        histAssumptions("base", 0.5),
        histAssumptions("bull", 0.9),
      ],
      horizon: horizon(3),
    });
    expect(outcome.gaps).toEqual([]);
    expect(outcome.scenarios).not.toBeNull();
    const prices = outcome.scenarios!.map((s) => s.priceAtHorizon);
    expect(prices[0]).toBeCloseTo(46, 10);
    expect(prices[1]).toBeCloseTo(50, 10);
    expect(prices[2]).toBeCloseTo(54, 10);
    expect(outcome.method).toBe("historical_range");
  });

  it("states the sample size and the overlap caveat on the outcome", () => {
    const outcome = computeValuation({
      raw: HIST_RAW,
      assumptions: [
        histAssumptions("bear", 0.1),
        histAssumptions("base", 0.5),
        histAssumptions("bull", 0.9),
      ],
      horizon: horizon(3),
    });
    const sampleNote = outcome.proxies.find((p) => p.startsWith("historical_range_sample"));
    expect(sampleNote).toBeDefined();
    expect(sampleNote!).toContain(`n=${WINDOW_RETURNS.length}`);
    expect(sampleNote!).toContain("3 months");
    expect(sampleNote!).toMatch(/not independent observations/);
    // One note, not three: the same caveat repeated per scenario would read as
    // three separate problems.
    expect(outcome.proxies.filter((p) => p.startsWith("historical_range_sample"))).toHaveLength(1);
  });

  it("adds no separate cash on a total-return series, because it is already in there", () => {
    const outcome = computeValuation({
      raw: HIST_RAW,
      assumptions: [
        histAssumptions("bear", 0.1),
        histAssumptions("base", 0.5),
        histAssumptions("bull", 0.9),
      ],
      horizon: horizon(3),
    });
    expect(outcome.scenarios!.every((s) => s.distributionsPerShare === 0)).toBe(true);
    expect(outcome.proxies).toContain(PROXY.totalReturnEmbedsReinvestment);
  });

  it("adds the dividend on a price-return series, prorated over the horizon", () => {
    // $4.00 a year over a 3-month horizon is $1.00 of cash, and the price comes
    // from the price-only return: 50 × 1.00 = 50 at the median.
    const outcome = computeValuation({
      raw: { ...HIST_RAW, returnBasis: "price_return", distributionsPerShareAnnual: 4 } as RawValuationInputs,
      assumptions: [
        histAssumptions("bear", 0.1),
        histAssumptions("base", 0.5),
        histAssumptions("bull", 0.9),
      ],
      horizon: horizon(3),
    });
    const base = outcome.scenarios!.find((s) => s.id === "base")!;
    expect(base.distributionsPerShare).toBeCloseTo(1, 10);
    expect(base.priceAtHorizon).toBeCloseTo(50, 10);
    expect(outcome.proxies).not.toContain(PROXY.totalReturnEmbedsReinvestment);
  });

  it("returns unavailable on insufficient historical coverage instead of extrapolating", () => {
    const outcome = computeValuation({
      raw: {
        ...HIST_RAW,
        historicalWindowReturns: WINDOW_RETURNS.slice(0, MIN_HISTORICAL_WINDOWS - 1),
      } as RawValuationInputs,
      assumptions: [
        histAssumptions("bear", 0.1),
        histAssumptions("base", 0.5),
        histAssumptions("bull", 0.9),
      ],
      horizon: horizon(3),
    });
    expect(outcome.scenarios).toBeNull();
    expect(outcome.gaps.map((g) => g.field)).toEqual(["historicalWindowReturns"]);
    expect(outcome.criticalCoverage).toBeLessThan(1);
  });

  it("refuses a sample whose windows are the wrong length for the horizon", () => {
    // 12-month windows cannot answer a 3-month question: rescaling one to the
    // other would assume returns are i.i.d., which nothing here has tested.
    expect(HISTORICAL_WINDOW_TOLERANCE).toBe(0.25);
    const outcome = computeValuation({
      raw: { ...HIST_RAW, windowMonths: 12 } as RawValuationInputs,
      assumptions: [
        histAssumptions("bear", 0.1),
        histAssumptions("base", 0.5),
        histAssumptions("bull", 0.9),
      ],
      horizon: horizon(3),
    });
    expect(outcome.scenarios).toBeNull();
    expect(outcome.gaps.every((g) => g.field === "windowMonths")).toBe(true);
  });
});

// ── c) The DCF bridge ───────────────────────────────────────────────────────

describe("DCF bridge — the shared computeDcf, with an explicit equity bridge", () => {
  it("bridges an FCFF enterprise value to equity via net debt", () => {
    // Enterprise value is the 10% perpetuity: 100,000,000 / 0.10 = 1,000,000,000.
    // Less 500,000,000 of net debt leaves 500,000,000 of equity, over 10,000,000
    // shares = $50.00 a share. Realised at the horizon by fully closing the gap
    // from today's $80.00, so the horizon price is $50.00.
    const r = valueScenario(ok(FCFF_RAW), dcfAssumptions(), horizon(24));
    if (r.status !== "ok") throw new Error(`expected ok: ${JSON.stringify(r)}`);
    expect(r.value.priceAtHorizon).toBeCloseTo(50, 6);
  });

  it("does not deduct net debt a second time on an FCFE model", () => {
    // The same 1,000,000,000 present value, but the flow is ALREADY an equity
    // flow, so there is no bridge: 1,000,000,000 / 10,000,000 = $100.00 a share.
    // Exactly double the FCFF answer above, which is the whole point — the debt
    // is serviced inside the flow and must not be subtracted again.
    const r = valueScenario(
      ok(FCFE_RAW),
      dcfAssumptions({ method: "fcfe_dcf" }),
      horizon(24)
    );
    if (r.status !== "ok") throw new Error(`expected ok: ${JSON.stringify(r)}`);
    expect(r.value.priceAtHorizon).toBeCloseTo(100, 6);

    // And a net-debt figure handed in anyway changes nothing, because the model
    // does not read one.
    const withDebt = valueScenario(
      ok({ ...FCFE_RAW, netDebt: 500_000_000 } as RawValuationInputs),
      dcfAssumptions({ method: "fcfe_dcf" }),
      horizon(24)
    );
    if (withDebt.status !== "ok") throw new Error("expected ok");
    expect(withDebt.value.priceAtHorizon).toBeCloseTo(100, 6);
  });

  it("treats an unknown net debt as a gap, never as a number", () => {
    const outcome = computeValuation({
      raw: { ...FCFF_RAW, netDebt: null } as RawValuationInputs,
      assumptions: (["bear", "base", "bull"] as const).map((id) => dcfAssumptions({ scenarioId: id })),
      horizon: horizon(24),
    });
    expect(outcome.scenarios).toBeNull();
    expect(outcome.gaps.map((g) => g.field)).toEqual(["netDebt"]);
    // 4 of the 5 enumerated FCFF inputs were present.
    expect(outcome.criticalCoverage).toBeCloseTo(0.8, 12);
  });

  it("does not equate today's fair value with the price at the horizon", () => {
    // Closing none of the gap leaves the price where it is: $80.00, not the
    // $100.00 fair value. This is the category error the realisation model exists
    // to prevent — a fair value today is not a sale price in two years.
    const none = valueScenario(
      ok(FCFE_RAW),
      dcfAssumptions({
        method: "fcfe_dcf",
        realisation: { kind: "converge_to_fair_value", convergenceFraction: 0 },
      }),
      horizon(24)
    );
    if (none.status !== "ok") throw new Error("expected ok");
    expect(none.value.priceAtHorizon).toBeCloseTo(80, 6);

    // Closing half of it: 80 + 0.5 × (100 − 80) = 90.
    const half = valueScenario(
      ok(FCFE_RAW),
      dcfAssumptions({
        method: "fcfe_dcf",
        realisation: { kind: "converge_to_fair_value", convergenceFraction: 0.5 },
      }),
      horizon(24)
    );
    if (half.status !== "ok") throw new Error("expected ok");
    expect(half.value.priceAtHorizon).toBeCloseTo(90, 6);
  });

  it("compounds intrinsic value at the discount rate when asked to", () => {
    // $100.00 of value compounding at 10% for 2 years is 100 × 1.21 = $121.00.
    const r = valueScenario(
      ok(FCFE_RAW),
      dcfAssumptions({
        method: "fcfe_dcf",
        realisation: { kind: "intrinsic_grows_at_discount_rate" },
      }),
      horizon(24)
    );
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.value.priceAtHorizon).toBeCloseTo(121, 6);
    expect(r.value.priceAtHorizon).not.toBeCloseTo(100, 2);
  });

  it("removes distributions from the compounded value so the cash is counted once", () => {
    // $3.00 a year for 2 years, with value compounding at 10%:
    //   compounded value       = 100 × 1.21                    = 121.00
    //   accumulated dividends  = 3 × ((1.21 − 1) / 0.10) = 3 × 2.1 =   6.30
    //   price at horizon       = 121.00 − 6.30                 = 114.70
    //   cash reported          = 3 × 2                         =   6.00
    // Total of 120.70 rather than 121.00: the 0.30 difference is the dividend's
    // own compounding, which this contract deliberately does not assume.
    const r = valueScenario(
      ok({ ...FCFE_RAW, distributionsPerShareAnnual: 3 } as RawValuationInputs),
      dcfAssumptions({
        method: "fcfe_dcf",
        realisation: { kind: "intrinsic_grows_at_discount_rate" },
      }),
      horizon(24)
    );
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.value.priceAtHorizon).toBeCloseTo(114.7, 6);
    expect(r.value.distributionsPerShare).toBeCloseTo(6, 10);
    expect(r.value.priceAtHorizon + r.value.distributionsPerShare).toBeCloseTo(120.7, 6);
  });

  it("refuses a terminal growth at or above the discount rate rather than clamping it", () => {
    const blocked = computeValuation({
      raw: FCFF_RAW,
      assumptions: (["bear", "base", "bull"] as const).map((id) =>
        dcfAssumptions({ scenarioId: id, discountRate: 0.1, terminalGrowth: 0.1 })
      ),
      horizon: horizon(24),
    });
    expect(blocked.scenarios).toBeNull();
    expect(blocked.gaps.every((g) => g.field === "assumptions.terminalGrowth")).toBe(true);
    expect(blocked.gaps[0].detail).toMatch(/refused, not clamped/);

    // The refusal is specific, not blanket: just under the rate still computes.
    // 100m / (0.10 − 0.09) is a very large terminal value, which is exactly why a
    // silent clamp to `wacc − 0.005` was so dangerous — it produced a number of
    // this magnitude at a growth rate nobody chose.
    const permitted = computeValuation({
      raw: FCFF_RAW,
      assumptions: (["bear", "base", "bull"] as const).map((id) =>
        dcfAssumptions({ scenarioId: id, discountRate: 0.1, terminalGrowth: 0.09 })
      ),
      horizon: horizon(24),
    });
    expect(permitted.gaps).toEqual([]);
    expect(permitted.scenarios).not.toBeNull();
  });

  it("refuses a negative horizon price rather than flooring it at zero", () => {
    // Net debt of 2,000,000,000 against a 1,000,000,000 enterprise value leaves
    // −1,000,000,000 of equity, or −$100.00 a share. A zero here would read as a
    // confident forecast of total loss; the assumptions simply do not hold.
    const outcome = computeValuation({
      raw: { ...FCFF_RAW, netDebt: 2_000_000_000 } as RawValuationInputs,
      assumptions: (["bear", "base", "bull"] as const).map((id) => dcfAssumptions({ scenarioId: id })),
      horizon: horizon(24),
    });
    expect(outcome.scenarios).toBeNull();
    expect(outcome.gaps.every((g) => g.field === "priceAtHorizon")).toBe(true);
    expect(outcome.gaps[0].detail).toMatch(/refused rather than floored at zero/);
  });

  it("carries a cash-flow proxy all the way onto the outcome", () => {
    // Operating cash flow less capex is not rigorous FCFF, and operating cash
    // flow with no capex deduction is weaker still. Either way the substitution
    // has to reach the reader, or a caveated number gets rendered as a precise one.
    const outcome = computeValuation({
      raw: { ...FCFF_RAW, cashFlowBasis: "ocf_less_capex" } as RawValuationInputs,
      assumptions: (["bear", "base", "bull"] as const).map((id) =>
        dcfAssumptions({ scenarioId: id, discountRateBasis: "capm_suggestion_from_beta" })
      ),
      horizon: horizon(24),
    });
    expect(outcome.scenarios).not.toBeNull();
    expect(outcome.proxies).toContain(PROXY.ocfLessCapexAsFcff);
    expect(outcome.proxies).toContain(PROXY.waccFromBeta);
    // De-duplicated across the three scenarios that each rest on them.
    expect(outcome.proxies).toHaveLength(2);
  });
});

// ── Unsupported issuers ─────────────────────────────────────────────────────

describe("unsupported business types emit no precision", () => {
  for (const businessType of ["bank", "insurer", "reit", "fund"] as const) {
    it(`produces a method-not-supported outcome for a ${businessType}`, () => {
      const outcome = computeValuation({
        raw: { ...FM_RAW, businessType } as RawValuationInputs,
        assumptions: (["bear", "base", "bull"] as const).map((id) => fmAssumptions({ scenarioId: id })),
        horizon: horizon(24),
      });
      expect(outcome.scenarios).toBeNull();
      expect(outcome.gaps.map((g) => g.field)).toEqual(["businessType"]);
      expect(outcome.gaps[0].detail).toContain("not supported");
      // Nothing numeric leaked into the record beyond the coverage measurement.
      expect(JSON.stringify(outcome.gaps)).not.toMatch(/\$\d/);
    });
  }

  it("produces no value for a loss-making company", () => {
    const outcome = computeValuation({
      raw: { ...FM_RAW, netIncomeToCommon: -1_000_000_000 } as RawValuationInputs,
      assumptions: (["bear", "base", "bull"] as const).map((id) => fmAssumptions({ scenarioId: id })),
      horizon: horizon(24),
    });
    expect(outcome.scenarios).toBeNull();
    expect(outcome.gaps.map((g) => g.field)).toEqual(["netIncomeToCommon"]);
  });
});

// ── Dispatcher discipline ───────────────────────────────────────────────────

describe("computeValuation — structure", () => {
  const fmAll = (["bear", "base", "bull"] as const).map((id, i) =>
    fmAssumptions({ scenarioId: id, exitMultiple: [12, 18, 24][i] })
  );

  it("prices all three scenarios from one input set", () => {
    // EPS at 2 years with 10% growth and 3% dilution is 13.68649260062211, so:
    //   bear 12× = 164.23791120746534
    //   base 18× = 246.35686681119803
    //   bull 24× = 328.4758224149307
    const outcome = computeValuation({
      raw: FM_RAW,
      assumptions: fmAll.map((a) => ({ ...a, earningsGrowthAnnual: 0.1, annualDilutionRate: 0.03 })),
      horizon: horizon(24),
    });
    expect(outcome.gaps).toEqual([]);
    expect(outcome.scenarios!.map((s) => s.id)).toEqual(["bear", "base", "bull"]);
    const [bear, base, bull] = outcome.scenarios!.map((s) => s.priceAtHorizon);
    expect(bear).toBeCloseTo(164.23791120746534, 8);
    expect(base).toBeCloseTo(246.35686681119803, 8);
    expect(bull).toBeCloseTo(328.4758224149307, 8);
    expect(outcome.criticalCoverage).toBe(1);
  });

  it("stamps the valuation version on every outcome", () => {
    const outcome = computeValuation({ raw: FM_RAW, assumptions: fmAll, horizon: horizon(24) });
    expect(outcome.valuationVersion).toBe(VALUATION_VERSION);
    expect(ValuationOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it("refuses a partial scenario set rather than pricing part of a distribution", () => {
    const outcome = computeValuation({
      raw: FM_RAW,
      assumptions: fmAll.slice(0, 2),
      horizon: horizon(24),
    });
    expect(outcome.scenarios).toBeNull();
    expect(outcome.gaps[0].detail).toMatch(/no assumptions supplied for the bull scenario/);
  });

  it("refuses duplicate assumptions for one scenario, which would be weighted twice", () => {
    const outcome = computeValuation({
      raw: FM_RAW,
      assumptions: [...fmAll, fmAssumptions({ scenarioId: "base" })],
      horizon: horizon(24),
    });
    expect(outcome.scenarios).toBeNull();
    expect(outcome.gaps[0].detail).toMatch(/duplicate assumptions for the base scenario/);
  });

  it("names the scenario a gap came from", () => {
    const outcome = computeValuation({
      raw: FM_RAW,
      assumptions: [fmAssumptions({ scenarioId: "bear", exitMultiple: -5 }), fmAll[1], fmAll[2]],
      horizon: horizon(24),
    });
    expect(outcome.scenarios).toBeNull();
    expect(outcome.gaps[0].detail.startsWith("bear:")).toBe(true);
  });

  it("does not run one method's arithmetic on another's assumptions", () => {
    const r = valueScenario(ok(FM_RAW), dcfAssumptions(), horizon(24));
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.gaps[0].field).toBe("assumptions.method");
  });

  it("refuses a non-positive horizon", () => {
    const r = valueScenario(ok(FM_RAW), fmAssumptions(), { ...horizon(12), yearFraction: 0 });
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.gaps[0].field).toBe("horizon.yearFraction");
  });
});
