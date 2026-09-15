import { describe, expect, it } from "vitest";
import { PLANS, TRIAL_DAYS, TRIAL_PLAN } from "./plans";
import { pricingTiers, trialLine } from "./pricingCopy";

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

  it("counts Deep Research runs where plans.ts caps them", () => {
    expect(byName.Free.features).toContain(`${PLANS.Free.deepResearchPerMonth} Deep Research runs / month`);
    expect(byName.Analyst.features).toContain(`${PLANS.Analyst.deepResearchPerMonth} Deep Research runs / month`);
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
