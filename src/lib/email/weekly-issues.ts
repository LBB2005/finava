import type { WeeklyUpdateInput } from "./templates";

/**
 * Drafted weekly updates for the waitlist, newest last.
 *
 * To send next week: copy the last entry, bump the issue number, rewrite the
 * copy, and add it to the end. `latestIssue()` always returns the final entry.
 * Preview any issue at /api/admin/weekly (admin only) before sending.
 */
export const WEEKLY_ISSUES: WeeklyUpdateInput[] = [
  {
    issueLabel: "Issue #1",
    headline: "Welcome — here's what we're building",
    intro:
      "Thanks for being early. Finava is an AI analyst team for self-directed investors — instead of one chatbot, a crew of agents that research a stock the way a real desk would: fundamentals, valuation, sentiment, and the bear case, each argued out and brought back to you.\nWe'll keep these notes short and weekly, so you can watch it come together.",
    highlights: [
      "<strong>The lenses.</strong> Board scores the full S&P 500 on real fundamentals and ranks it; Screen turns a plain-English brief into a factor screen across the same universe.",
      "<strong>Real data, no hand-waving.</strong> Live fundamentals, prices, and analyst coverage — not vibes.",
      "<strong>Your early-access perk.</strong> Waitlist members get 3 months of Pro free when we open the doors.",
    ],
    cta: { label: "See what's coming", href: "https://finava.ai/#how" },
    signoff: "More next week,\n— The Finava team",
  },
];

export function latestIssue(): WeeklyUpdateInput {
  return WEEKLY_ISSUES[WEEKLY_ISSUES.length - 1];
}

export function issueByIndex(i: number): WeeklyUpdateInput | undefined {
  return WEEKLY_ISSUES[i];
}
