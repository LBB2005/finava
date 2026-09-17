/**
 * The fixed live scenario set: 20 prompts across every lane, drawn from what
 * Sep-14 testers actually typed. Some are follow-ups in the same conversation,
 * so lane switches are measured live too, not only in the smoke eval.
 *
 * `expect` is the lane the product decision says should answer ("fast grounded
 * answer by default, full crew only on request"). A mismatch is reported as a
 * routing miss. It does not fail the run.
 */
import type { Lane, SendMode } from "../lib/conversation";

export interface ScenarioTurn {
  mode: SendMode;
  text: string;
  expect: Lane;
}

export interface Scenario {
  id: string;
  portfolioContext?: string;
  holdings?: { ticker: string; shares: number }[];
  turns: ScenarioTurn[];
}

const BOOK = "NVDA 10 shares, AAPL 5 shares, MSFT 8 shares";
const HOLDINGS = [
  { ticker: "NVDA", shares: 10 },
  { ticker: "AAPL", shares: 5 },
  { ticker: "MSFT", shares: 8 },
];

export const SCENARIOS: Scenario[] = [
  {
    id: "verdict-then-escalate",
    turns: [
      { mode: "auto", text: "is it too late to buy nvidia stock i got 3k saved up", expect: "fast" },
      { mode: "auto", text: "so is that a yes or no lol too much reading", expect: "fast" },
      { mode: "full_analysis_button", text: "", expect: "full_analysis" },
      { mode: "auto", text: "summarize what you just told me in 3 bullets", expect: "fast" },
    ],
  },
  {
    id: "beginner-concepts",
    turns: [
      { mode: "auto", text: "whats the actual difference between a stock and an etf??", expect: "fast" },
      { mode: "auto", text: "ok so if i only have $100 a month which etf should i even look at", expect: "fast" },
    ],
  },
  {
    id: "discover-then-drill",
    turns: [
      { mode: "auto", text: "find cheap energy stocks", expect: "discover" },
      { mode: "auto", text: "why is the top pick on there?", expect: "fast" },
    ],
  },
  {
    id: "explicit-crew",
    portfolioContext: BOOK,
    holdings: HOLDINGS,
    turns: [
      { mode: "auto", text: "full analysis of AMD", expect: "full_analysis" },
      { mode: "auto", text: "what would change your view?", expect: "fast" },
    ],
  },
  {
    id: "portfolio",
    portfolioContext: BOOK,
    holdings: HOLDINGS,
    turns: [
      { mode: "auto", text: "how risky is my portfolio?", expect: "fast" },
      { mode: "auto", text: "what happens to me if tech drops 30%", expect: "fast" },
    ],
  },
  {
    id: "casual-momentum",
    turns: [
      { mode: "auto", text: "is PLTR still gonna pump or nah", expect: "fast" },
      { mode: "auto", text: "is COIN risky rn", expect: "fast" },
    ],
  },
  {
    id: "insider-arithmetic",
    turns: [{ mode: "auto", text: "did the Pfizer CEO buy or sell shares recently and how much", expect: "fast" }],
  },
  {
    id: "open-ended-clarify",
    turns: [
      { mode: "auto", text: "what should I buy?", expect: "clarify" },
      { mode: "auto", text: "Long-term", expect: "fast" },
    ],
  },
  {
    id: "deep-research",
    turns: [
      { mode: "deep_research", text: "deep research on SOFI's path to profitability", expect: "deep_research" },
      { mode: "auto", text: "give me the one-sentence version", expect: "fast" },
    ],
  },
  {
    id: "etf-question-not-stock-picks",
    turns: [{ mode: "auto", text: "best ETFs for a beginner putting $100 a month in", expect: "fast" }],
  },
];

export const TURN_COUNT = SCENARIOS.reduce((n, s) => n + s.turns.length, 0);
