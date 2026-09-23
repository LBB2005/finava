import { describe, it, expect } from "vitest";
import {
  UNAVAILABLE,
  pct,
  pctMagnitude,
  money,
  RATING_LABEL,
  RATING_TOKEN,
  STATUS_COPY,
  BASIS_COPY,
  BASIS_BADGE,
  reasonCopy,
  horizonLabel,
  showAnnualized,
} from "./presentation";

describe("pct — a missing value is never a number", () => {
  it("renders null, undefined and non-finite as Unavailable", () => {
    // The whole honesty chain collapses if a missing expected return prints 0.0%.
    for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(pct(bad as number | null | undefined)).toBe(UNAVAILABLE);
    }
  });

  it("never renders a missing value as zero", () => {
    expect(pct(null)).not.toContain("0");
  });

  it("distinguishes a measured zero from a missing value", () => {
    expect(pct(0)).toBe("0.0%");
    expect(pct(null)).toBe(UNAVAILABLE);
  });

  it("signs a positive return and leaves a negative one alone", () => {
    expect(pct(0.145)).toBe("+14.5%");
    expect(pct(-0.28)).toBe("-28.0%");
  });

  it("honours the requested precision", () => {
    expect(pct(0.07004672795, 2)).toBe("+7.00%");
  });
});

describe("pctMagnitude", () => {
  it("omits the plus sign for an already-positive magnitude", () => {
    expect(pctMagnitude(0.28)).toBe("28.0%");
  });

  it("renders a missing loss as Unavailable, not 0%", () => {
    expect(pctMagnitude(null)).toBe(UNAVAILABLE);
  });
});

describe("money", () => {
  it("renders zero as a real price — equity can go to zero", () => {
    expect(money(0)).toBe("$0.00");
  });

  it("renders a missing price as Unavailable", () => {
    expect(money(null)).toBe(UNAVAILABLE);
    expect(money(NaN)).toBe(UNAVAILABLE);
  });

  it("groups thousands", () => {
    expect(money(1234.5)).toBe("$1,234.50");
  });
});

describe("rating presentation", () => {
  it("labels all three ratings", () => {
    expect(RATING_LABEL).toEqual({ buy: "Buy", watch: "Watch", avoid: "Avoid" });
  });

  it("gives Watch a neutral colour, not a warning one", () => {
    // Most Watch ratings mean "not enough to judge". Colouring that as a caution
    // reads as a negative verdict on the company.
    expect(RATING_TOKEN.watch).toBe("var(--color-muted)");
    expect(RATING_TOKEN.watch).not.toBe(RATING_TOKEN.avoid);
  });

  it("uses only design tokens, never raw colour values", () => {
    for (const token of Object.values(RATING_TOKEN)) {
      expect(token).toMatch(/^var\(--/);
    }
  });
});

describe("status copy", () => {
  it("says insufficient_data is about our data, not the company", () => {
    expect(STATUS_COPY.insufficient_data).toMatch(/not about the company/i);
  });

  it("covers every status", () => {
    expect(Object.keys(STATUS_COPY).sort()).toEqual(["complete", "insufficient_data", "partial"]);
  });
});

describe("probability basis copy", () => {
  it("calls a fixed prior an assumption, not a forecast", () => {
    expect(BASIS_COPY.fixed_prior).toMatch(/not a forecast/i);
    expect(BASIS_BADGE.fixed_prior).toBe("Fixed assumption");
  });

  it("marks an untested model distribution experimental", () => {
    expect(BASIS_COPY.model_unvalidated).toMatch(/never tested/i);
    expect(BASIS_BADGE.model_unvalidated).toMatch(/experimental/i);
  });

  it("covers every basis in both maps", () => {
    const keys = ["empirically_calibrated", "fixed_prior", "model_unvalidated", "user_assigned"];
    expect(Object.keys(BASIS_COPY).sort()).toEqual(keys);
    expect(Object.keys(BASIS_BADGE).sort()).toEqual(keys);
  });
});

describe("reasonCopy", () => {
  it("explains a known code in plain words", () => {
    expect(reasonCopy("low_critical_coverage")).toMatch(/inputs/i);
  });

  it("de-slugs an unknown code rather than hiding it", () => {
    // A new code must surface as prose, not vanish from the explanation.
    expect(reasonCopy("some_new_code")).toBe("some new code");
  });
});

describe("horizonLabel", () => {
  it("marks an assumed horizon as assumed", () => {
    const label = horizonLabel({
      count: 12,
      unit: "calendar_months",
      assumed: true,
      targetDate: "2027-09-21",
    });
    expect(label).toContain("(assumed)");
    expect(label).toContain("2027-09-21");
  });

  it("leaves an explicit horizon unmarked", () => {
    const label = horizonLabel({
      count: 24,
      unit: "calendar_months",
      assumed: false,
      targetDate: "2028-09-21",
    });
    expect(label).not.toContain("assumed");
    expect(label).toBe("24 months → 2028-09-21");
  });

  it("singularises a one-month horizon", () => {
    expect(
      horizonLabel({ count: 1, unit: "calendar_months", assumed: false, targetDate: "2026-10-21" })
    ).toBe("1 month → 2026-10-21");
  });
});

describe("showAnnualized", () => {
  it("hides the annualized figure below one year", () => {
    // Annualizing a three-month view manufactures a yearly number the horizon
    // cannot support.
    expect(showAnnualized(0.25)).toBe(false);
    expect(showAnnualized(0.99)).toBe(false);
  });

  it("shows it from one year up", () => {
    expect(showAnnualized(1)).toBe(true);
    expect(showAnnualized(3)).toBe(true);
  });

  it("hides it for a non-finite year fraction", () => {
    expect(showAnnualized(NaN)).toBe(false);
  });
});
