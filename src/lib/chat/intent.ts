import { extractTickers } from "@/lib/tickers";
import type { PageContext } from "@/lib/pageContext";
import { cleanClarify, type ClarifyQuestion } from "./clarify";

/**
 * Auto-mode intents.
 *
 * The 13–14 Sep beta readout: Auto sent 80 of 138 turns to the 15-agent crew,
 * median 253 s, one solo run 382 s — past the 300 s platform cap. 48/50 testers
 * complained about the wait, and 13 brevity requests ("yes or no", "3 bullets")
 * each started a brand-new crew run.
 *
 * So the crew is now opt-in. `fast` is the default lane: a grounded answer from
 * live data in under 10 s. `full_analysis` fires only when the user asks for it
 * in words or presses the button.
 */
export type Intent = "fast" | "discover" | "clarify" | "full_analysis";

export const INTENTS: readonly Intent[] = ["fast", "discover", "clarify", "full_analysis"] as const;

// ── The router model's prompt ────────────────────────────────────────────────

/**
 * What the router model is asked. Lives here, beside the rules that hold it to
 * its answer, so `scripts/test-routing.ts` can score the real prompt rather
 * than a copy that drifts.
 */
export const ROUTER_SYSTEM_PROMPT = `You are the router for Finava, an AI stock-research chat. Classify the user's latest message into ONE intent.

Intents:
- "fast": THE DEFAULT. Any question that can be answered from live market data and reasoning — verdicts on a named stock ("is TSLA a buy?", "is it too late to buy NVDA?", "should I worry about AMD's margins?"), questions about the user's portfolio, definitions and concepts ("what's a P/E ratio?"), greetings, and every conversational follow-up ("simpler", "yes or no", "what about the risks?").
- "discover": the user wants to FIND/SCREEN stocks WITHOUT naming specific tickers (e.g. "find cheap energy stocks", "best AI plays right now", "ideas for dividend income").
- "full_analysis": ONLY when the user EXPLICITLY asks for the full multi-agent research crew — "full analysis of X", "deep dive on X", "run the crew", "research report on X", "comprehensive analysis". A question that merely names a ticker is "fast", NOT "full_analysis". A full analysis takes minutes; choosing it when the user did not ask for it is the single worst thing you can do.
- "clarify": ask before answering. ONLY when ALL hold: the request is open-ended discovery or advice ("what should I buy?", "what's good right now?"), AND no ticker is named, AND no page context pins a subject, AND the message states no amount, horizon, sector or experience level. Bias HARD against this.

When intent is "clarify", ask 1-3 questions — only the ones whose answer would really change what you recommend; usually just 1. Each question has:
- "header": 1-2 words, shown on a tab (e.g. "Horizon", "Amount", "Style")
- "question": one short, friendly sentence
- "options": 2-4 tappable choices, each a short "label" (1-4 words) and a one-line "description" (under 8 words) saying what picking it means
The app adds its own "Other" free-text choice, so never include one.

Respond with ONLY a JSON object, no prose. "clarify" is present only when intent is "clarify":
{"intent":"fast|discover|full_analysis|clarify","clarify":[{"header":"Horizon","question":"What's your time horizon?","options":[{"label":"Long term","description":"3+ years, quality compounders"},{"label":"Swing","description":"Weeks to months, momentum"}]}]}`;

// ── Explicit crew requests ───────────────────────────────────────────────────

/**
 * Wording that unambiguously asks for the multi-agent crew.
 *
 * Deliberately narrow. "analyze MSFT" and "is NVDA a buy" are NOT here: the
 * readout shows those are people wanting an answer, not a 4-minute report. A
 * false positive here costs four minutes; a false negative costs one click.
 */
const CREW_PATTERNS: RegExp[] = [
  /\bfull\s+(analysis|report|research|breakdown|work ?up|write ?up|rundown)\b/i,
  /\bdeep\s+(dive|research|analysis)\b/i,
  /\b(run|deploy|unleash|send in)\s+(the\s+)?(crew|team|agents|analysts|full\s+\w+)\b/i,
  /\bresearch\s+report\b/i,
  /\b(comprehensive|complete|in[- ]depth|thorough|exhaustive)\s+(analysis|research|report|review|breakdown)\b/i,
  /\beverything\s+you\s+(know|have|can\s+find)\s+(on|about)\b/i,
  /\bfull\s+(crew|team)\b/i,
];

/** True when the message explicitly asks for the full multi-agent crew. */
export function wantsFullAnalysis(text: string): boolean {
  return CREW_PATTERNS.some((re) => re.test(text));
}

// ── Reformat / short follow-ups ──────────────────────────────────────────────

/**
 * Follow-ups that re-cut the answer we just gave rather than asking something
 * new. These reuse the previous turn's data instead of refetching (and must
 * never restart a crew run — 13 testers hit exactly that).
 */
