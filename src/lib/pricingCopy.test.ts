import { describe, expect, it } from "vitest";
import { PLANS, TRIAL_DAYS, TRIAL_PLAN, TYPICAL_RUN_CREDITS } from "./plans";
import { creditsInRuns, pricingTiers, trialLine } from "./pricingCopy";

const tiers = pricingTiers();
const byName = Object.fromEntries(tiers.map((t) => [t.name, t]));
const all = tiers.flatMap((t) => t.features).join("\n");

describe("pricing copy", () => {
  it("shows the sellable tiers with prices from plans.ts", () => {
    expect(tiers.map((t) => t.name)).toEqual(["Free", "Analyst", "Pro"]);
    expect(byName.Analyst.price).toBe(PLANS.Analyst.price.monthly);
    expect(byName.Pro.price).toBe(PLANS.Pro.price.monthly);
  });

  it("states each metered plan's monthly credits from plans.ts", () => {
    expect(byName.Free.features).toContain(`${PLANS.Free.monthly.toLocaleString("en-US")} credits / month`);
    expect(byName.Analyst.features).toContain(`${PLANS.Analyst.monthly.toLocaleString("en-US")} credits / month`);
    expect(byName.Pro.features).toContain(`${PLANS.Pro.monthly.toLocaleString("en-US")} credits / month`);
  });

  it("counts Deep Research runs where plans.ts caps them, with the right plural", () => {
    expect(PLANS.Free.deepResearchPerMonth).toBe(1);
    expect(byName.Free.features).toContain("1 Deep Research run / month");
    expect(byName.Analyst.features).toContain(`${PLANS.Analyst.deepResearchPerMonth} Deep Research runs / month`);
  });

  it("translates each plan's credits into runs at the measured typical cost", () => {
    for (const t of tiers) {
      expect(t.features).toContain(creditsInRuns(PLANS[t.name].monthly));
    }
  });

  it("never promises more runs than the credits buy", () => {
    const credits = 4400;
    const line = creditsInRuns(credits);
    const [full, fast] = line.match(/[\d,]+/g)!.map((x) => Number(x.replace(/,/g, "")));
    expect(full * TYPICAL_RUN_CREDITS.full).toBeLessThanOrEqual(credits);
    expect(fast * TYPICAL_RUN_CREDITS.fast).toBeLessThanOrEqual(credits);
    expect(line).toBe("Up to 23 full analyses or 880 quick answers");
  });

  it("uses the singular for exactly one run", () => {
    expect(creditsInRuns(TYPICAL_RUN_CREDITS.full)).toMatch(/^Up to 1 full analysis or /);
  });

  it("never says Unlimited for anything that is metered, and drops removed perks", () => {
    // Every tier is credit-metered, so chat/lenses/analysis/Deep Research are never unlimited.
    expect(all).not.toMatch(/unlimited (chat|lenses|analysis|deep research)/i);
    expect(all).not.toMatch(/priority processing/i);
    // Unlimited is only allowed where plans.ts really has no limit (watchlists).
    for (const line of all.split("\n").filter((l) => /unlimited/i.test(l))) {
      expect(line).toMatch(/watchlists/i);
    }
  });

  it("only advertises capabilities the plan grants", () => {
    expect(byName.Free.features.join(" ")).not.toMatch(/plaid|briefings/i);
    expect(byName.Analyst.features).toContain("Live brokerage sync (Plaid)");
    expect(byName.Analyst.features).toContain("Weekly AI market briefings");
  });

  it("describes the trial from plans.ts", () => {
    expect(trialLine()).toBe(`Every account starts with a ${TRIAL_DAYS}-day ${TRIAL_PLAN} trial — no credit card required.`);
  });
});
