import {
  getBasicFinancials,
  getCompanyNews,
  getEarningsCalendar,
  getQuote,
} from "@/lib/finnhub";
import { getFactorUniverse } from "@/lib/factorUniverse";
import { composite, grade } from "@/lib/research";
import { isValidTicker } from "@/lib/tickers";
import type { PageContext } from "@/lib/pageContext";

/**
 * The fast lane's grounding data.
 *
 * The 13–14 Sep beta readout: Quick chat answered in ~15 s and was never
 * collapsed — its answers were simply ungrounded, so people didn't trust them.
 * The crew was grounded and took four minutes. This module is the middle: the
 * handful of live numbers a "is X a buy?" answer actually needs, fetched in
 * parallel under a hard total budget, with anything slow dropped rather than
 * waited on.
 *
 * Every value carries its own source and as-of, and a value we could not get is
 * the literal string "Unavailable" — never a plausible stand-in.
 *
 * Deliberately small: the W3-1 facts layer replaces this, and the whole surface
 * it has to reproduce is `getQuickContext` + `renderQuickContext`.
 */

/** The one string a missing value is ever allowed to be. */
export const UNAVAILABLE = "Unavailable";

/** Total wall-clock budget for the whole fan-out. Slow sources are dropped. */
export const DEFAULT_BUDGET_MS = 2_500;

/** Most tickers we'll ground in one turn before the fan-out costs more than it's worth. */
const MAX_TICKERS = 3;

const MAX_HEADLINES = 5;

export interface QuickValue {
  /** Formatted for a human, or `UNAVAILABLE`. */
  value: string;
  /** Who said so, or `UNAVAILABLE`. */
  source: string;
  /** When it was true, or `UNAVAILABLE`. */
  asOf: string;
}

export interface QuickHeadline {
  headline: string;
  source: string;
  /** YYYY-MM-DD. Undated headlines are dropped, not guessed at. */
  date: string;
}

export type FactKey =
  | "price"
  | "change"
  | "marketCap"
  | "peTTM"
  | "epsTTM"
  | "range52w"
  | "dividendYield"
  | "nextEarnings"
  | "finavaScore";

export type QuickFacts = Record<FactKey, QuickValue>;

export interface QuickContext {
  /** The ticker the facts describe, or null when the question named none. */
  ticker: string | null;
  /** Every ticker in scope this turn (the first is `ticker`). */
  tickers: string[];
  facts: QuickFacts;
  headlines: QuickHeadline[];
  /** ISO instant the fan-out ran, so a later turn can judge staleness. */
  fetchedAt: string;
  /** Sources that failed or missed the budget, named so the answer can say so. */
  dropped: string[];
}

export interface QuickContextInput {
  /** Tickers found in the user's message. */
  tickers: string[];
  pageContext?: PageContext | null;
  portfolioContext?: string;
  budgetMs?: number;
}

// ── Formatting ───────────────────────────────────────────────────────────────

const FACT_LABELS: Record<FactKey, string> = {
  price: "Price",
  change: "Change (1d)",
  marketCap: "Market cap",
  peTTM: "P/E (TTM)",
  epsTTM: "EPS (TTM)",
  range52w: "52-week range",
  dividendYield: "Dividend yield",
  nextEarnings: "Next earnings",
  finavaScore: "Finava score",
};

const FACT_ORDER = Object.keys(FACT_LABELS) as FactKey[];

function unavailable(): QuickValue {
  return { value: UNAVAILABLE, source: UNAVAILABLE, asOf: UNAVAILABLE };
}

