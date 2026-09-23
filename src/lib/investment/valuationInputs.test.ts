import { describe, it, expect } from "vitest";
import { ValuationOutcomeSchema } from "./contracts";
import {
  HISTORICAL_RANGE_PERCENTILES,
  MIN_HISTORICAL_WINDOWS,
  PROXY,
  REQUIRED_INPUTS,
  UNSUPPORTED_FUNDAMENTAL_BUSINESS_TYPES,
  VALUATION_VERSION,
  assumptionProxies,
  historicalSampleProxy,
  requiredInputsFor,
  validateScenarioAssumptions,
  validateValuationInputs,
  valuationCoverage,
  type RawValuationInputs,
  type ScenarioAssumptions,
} from "./valuationInputs";

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// The forward-multiple fixture is the plan's worked example: $12bn of earnings
// attributable to common on 1bn diluted shares, which is $12.00 of EPS.

function forwardMultiple(over: Partial<Extract<RawValuationInputs, { method: "forward_multiple" }>> = {}) {
  return {
    method: "forward_multiple",
    businessType: "operating",
    netIncomeToCommon: 12_000_000_000,
    dilutedSharesOutstanding: 1_000_000_000,
    currentPrice: 150,
    distributionsPerShareAnnual: 0,
    ...over,
  } satisfies RawValuationInputs;
}

function fcff(over: Partial<Extract<RawValuationInputs, { method: "fcff_dcf" }>> = {}) {
  return {
    method: "fcff_dcf",
    businessType: "operating",
    baseCashFlow: 100_000_000,
    cashFlowBasis: "fcff",
    dilutedSharesOutstanding: 10_000_000,
    netDebt: 500_000_000,
    currentPrice: 80,
    distributionsPerShareAnnual: 0,
    ...over,
  } satisfies RawValuationInputs;
}

function fcfe(over: Partial<Extract<RawValuationInputs, { method: "fcfe_dcf" }>> = {}) {
  return {
    method: "fcfe_dcf",
    businessType: "operating",
    baseCashFlow: 100_000_000,
    cashFlowBasis: "fcfe",
    dilutedSharesOutstanding: 10_000_000,
    netDebt: null,
    currentPrice: 80,
    distributionsPerShareAnnual: 0,
    ...over,
  } satisfies RawValuationInputs;
}

/** 21 window returns from -10% to +10% in 1% steps. Percentiles are exact on it. */
const WINDOW_RETURNS = Array.from({ length: 21 }, (_, i) => (i - 10) / 100);

function historical(over: Partial<Extract<RawValuationInputs, { method: "historical_range" }>> = {}) {
  return {
    method: "historical_range",
    businessType: "operating",
    currentPrice: 50,
    historicalWindowReturns: WINDOW_RETURNS,
    windowMonths: 3,
    returnBasis: "total_return",
    overlappingWindows: true,
    distributionsPerShareAnnual: 0,
    ...over,
  } satisfies RawValuationInputs;
}

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

// ── The enumeration itself ──────────────────────────────────────────────────

describe("REQUIRED_INPUTS — the enumeration coverage is measured against", () => {
  it("names four inputs for the forward multiple", () => {
    expect(REQUIRED_INPUTS.forward_multiple).toEqual([
      "netIncomeToCommon",
      "dilutedSharesOutstanding",
      "currentPrice",
      "distributionsPerShareAnnual",
    ]);
  });

  it("requires net debt for an FCFF bridge and not for an FCFE model", () => {
    // FCFF discounts a firm-level flow at WACC, so the present value is an
    // enterprise value and the bridge to equity needs net debt. FCFE is already
    // an equity flow, so there is no bridge and no second deduction.
    expect(REQUIRED_INPUTS.fcff_dcf).toContain("netDebt");
    expect(REQUIRED_INPUTS.fcfe_dcf).not.toContain("netDebt");
  });

  it("adds a distribution requirement only to a price-return historical series", () => {
    // A total-return series already contains the dividend, so charging it for a
    // distribution figure it must not use would understate its coverage.
    expect(requiredInputsFor(historical({ returnBasis: "total_return" }))).not.toContain(
      "distributionsPerShareAnnual"
    );
    expect(
      requiredInputsFor(historical({ returnBasis: "price_return", distributionsPerShareAnnual: 2 }))
    ).toContain("distributionsPerShareAnnual");
  });
});