const REUSE_PATTERNS: RegExp[] = [
  /\byes\s+or\s+no\b/i,
  /\b(simpler|simplify|shorter|briefer|condense|summari[sz]e that)\b/i,
  /\btl;?\s?dr\b/i,
  /\beli\s?5\b/i,
  /\bin\s+plain\s+english\b/i,
  /\b(just\s+)?(\d+|a\s+few)\s+bullets?\b/i,
  /^\s*(and|but|so|ok|okay)?\s*(what about|how about)\s+(the\s+)?(risks?|downside|upside|bear|bull|valuation|competition|debt|margins?)\b/i,
  /^\s*(and\s+)?(the\s+)?(risks?|bear case|bull case|downside|upside)\s*\??\s*$/i,
  /^\s*(why|how come|says who|really)\s*\??\s*$/i,
  /\b(explain|say)\s+(that|it)\s+(again|more\s+simply|simply)\b/i,
];

/** True when the message is a reformat/meta follow-up on the previous answer. */
export function isReuseFollowUp(text: string): boolean {
  return REUSE_PATTERNS.some((re) => re.test(text));
}

// ── Subject resolution ───────────────────────────────────────────────────────

/** Phrases that make the user's own holdings the subject of the turn. */
const HOLDINGS_RE = /\b(my|our)\s+(portfolio|holdings|positions|stocks|book)\b/i;

/**
 * Does this turn already have something concrete to answer about?
 *
 * A ticker in the message, the ticker of the page being viewed, any non-stock
 * page the question can scope to, or the user's own holdings all count. When
 * this is true we must never ask "which stock?" — the subject is already known.
 */
export function hasSubject(a: {
  userPrompt: string;
  pageContext?: PageContext | null;
  portfolioContext?: string;
}): boolean {
  if (extractTickers(a.userPrompt).length > 0) return true;
  if (a.pageContext) return true;
  if (a.portfolioContext && HOLDINGS_RE.test(a.userPrompt)) return true;
  return false;
}

/**
 * Cues that a broad "what should I buy?" is already specified enough to answer.
 *
 * From the readout's Priya case: she gave the amount, her experience level and
 * a 10-year goal, and Auto still asked her a clarifying question. ONE of these
 * is enough to screen on — "ideas for dividend income" already says the style,
 * and asking "what are you optimising for?" back is the same insult in miniature.
 */
const SPECIFICITY_CUES: RegExp[] = [
  /(\$\s?[\d,]+|\b[\d,]+\s?(k|dollars|usd)\b)/i, // an amount
  /\b(beginner|new to (this|investing)|first[- ]time|experienced|advanced|novice)\b/i, // a level
  /\b(long[- ]term|short[- ]term|\d+\s*(year|yr|month)s?|retirement|growth|income|dividend|value|safe|aggressive|conservative)\b/i, // a goal/horizon
  /\b(tech|energy|healthcare|financials?|industrials?|utilities|consumer|semis?|semiconductors?|biotech|reits?|banks?)\b/i, // a sector
];

function isAlreadySpecific(text: string): boolean {
  return SPECIFICITY_CUES.some((re) => re.test(text));
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface ResolvedIntent {
  intent: Intent;
  /** The questions to ask, only when `intent` is "clarify". */
  clarify?: ClarifyQuestion[];
}

export interface IntentContext {
  userPrompt: string;
  pageContext?: PageContext | null;
  portfolioContext?: string;
  /** False on the turn right after we already asked a clarifying question. */
  allowClarify?: boolean;
  /** The user pressed "Run full analysis" — wording no longer matters. */
  forceFullAnalysis?: boolean;
}

function rawIntent(parsed: Record<string, unknown> | null): Intent | null {
  const raw = String(parsed?.intent ?? "");
  return (INTENTS as readonly string[]).includes(raw) ? (raw as Intent) : null;
}

/**
 * Turn the router model's raw JSON into the intent we will actually run.
 *
 * The model proposes; these rules dispose. Every downgrade here is a readout
 * failure we are refusing to repeat, so they hold even when the model is
 * confident it knows better.
 */
export function resolveIntent(
  parsed: Record<string, unknown> | null,
  ctx: IntentContext
): ResolvedIntent {
  const { userPrompt, allowClarify = true, forceFullAnalysis = false } = ctx;
  const raw = rawIntent(parsed);

  // A reformat of the answer we just gave: always fast, never a new crew run.
  if (isReuseFollowUp(userPrompt) && !forceFullAnalysis) return { intent: "fast" };

  // The crew is opt-in — in words or by button. Nothing else reaches it.
  if (forceFullAnalysis || wantsFullAnalysis(userPrompt)) return { intent: "full_analysis" };
  if (raw === "full_analysis") return { intent: "fast" };

  if (raw === "clarify") {
    const clarify = cleanClarify(parsed);
    const known = hasSubject(ctx);
    // A clarify only earns its round-trip when we have no subject, nothing
    // specific to go on, a real question to ask, and haven't just asked one.
    if (allowClarify && !known && !isAlreadySpecific(userPrompt) && clarify) {
      return { intent: "clarify", clarify };
    }
    // Suppressed: a clarify is only ever raised on open-ended discovery, so a
    // known subject means answer it, and an unknown one means go screen.
    return { intent: known ? "fast" : "discover" };
  }

  if (raw === "discover") return { intent: "discover" };
  return { intent: "fast" };
}