function emptyFacts(): QuickFacts {
  return Object.fromEntries(FACT_ORDER.map((k) => [k, unavailable()])) as QuickFacts;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function usd(n: number | null): string | null {
  if (n == null) return null;
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(2)}`;
}

/** Market cap arrives from Finnhub in millions of USD. */
function usdFromMillions(n: number | null): string | null {
  return n == null ? null : usd(n * 1e6);
}

/** Build a value, or `Unavailable` when the formatted figure came back null. */
function value(v: string | null, source: string, asOf: string | null): QuickValue {
  if (v == null || asOf == null) return unavailable();
  return { value: v, source, asOf };
}

// ── Budget ───────────────────────────────────────────────────────────────────

/**
 * Race one source against the shared deadline.
 *
 * Resolves null — and records the source's name in `dropped` — when it rejects
 * or runs past the deadline. A dropped source is never awaited further: the
 * answer goes out with the data that arrived, and says what didn't.
 */
function within<T>(
  name: string,
  deadlineMs: number,
  run: () => Promise<T>,
  dropped: string[]
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = Math.max(0, deadlineMs - Date.now());
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budget);
  });
  let started: Promise<T | null>;
  try {
    started = run();
  } catch {
    dropped.push(name);
    return Promise.resolve(null);
  }
  return Promise.race([started.catch(() => null), timeout]).then((v) => {
    if (timer) clearTimeout(timer);
    if (v == null) dropped.push(name);
    return v;
  });
}

// ── Ticker selection ─────────────────────────────────────────────────────────

/**
 * Which tickers this turn is about: the ones named in the message, else the one
 * pinned by the page being viewed. Holdings are deliberately NOT expanded — a
 * portfolio question is answered from `portfolioContext`, not by fanning out
 * across every position inside a 2.5 s budget.
 */
export function pickTickers(input: {
  tickers: string[];
  pageContext?: PageContext | null;
}): string[] {
  const named = input.tickers.map((t) => t.toUpperCase()).filter(isValidTicker);
  const fromPage = input.pageContext?.ticker?.toUpperCase();
  const all = named.length ? named : fromPage && isValidTicker(fromPage) ? [fromPage] : [];
  return [...new Set(all)].slice(0, MAX_TICKERS);
}

// ── Sources ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function readHeadlines(raw: unknown): QuickHeadline[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .filter((n) => typeof n.headline === "string" && n.headline && num(n.datetime))
    .sort((a, b) => (num(b.datetime) ?? 0) - (num(a.datetime) ?? 0))
    .slice(0, MAX_HEADLINES)
    .map((n) => ({
      headline: String(n.headline),
      source: typeof n.source === "string" && n.source ? n.source : UNAVAILABLE,
      date: isoDay(new Date((num(n.datetime) ?? 0) * 1000)),
    }));
}

/** The calendar's own date IS the fact; `asOf` is when we read the calendar. */
function readNextEarnings(raw: unknown): QuickValue {
  const rows = (raw as { earningsCalendar?: Record<string, unknown>[] } | null)?.earningsCalendar;
  if (!Array.isArray(rows)) return unavailable();
  const today = isoDay(new Date());
  const next = rows
    .filter((r) => typeof r.date === "string" && r.date >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  if (!next) return unavailable();
  return value(String(next.date), "Finnhub earnings calendar", isoDay(new Date()));
}

/**
 * The deterministic Finava score, read from the warm 15-minute factor universe
 * memo. Cheap when warm and dropped by the budget when cold — which is exactly
 * the "if cheap" the plan asks for.
 */
function readScore(universe: unknown, ticker: string): QuickValue {
  const u = universe as { asOf?: string; stocks?: { ticker: string; f: Record<string, number> }[] } | null;
  const stock = u?.stocks?.find((s) => s.ticker === ticker);
  if (!stock || !u?.asOf) return unavailable();
  try {
    const score = composite(stock as never, "month");
    // A row missing a factor makes the weighted sum NaN. "NaN (F)" is a
    // fabricated grade; a score we cannot compute is simply Unavailable.
    if (!Number.isFinite(score)) return unavailable();
    return value(`${score} (${grade(score)})`, "Finava factor model", u.asOf);
  } catch {
    return unavailable();
  }
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/**
 * Fetch the fast lane's grounding facts for a turn, in parallel, under one
 * shared deadline.
 */
export async function getQuickContext(input: QuickContextInput): Promise<QuickContext> {
  const tickers = pickTickers(input);
  const ticker = tickers[0] ?? null;
  const dropped: string[] = [];
  const base: QuickContext = {
    ticker,
    tickers,
    facts: emptyFacts(),
    headlines: [],
    fetchedAt: new Date().toISOString(),
    dropped,
  };
  if (!ticker) return base;

  const deadline = Date.now() + (input.budgetMs ?? DEFAULT_BUDGET_MS);
  const now = new Date();
  const newsFrom = isoDay(new Date(now.getTime() - 14 * DAY_MS));
  const earningsTo = isoDay(new Date(now.getTime() + 120 * DAY_MS));

  const [quote, financials, news, earnings, universe] = await Promise.all([
    within("quote", deadline, () => getQuote(ticker), dropped),
    within("key stats", deadline, () => getBasicFinancials(ticker), dropped),
    within("news", deadline, () => getCompanyNews(ticker, newsFrom, isoDay(now)), dropped),
    within("earnings date", deadline, () => getEarningsCalendar(isoDay(now), earningsTo, ticker), dropped),
    within("score", deadline, () => getFactorUniverse(), dropped),
  ]);

  const facts = emptyFacts();

  if (quote) {
    facts.price = value(usd(num(quote.price)), "Finnhub quote", quote.asOf ?? null);
    const pct = num(quote.changePct);
    facts.change = value(
      pct == null ? null : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      "Finnhub quote",
      quote.asOf ?? null
    );
  }

  if (financials) {
    const m = (financials as { metric?: Record<string, unknown> }).metric ?? {};
    const src = "Finnhub basic financials";
    const asOf = isoDay(now);
    facts.marketCap = value(usdFromMillions(num(m.marketCapitalization)), src, asOf);
    const pe = num(m.peTTM) ?? num(m.peBasicExclExtraTTM);
    facts.peTTM = value(pe == null ? null : pe.toFixed(1), src, asOf);
    const eps = num(m.epsTTM) ?? num(m.epsBasicExclExtraItemsTTM);
    facts.epsTTM = value(usd(eps), src, asOf);
    const hi = num(m["52WeekHigh"]);
    const lo = num(m["52WeekLow"]);
    facts.range52w = value(hi != null && lo != null ? `${usd(lo)}–${usd(hi)}` : null, src, asOf);
    const dy = num(m.dividendYieldIndicatedAnnual) ?? num(m.currentDividendYieldTTM);
    facts.dividendYield = value(dy == null ? null : `${dy.toFixed(2)}%`, src, asOf);
  }

  if (earnings) facts.nextEarnings = readNextEarnings(earnings);
  if (universe) facts.finavaScore = readScore(universe, ticker);

  return { ...base, facts, headlines: news ? readHeadlines(news) : [] };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render the context as the compact markdown block the fast-lane prompt fences.
 *
 * Every row is present even when its value is `Unavailable`: the model must see
 * the gap explicitly so it reports it rather than reaching for a number it half
 * remembers.
 */
export function renderQuickContext(qc: QuickContext): string {
  if (!qc.ticker) return "No ticker in scope for this turn — no market data was fetched.";

  const lines: string[] = [`Live data for ${qc.ticker} (fetched ${qc.fetchedAt}):`, ""];
  lines.push("| Metric | Value | Source | As of |");
  lines.push("| --- | --- | --- | --- |");
  for (const k of FACT_ORDER) {
    const f = qc.facts[k];
    lines.push(`| ${FACT_LABELS[k]} | ${f.value} | ${f.source} | ${f.asOf} |`);
  }

  lines.push("", "Recent headlines:");
  if (qc.headlines.length) {
    for (const h of qc.headlines) lines.push(`- ${h.date} — ${h.headline} (${h.source})`);
  } else {
    lines.push(`- ${UNAVAILABLE}`);
  }

  if (qc.dropped.length) {
    lines.push("", `Not retrieved in time this turn: ${qc.dropped.join(", ")}.`);
  }
  return lines.join("\n");
}