describe("valuationCoverage — the fraction of ENUMERATED inputs present", () => {
  it("is 1 when every enumerated input is there", () => {
    expect(valuationCoverage(forwardMultiple())).toBe(1);
  });

  it("is 3/4 when one of the four forward-multiple inputs is missing", () => {
    // Hand-calculated: 4 enumerated inputs, 3 present → 0.75.
    expect(valuationCoverage(forwardMultiple({ netIncomeToCommon: null }))).toBeCloseTo(0.75, 12);
  });

  it("is 4/5 when an FCFF model has no net debt", () => {
    // 5 enumerated inputs, 4 present → 0.8.
    expect(valuationCoverage(fcff({ netDebt: null }))).toBeCloseTo(0.8, 12);
  });

  it("does not rise when irrelevant fields are supplied", () => {
    // netDebt is not enumerated for FCFE, so handing one over cannot buy coverage.
    expect(valuationCoverage(fcfe({ netDebt: 900_000_000 }))).toBe(1);
    expect(valuationCoverage(fcfe({ netDebt: null }))).toBe(1);
  });

  it("counts an undersized historical sample as absent, not present", () => {
    // 5 enumerated inputs; the sample of 3 windows is below the floor, so 4 of 5.
    const thin = historical({ historicalWindowReturns: [0.01, 0.02, 0.03] });
    expect(valuationCoverage(thin)).toBeCloseTo(0.8, 12);
  });
});

// ── Missing inputs become named gaps ────────────────────────────────────────

describe("validateValuationInputs — a missing input is a named gap", () => {
  it("accepts a complete forward-multiple set", () => {
    const r = validateValuationInputs(forwardMultiple());
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.criticalCoverage).toBe(1);
    expect(r.inputs.method).toBe("forward_multiple");
  });

  it("blocks on a missing earnings figure and names it", () => {
    const r = validateValuationInputs(forwardMultiple({ netIncomeToCommon: null }));
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.reason).toBe("missing_inputs");
    expect(r.outcome.gaps.map((g) => g.field)).toEqual(["netIncomeToCommon"]);
    expect(r.outcome.scenarios).toBeNull();
    expect(r.outcome.criticalCoverage).toBeCloseTo(0.75, 12);
  });

  it("treats an unknown net debt as a gap rather than as zero net debt", () => {
    const r = validateValuationInputs(fcff({ netDebt: null }));
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.reason).toBe("missing_inputs");
    const netDebtGap = r.outcome.gaps.find((g) => g.field === "netDebt");
    expect(netDebtGap).toBeDefined();
    expect(netDebtGap!.detail).toMatch(/not netted to zero/);
    expect(r.outcome.scenarios).toBeNull();
  });

  it("does not block an FCFE model for the net debt it does not use", () => {
    const r = validateValuationInputs(fcfe({ netDebt: null }));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    // Read back as null even if a caller had supplied one, so no bridge can be
    // applied by accident downstream.
    const withDebt = validateValuationInputs(fcfe({ netDebt: 900_000_000 }));
    expect(withDebt.status).toBe("ok");
    if (withDebt.status !== "ok") return;
    expect((withDebt.inputs as { netDebt: number | null }).netDebt).toBeNull();
  });

  it("refuses to default an unknown dividend to zero", () => {
    const r = validateValuationInputs(forwardMultiple({ distributionsPerShareAnnual: null }));
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.outcome.gaps[0].field).toBe("distributionsPerShareAnnual");
    expect(r.outcome.gaps[0].detail).toMatch(/Pass 0 for a confirmed non-payer/);
  });

  it("returns unavailable on insufficient historical coverage rather than extrapolating", () => {
    const r = validateValuationInputs(
      historical({ historicalWindowReturns: WINDOW_RETURNS.slice(0, MIN_HISTORICAL_WINDOWS - 1) })
    );
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.outcome.scenarios).toBeNull();
    expect(r.outcome.gaps[0].field).toBe("historicalWindowReturns");
    expect(r.outcome.gaps[0].detail).toContain(`at least ${MIN_HISTORICAL_WINDOWS}`);
  });
});

// ── Unsupported business types ──────────────────────────────────────────────

