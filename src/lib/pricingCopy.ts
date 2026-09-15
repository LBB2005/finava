// Marketing pricing copy, generated from plans.ts so the page can't promise
// more than the product enforces (no "Unlimited" on a metered plan, no perks
// the code doesn't deliver). Pure — safe for the client Pricing component.

import { PLANS, TRIAL_DAYS, TRIAL_PLAN, type PlanName } from "./plans";

export interface PricingTier {
  name: PlanName;
  price: string;
  cadence: string;
  annual?: string;
  blurb: string;
  features: string[];
  cta: string;
  featured?: boolean;
}

const dollars = (s: string) => Number(s.replace(/[^0-9.]/g, ""));
const n = (x: number) => x.toLocaleString("en-US");

function features(plan: PlanName): string[] {
  const cfg = PLANS[plan];
  const out = [`${n(cfg.monthly)} credits / month`];
  out.push(
    Number.isFinite(cfg.deepResearchPerMonth)
      ? `${cfg.deepResearchPerMonth} Deep Research runs / month`
      : "Deep Research runs limited only by your credits"
  );
  if (cfg.capabilities.plaidLinking) out.push("Live brokerage sync (Plaid)");
  if (cfg.capabilities.weeklyBriefings) out.push("Weekly AI market briefings");
  out.push(
    Number.isFinite(cfg.watchlistLimit)
      ? `${cfg.watchlistLimit} watchlist${cfg.watchlistLimit === 1 ? "" : "s"}`
      : "Unlimited watchlists"
  );
  return out;
}

function annualLine(plan: PlanName): string | undefined {
  const { monthly, annual } = PLANS[plan].price;
  const save = dollars(monthly) * 12 - dollars(annual);
  if (dollars(annual) <= 0) return undefined;
  return save > 0 ? `or ${annual}/year — save $${n(save)}` : `or ${annual}/year`;
}

export function pricingTiers(): PricingTier[] {
  return [
    {
      name: "Free",
      price: PLANS.Free.price.monthly,
      cadence: "",
      blurb: "A real taste of Finava.",
      features: features("Free"),
      cta: "Get started",
    },
    {
      name: "Analyst",
      price: PLANS.Analyst.price.monthly,
      cadence: "/ month",
      annual: annualLine("Analyst"),
      blurb: "Everything you need to research any stock.",
      features: features("Analyst"),
      cta: "Start with Analyst",
    },
    {
      name: "Pro",
      price: PLANS.Pro.price.monthly,
      cadence: "/ month",
      annual: annualLine("Pro"),
      blurb: "For investors who want headroom.",
      features: features("Pro"),
      cta: "Start with Pro",
      featured: true,
    },
  ];
}

export function trialLine(): string {
  return `Every account starts with a ${TRIAL_DAYS}-day ${TRIAL_PLAN} trial — no credit card required.`;
}
