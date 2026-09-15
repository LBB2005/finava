import { describe, it, expect } from "vitest";
import { aboutFinavaBlock } from "./aboutFinava";
import { PLANS, PLAN_ORDER, TRIAL_DAYS, TRIAL_PLAN } from "./plans";

describe("aboutFinavaBlock", () => {
  const block = aboutFinavaBlock();

  it("lists every plan a user can be on or buy, with its prices from plans.ts", () => {
    for (const name of PLAN_ORDER) {
      const cfg = PLANS[name];
      if (name !== "Free" && !cfg.stripe.purchasable) continue;
      expect(block, name).toContain(cfg.label);
      expect(block, name).toContain(cfg.price.monthly);
      if (name !== "Free") expect(block, name).toContain(cfg.price.annual);
    }
  });

  it("does not advertise a plan that is not for sale", () => {
    for (const name of PLAN_ORDER) {
      if (name === "Free" || PLANS[name].stripe.purchasable) continue;
      expect(block).not.toContain(`**${PLANS[name].label}**`);
    }
  });

  it("describes the free tier's limits and the trial from the plan table", () => {
    expect(block).toContain(`${PLANS.Free.deepResearchPerMonth} full crew analyses per month`);
    expect(block).toContain(`${TRIAL_DAYS}-day`);
    expect(block).toContain(TRIAL_PLAN);
  });

  it("tells the model to answer product questions directly", () => {
    expect(block).toMatch(/answer .*directly/i);
  });
});