describe("validateValuationInputs — unsupported business types", () => {
  it("lists the four structural cases plus the loss-making one", () => {
    expect([...UNSUPPORTED_FUNDAMENTAL_BUSINESS_TYPES].sort()).toEqual([
      "bank",
      "fund",
      "insurer",
      "loss_making",
      "reit",
    ]);
  });

  for (const businessType of UNSUPPORTED_FUNDAMENTAL_BUSINESS_TYPES) {
    it(`refuses a forward multiple on a ${businessType} without emitting a value`, () => {
      const r = validateValuationInputs(forwardMultiple({ businessType }));
      expect(r.status).toBe("blocked");
      if (r.status !== "blocked") return;
      expect(r.reason).toBe("method_not_supported");
      expect(r.outcome.scenarios).toBeNull();
      expect(r.outcome.gaps[0].field).toBe("businessType");
      expect(r.outcome.gaps[0].detail).toContain("not supported");
    });

    it(`refuses an FCFF model on a ${businessType}`, () => {
      const r = validateValuationInputs(fcff({ businessType }));
      expect(r.status).toBe("blocked");
      if (r.status !== "blocked") return;
      expect(r.reason).toBe("method_not_supported");
    });
  }

  it("still allows an empirical historical range on a bank", () => {
    // The exemption is deliberate: a range of realised returns makes no claim
    // about the business's cash flows, only about how the security has behaved.
    const r = validateValuationInputs(historical({ businessType: "bank" }));
    expect(r.status).toBe("ok");
  });

  it("refuses a multiple on negative earnings even when the label says operating", () => {
    const r = validateValuationInputs(
      forwardMultiple({ businessType: "operating", netIncomeToCommon: -500_000_000 })
    );
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    // Not a gap: more data will not make a loss into a P/E.
    expect(r.reason).toBe("method_not_supported");
    expect(r.outcome.gaps[0].field).toBe("netIncomeToCommon");
    expect(r.outcome.scenarios).toBeNull();
  });

  it("refuses a DCF on a negative base cash flow", () => {
    const r = validateValuationInputs(fcff({ baseCashFlow: -10_000_000 }));
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.reason).toBe("method_not_supported");
    expect(r.outcome.gaps[0].field).toBe("baseCashFlow");
  });
});

// ── Mismatched cash-flow bases ──────────────────────────────────────────────

describe("validateValuationInputs — the flow has to match the model", () => {
  it("rejects a firm-level proxy flow discounted as an equity flow", () => {
    const r = validateValuationInputs(fcfe({ cashFlowBasis: "ocf_less_capex" }));
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.reason).toBe("invalid_inputs");
    expect(r.outcome.gaps[0].field).toBe("cashFlowBasis");
  });

  it("rejects an equity flow bridged by net debt, which would deduct it twice", () => {
    const r = validateValuationInputs(fcff({ cashFlowBasis: "fcfe" }));
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.outcome.gaps[0].detail).toMatch(/twice/);
  });
});

// ── Proxies survive ─────────────────────────────────────────────────────────

describe("proxies", () => {
  it("flags operating cash flow less capex as a proxy for FCFF", () => {
    const r = validateValuationInputs(fcff({ cashFlowBasis: "ocf_less_capex" }));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.proxies).toEqual([PROXY.ocfLessCapexAsFcff]);
  });

  it("flags operating cash flow with no capex deduction as a weaker proxy still", () => {
    const r = validateValuationInputs(fcff({ cashFlowBasis: "ocf_only" }));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.proxies).toEqual([PROXY.ocfAsFreeCashFlow]);
  });

  it("keeps the proxy on the outcome even when validation blocks", () => {
    const r = validateValuationInputs(fcff({ cashFlowBasis: "ocf_only", netDebt: null }));
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.outcome.proxies).toEqual([PROXY.ocfAsFreeCashFlow]);
  });

  it("does not call a beta-derived CAPM suggestion a measured WACC", () => {
    expect(assumptionProxies(dcfAssumptions({ discountRateBasis: "measured" }))).toEqual([]);
    expect(
      assumptionProxies(dcfAssumptions({ discountRateBasis: "capm_suggestion_from_beta" }))
    ).toEqual([PROXY.waccFromBeta]);
  });

  it("states the historical sample size and the overlap caveat", () => {
    const note = historicalSampleProxy(40, 3, true);
    expect(note).toContain("n=40");
    expect(note).toContain("3 months");
    expect(note).toMatch(/not independent observations/);
    expect(historicalSampleProxy(40, 3, false)).toContain("non-overlapping");
  });
});

// ── Double counting ─────────────────────────────────────────────────────────

