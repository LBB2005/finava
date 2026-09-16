import { parseAnswer } from "@/lib/answerFormat";
import { lookupTerm } from "@/lib/glossary";

/**
 * Follow-up chips generated from the answer the user just read, not from their
 * question alone. Testers got chips about things the report never mentioned
 * because the old prompt only ever saw the prompt.
 */

export interface AnswerAnchors {
  /** Tickers the answer itself named, in order of first mention. */
  tickers: string[];
  /** What the answer admitted it could not cover. */
  gaps: string[];
  /** The bear-case bullets, the most chip-worthy part of a report. */
  bearPoints: string[];
}

const TICKER = /\b[A-Z]{1,5}(?:\.[A-Z])?\b/g;
// Words that look like tickers but never are.
const NOT_TICKERS = new Set([
  "A", "I", "AI", "US", "USA", "CEO", "CFO", "GDP", "EPS", "ETF", "IPO", "API", "FCF",
  "DCF", "RSI", "MACD", "SMA", "EMA", "TTM", "YOY", "CAGR", "ROE", "ROIC", "EV", "PE",
  "Q1", "Q2", "Q3", "Q4", "FY", "OK", "TAM", "ARR", "APY", "APR", "NAV", "AUM", "IRA",
]);

function bullets(md: string | undefined): string[] {
  if (!md) return [];
  return md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+/.test(l))
    .map((l) => l.replace(/^[-*+]\s+/, "").replace(/[*_`]/g, "").trim())
    .filter(Boolean);
}

/** The parts of an answer worth turning into a next question. */
export function answerAnchors(answerMarkdown: string): AnswerAnchors {
  const p = parseAnswer(answerMarkdown ?? "");

  const tickers: string[] = [];
  for (const m of (answerMarkdown ?? "").matchAll(TICKER)) {
    const t = m[0];
    if (NOT_TICKERS.has(t) || tickers.includes(t)) continue;
    tickers.push(t);
  }

  const gaps: string[] = [];
  if (p.confidence) gaps.push(p.confidence);
  for (const row of p.keyNumbers ?? []) {
    if (row.unavailable) gaps.push(`${row.metric} unavailable`);
  }

  return { tickers: tickers.slice(0, 4), gaps: gaps.slice(0, 4), bearPoints: bullets(p.bear).slice(0, 3) };
}

export const MAX_FOLLOWUPS = 3;
export const MAX_FOLLOWUP_CHARS = 40;

/** The prompt for the (cheap) chip call, built from the finished answer. */
export function answerFollowupPrompt(a: { question: string; answer: string }): string {
  const anchors = answerAnchors(a.answer);
  const lines = [
    `The user asked: ${a.question.slice(0, 200)}`,
    "",
    "They have just read this answer:",
    a.answer.slice(0, 2500),
    "",
  ];
  if (anchors.tickers.length) lines.push(`Tickers the answer named: ${anchors.tickers.join(", ")}`);
  if (anchors.gaps.length) lines.push(`Gaps the answer admitted: ${anchors.gaps.join("; ")}`);
  if (anchors.bearPoints.length) lines.push(`Bear points raised: ${anchors.bearPoints.join("; ")}`);
  lines.push(
    "",
    `Write up to ${MAX_FOLLOWUPS} follow-up research questions the reader would plausibly ask NEXT, each under ${MAX_FOLLOWUP_CHARS} characters.`,
    "Each one must follow from something in the answer above — a ticker it named, a gap it admitted, or a bear point it raised.",
    "Do not ask about anything the answer did not mention. Do not write definition questions (\"What is a P/E ratio?\") unless the user's own question was asking what something is.",
    "Return a JSON array of strings only, no other text."
  );
  return lines.join("\n");
}

// "What is a P/E ratio?" — a definition question about a glossary term. The
// subject has to BE a term, so "What are the risks?" is left alone.
const DEFINITION_CHIP = /^(?:what|who)\s+(?:is|are)\s+(?:an?|the)\s+(.+?)\?*$/i;
const GENERIC_TAIL = /\s+(ratio|ratios|multiple|multiples|score|rate|number|metric)$/i;
const ASKED_FOR_DEFINITION = /\b(what|explain|define|meaning|means)\b/i;

function isDefinitionChip(q: string): boolean {
  const subject = DEFINITION_CHIP.exec(q)?.[1];
  if (!subject) return false;
  return !!(lookupTerm(subject) ?? lookupTerm(subject.replace(GENERIC_TAIL, "")));
}

/**
 * Turn the model's raw reply into chips the UI can show: max three, each short,
 * no blanks, no duplicates, and no definition chips unless the user's question
 * was itself a definition question.
 */
export function parseFollowups(
  raw: string | null | undefined,
  opts: { question?: string } = {}
): string[] {
  if (!raw) return [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const allowDefinitions = ASKED_FOR_DEFINITION.test(opts.question ?? "");
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const q = item.trim();
    if (!q || q.length > MAX_FOLLOWUP_CHARS) continue;
    if (!allowDefinitions && isDefinitionChip(q)) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length === MAX_FOLLOWUPS) break;
  }
  return out;
}
