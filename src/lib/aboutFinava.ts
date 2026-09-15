// "What is Finava and what does it cost?" — public product facts for the chat prompt.
//
// Chat used to refuse "does this app cost money?" as if it were advice. Plan names,
// prices and limits are read from plans.ts (the single source of truth) so this
// block can never drift from what the Pricing page and billing actually do.

import { PLANS, PLAN_ORDER, TRIAL_DAYS, TRIAL_PLAN, type PlanConfig } from "./plans";

const crewRuns = (n: number) =>
  Number.isFinite(n) ? `${n} full crew analyses per month` : "full crew analyses (fair use)";

function planLine(cfg: PlanConfig, free: boolean): string {
  const extras = [
    crewRuns(cfg.deepResearchPerMonth),
    Number.isFinite(cfg.watchlistLimit)
      ? `${cfg.watchlistLimit} watchlist${cfg.watchlistLimit === 1 ? "" : "s"}`
      : "unlimited watchlists",
    cfg.capabilities.plaidLinking ? "brokerage linking" : "no brokerage linking",
    cfg.capabilities.weeklyBriefings ? "weekly AI market briefings" : "no weekly briefings",
  ];
  const price = free ? cfg.price.monthly : `${cfg.price.monthly}/month or ${cfg.price.annual}/year`;
  return `- **${cfg.label}** (${price}): ${extras.join(", ")}.`;
}

export function aboutFinavaBlock(): string {
  const plans = PLAN_ORDER.filter((n) => n === "Free" || PLANS[n].stripe.purchasable).map((n) =>
    planLine(PLANS[n], n === "Free")
  );
  return [
    "## About Finava",
    "Finava is an AI stock-research app: a research chat (quick answers, or a full crew of specialist analyst agents on request), stock pages with the Finava Score and an interactive DCF, a Research board and screener, watchlists, and a portfolio view (manual holdings, or a linked brokerage on paid plans). It publishes impersonal research, not personalized advice.",
    "Plans (each includes a usage allowance):",
    ...plans,
    `New accounts get a ${TRIAL_DAYS}-day ${TRIAL_PLAN} trial with no card required.`,
    "Questions about Finava itself (what it does, what it costs, plans, the free tier) are public product information: answer them directly and briefly from this section. Prices and limits can change; the Pricing page is authoritative.",
  ].join("\n");
}