describe("distributions are counted exactly once", () => {
  it("refuses a dividend alongside a total-return series", () => {
    const r = validateValuationInputs(
      historical({ returnBasis: "total_return", distributionsPerShareAnnual: 1.5 })
    );
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.reason).toBe("invalid_inputs");
    expect(r.outcome.gaps[0].detail).toMatch(/counts the cash twice/);
  });

  it("reads a total-return series as paying zero separate cash", () => {
    const r = validateValuationInputs(historical({ returnBasis: "total_return" }));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect((r.inputs as { distributionsPerShareAnnual: number }).distributionsPerShareAnnual).toBe(0);
  });

  it("keeps the dividend on a price-return series, where it is genuinely absent", () => {
    const r = validateValuationInputs(
      historical({ returnBasis: "price_return", distributionsPerShareAnnual: 1.5 })
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect((r.inputs as { distributionsPerShareAnnual: number }).distributionsPerShareAnnual).toBe(1.5);
  });
});

// ── Assumption relationships are refused, not clamped ───────────────────────

describe("validateScenarioAssumptions", () => {
  it("accepts a coherent DCF assumption set", () => {
    expect(validateScenarioAssumptions(dcfAssumptions({ terminalGrowth: 0.025 }))).toEqual([]);
  });

  it("rejects a terminal growth at or above the discount rate instead of clamping it", () => {
    for (const terminalGrowth of [0.1, 0.12]) {
      const gaps = validateScenarioAssumptions(dcfAssumptions({ discountRate: 0.1, terminalGrowth }));
      expect(gaps.map((g) => g.field)).toContain("assumptions.terminalGrowth");
      expect(gaps[0].detail).toMatch(/refused, not clamped/);
    }
  });

  it("rejects a non-positive discount rate", () => {
    const gaps = validateScenarioAssumptions(dcfAssumptions({ discountRate: 0, terminalGrowth: -0.5 }));
    expect(gaps.map((g) => g.field)).toContain("assumptions.discountRate");
  });

  it("rejects a non-positive exit multiple", () => {
    const gaps = validateScenarioAssumptions({
      method: "forward_multiple",
      scenarioId: "base",
      assumptionsRef: "a",
      evidenceIds: [],
      earningsGrowthAnnual: 0.1,
      annualDilutionRate: 0,
      exitMultiple: 0,
    });
    expect(gaps.map((g) => g.field)).toContain("assumptions.exitMultiple");
  });

  it("rejects a share count that retires the whole float each year", () => {
    const gaps = validateScenarioAssumptions({
      method: "forward_multiple",
      scenarioId: "base",
      assumptionsRef: "a",
      evidenceIds: [],
      earningsGrowthAnnual: 0,
      annualDilutionRate: -1,
      exitMultiple: 18,
    });
    expect(gaps.map((g) => g.field)).toContain("assumptions.annualDilutionRate");
  });

  it("rejects a percentile outside the sample", () => {
    const gaps = validateScenarioAssumptions({
      method: "historical_range",
      scenarioId: "bull",
      assumptionsRef: "a",
      evidenceIds: [],
      percentile: 1.2,
    });
    expect(gaps.map((g) => g.field)).toContain("assumptions.percentile");
    expect(gaps[0].detail).toMatch(/extrapolated/);
  });

  it("offers a conventional range reading without promoting it to a probability", () => {
    expect(HISTORICAL_RANGE_PERCENTILES).toEqual({ bear: 0.1, base: 0.5, bull: 0.9 });
  });
});

// ── Versioning and contract conformance ─────────────────────────────────────

describe("outcome conformance", () => {
  it("stamps the valuation version on every blocked outcome", () => {
    const r = validateValuationInputs(fcff({ netDebt: null }));
    if (r.status !== "blocked") throw new Error("expected blocked");
    expect(r.outcome.valuationVersion).toBe(VALUATION_VERSION);
    expect(VALUATION_VERSION).toMatch(/^valuation-v\d+-\d{4}-\d{2}-\d{2}$/);
  });

  it("produces outcomes the frozen contract accepts", () => {
    const r = validateValuationInputs(forwardMultiple({ currentPrice: null }));
    if (r.status !== "blocked") throw new Error("expected blocked");
    expect(ValuationOutcomeSchema.safeParse(r.outcome).success).toBe(true);
  });

  it("rejects a non-finite number at the boundary rather than computing on it", () => {
    const r = validateValuationInputs(forwardMultiple({ currentPrice: Number.NaN }));
    expect(r.status).toBe("blocked");
    if (r.status !== "blocked") return;
    expect(r.outcome.scenarios).toBeNull();
  });
});
