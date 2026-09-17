// What a question needs that Finava cannot get. Pure and client-safe.
//
// From the 13–14 Sep readout: 12 testers wanted "I can't answer X" up front,
// not a four-minute report that ends in "go check IBKR". And Discover answered
// Priya's ETF question with individual stocks, because the scout only knows
// stocks. This module decides both things before any model or crew runs.

export type Capability = "options" | "bondDuration" | "fundHoldings" | "fundFees" | "priceTargets";

export type DataAvailability = Record<Capability, boolean>;

/**
 * What the product can actually fetch today. Options: Polygon's options snapshot
 * returns 403 on our plan. Price targets: Finnhub's endpoint is premium-gated,
 * so they're available only when a ticker's facts carry one (pass that in).
 * Nothing in the stack serves bond analytics or fund holdings/fees.
 */
export const DEFAULT_AVAILABILITY: DataAvailability = {
  options: false,
  bondDuration: false,
  fundHoldings: false,
  fundFees: false,
  priceTargets: false,
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  options: "options-chain and implied-volatility data",
  bondDuration: "bond duration and yield data",
  fundHoldings: "fund holdings and weights",
  fundFees: "fund expense ratios",
  priceTargets: "analyst price targets",
};

const TICKER = "[A-Z]{1,5}";

const DETECTORS: Record<Capability, RegExp[]> = {
  options: [
    /\bimplied vol(atility)?\b/i,
    /\bIV\b/,
    /\boptions? (chain|flow|activity|data|volume|market|premium|positioning)\b/i,
    /\bput[/ -]call\b/i,
    /\bopen interest\b/i,
    /\b(greeks|gamma exposure|max pain)\b/i,
    /\b(call|put) options?\b/i,
    /\b(calls|puts) expir/i,
    /\bstrike prices?\b/i,
    /\bunusual options\b/i,
  ],
  bondDuration: [
    /\b(bond|effective|modified|macaulay) duration\b/i,
    new RegExp(`\\b[Dd]uration of ${TICKER}\\b`),
    /\bconvexity\b/i,
    /\byield to maturity\b/i,
  ],
  fundHoldings: [
    /\btop (\d+ )?holdings\b/i,
    /\b(etf|fund)'?s? (holdings|weights|weightings|constituents)\b/i,
    /\bholdings (of|in|inside) (the )?(etf|fund|[A-Z]{2,5}\b)/i,
    new RegExp(`\\bhow much ${TICKER} is (inside|in) ${TICKER}\\b`),
    new RegExp(`\\bwhat'?s (inside|in) ${TICKER}\\b`),
    /\b(fund|etf) overlap\b/i,
    /\boverlap between\b/i,
  ],
  fundFees: [/\bexpense ratios?\b/i, /\b(etf|fund|management) fees?\b/i],
  priceTargets: [/\b(price|analyst|street|consensus) targets?\b/i, /\btarget price\b/i],
};

const ORDER: Capability[] = ["options", "bondDuration", "fundHoldings", "fundFees", "priceTargets"];

/** A request for the whole picture: a gap is a caveat there, not a reason to stop. */
const BROAD =
  /\b(full|complete|comprehensive|deep|in-depth|thorough) (analysis|dive|report|breakdown|research|review)\b|\beverything\b|\banyway\b/i;

export function requiredData(question: string): Capability[] {
  return ORDER.filter((cap) => DETECTORS[cap].some((re) => re.test(question)));
}

export interface CapabilityResult {
  missing: { key: Capability; label: string }[];
  /** The question is mainly about data we can't get: answer fast and say so. */
  coreMissing: boolean;
}

export function checkCapabilities(question: string, availability: DataAvailability = DEFAULT_AVAILABILITY): CapabilityResult {
  const missing = requiredData(question)
    .filter((cap) => !availability[cap])
    .map((key) => ({ key, label: CAPABILITY_LABELS[key] }));
  return { missing, coreMissing: missing.length > 0 && !BROAD.test(question) };
}

function listLabels(r: CapabilityResult): string {
  const labels = r.missing.map((m) => m.label);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
}

/** Prompt lines for the fast lane: lead with the gap, then answer from what we have. */
export function capabilityPromptBlock(r: CapabilityResult, ticker: string | null): string {
  if (!r.missing.length) return "";
  const subject = ticker ? ` for ${ticker}` : "";
  const gap = listLabels(r);
  return `## Data Finava can't get for this question
Finava cannot get ${gap}. ${r.coreMissing
    ? `Open ## Answer with: "I can't get ${gap}${subject}, so here's what I can tell you…" and then answer from the data you do have.`
    : "Answer the rest of the question, and say plainly which part you couldn't cover."} Name the gap in ## Confidence & gaps. Never estimate the missing data or recall it from memory.`;
}

/** The crew's fast exit when the question hinges on data we can't get. */
export function cantAnswerResponse(r: CapabilityResult, ticker: string | null): { markdown: string; followups: string[] } {
  const gap = listLabels(r);
  const subject = ticker ?? "this stock";
  const markdown = `## Answer
I can't get ${gap}${ticker ? ` for ${ticker}` : ""}, so a full analysis can't answer this question, and I won't estimate it. Here's what I can tell you instead: price, valuation, filings, earnings date, insider activity and news are all available if you want them.

## Confidence & gaps
Low for this question: ${gap} ${r.missing.length > 1 ? "are" : "is"} not available in Finava.`;
  return {
    markdown,
    followups: [
      `What can you tell me about ${subject} from the data you have?`,
      `Run the full analysis on ${subject} anyway`,
    ],
  };
}

// ── Funds ────────────────────────────────────────────────────────────────────

const FUND_WORDS = /\b(etfs?|index funds?|mutual funds?|exchange[- ]traded funds?|bond funds?|target[- ]date funds?)\b/i;

/** Widely held funds people name without saying "ETF". */
const FUND_TICKERS = /\b(VOO|VTI|VT|IVV|SPY|QQQ|QQQM|VXUS|SCHD|SCHB|ITOT|VUG|VIG|VGT|BND|AGG|TLT|IWM|DIA|ARKK|VTSAX|FXAIX|SWPPX)\b/;

/** The message names a subject of its own (a stock, a sector), so history doesn't decide it. */
const OWN_SUBJECT = /\b(stocks?|shares|compan(y|ies)|sector|[A-Z]{2,5})\b/;

/**
 * Is this about ETFs or funds? `earlierUserTurns` (oldest first) covers a
 * clarification reply like "just tell me what's best", which only makes sense
 * against the question before it.
 */
export function isFundQuestion(text: string, earlierUserTurns: string[] = []): boolean {
  const about = (t: string) => FUND_WORDS.test(t) || FUND_TICKERS.test(t);
  if (about(text)) return true;
  if (OWN_SUBJECT.test(text)) return false;
  const previous = earlierUserTurns.at(-1);
  return previous != null && about(previous);
}

/** What Discover says instead of running the stock scout on a fund question. */
export function fundDiscoverResponse(): string {
  return `## Answer
Discover screens individual stocks, so it can't pick an ETF or fund for you, and it won't hand you single stocks as a stand-in. For ETFs, here's what to compare: the index or market the fund tracks, its expense ratio (the yearly fee, as a percent of what you invest), how many companies it spreads your money across, and whether you can buy fractional shares with small amounts.

## What would change the view
- Ask about specific funds by name or ticker and I'll pull the live data Finava has for them.

## Confidence & gaps
Low: Finava has no fund holdings or expense-ratio data, so those are Unavailable here.`;
}

/** Prompt rule for the fast lane when the question is about funds. */
export const FUND_ANSWER_RULE = `## Fund and ETF questions
This question is about ETFs or funds. Discover screens individual stocks, so if the user expected a screen, say that in one clause. Then answer about funds: what to compare (the index tracked, the expense ratio, how many holdings, minimum or fractional purchases). You must never present individual stocks as the answer to a fund question. Finava has no expense-ratio or fund-holdings data: write "Unavailable" for fees, holdings and weights instead of recalling them — remembered fund fees are often stale. A fund's price data in the FACTS block may be quoted with its citation.`;

// ── Extra facts a question needs ─────────────────────────────────────────────

/** Insider transactions: loaded only when the question is about them. */
export function wantsInsider(question: string): boolean {
  return /\binsiders?\b|\bform 4\b|\b(ceo|cfo|executives?|directors?|management|officers?)(['’]s)? .{0,20}\b(buy|bought|buying|sell|sold|selling|purchase[sd]?)\b/i.test(question);
}

/** The user's own book: loaded only when the question is about it. */
export function wantsPortfolio(question: string): boolean {
  return /\bmy (portfolio|holdings?|positions?|stake|shares|book|account|allocation|exposure|downside)\b|\bI (own|hold)\b/i.test(question);
}
