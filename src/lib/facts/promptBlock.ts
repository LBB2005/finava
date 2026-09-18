// Facts → the block a prompt quotes from. Client-safe: no I/O.
//
// Every fact gets a stable ID (`[F:AAPL.pe]`). The model must cite that ID next
// to any number it writes, and may only write numbers that are in the block —
// including every comparison, which is precomputed here rather than left for
// the model to work out. `citations.ts` checks the answer against the same
// entries afterwards, so a number the model got wrong is replaced, not shipped.

import { hasValue, type Fact, type PortfolioFacts, type TickerFacts } from "./types";
import { edgarFilingsUrl, pctChange, positionShocks, weightChangePts, type InsiderFacts } from "./precomputed";
import { sanitizeExperienceLevel, experiencePromptLine, type ExperienceLevel } from "@/lib/experienceLevel";

export const UNAVAILABLE = "Unavailable";

/**
 * How a value is written and compared.
 * usd: dollars · pct: an unsigned share (40.0%) · chg: a signed change (-6.7%)
 * pts: percentage points · ratio: a multiple (51.3x) · number: plain decimal
 * count: an integer · text: not numeric (dates, grades) — never number-checked.
 */
export type FactKind = "usd" | "pct" | "chg" | "pts" | "ratio" | "number" | "count" | "text";

export interface FactEntry {
  id: string;
  label: string;
  kind: FactKind;
  /** Numeric value in display units (percents as 12.5, not 0.125). Null when missing. */
  value: number | null;
  /** The value as it should appear in an answer, or "Unavailable". */
  text: string;
  source: string;
  asOf: string;
  period?: string;
  url?: string;
  note?: string;
}

export interface FactsInput {
  tickers?: TickerFacts[];
  portfolio?: PortfolioFacts | null;
  insider?: InsiderFacts[];
}

// ── Formatting ───────────────────────────────────────────────────────────────

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function usd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  // Cents are kept when there are any; "$4,000.00" reads as false precision.
  const cents = Math.round(a * 100) % 100 !== 0;
  return `${sign}$${a.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })}`;
}

const signed = (n: number, digits: number) => `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;

export function formatFactValue(kind: FactKind, value: number | null): string {
  if (!finite(value)) return UNAVAILABLE;
  switch (kind) {
    case "usd": return usd(value);
    case "pct": return `${value.toFixed(1)}%`;
    case "chg": return `${signed(value, 1)}%`;
    case "pts": return `${signed(value, 1)} pts`;
    case "ratio": return `${value.toFixed(1)}x`;
    case "count": return Math.round(value).toLocaleString("en-US");
    default: return value.toFixed(2);
  }
}

/** The date part of an as-of, which is what a reader needs. */
function day(asOf: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(asOf) ? asOf.slice(0, 10) : asOf;
}

/** Filing-backed facts link to the filing index even when read from an older cache. */
function urlFor(f: Pick<Fact<unknown>, "source" | "url">, ticker: string | null): string | undefined {
  if (f.url) return f.url;
  if (ticker && f.source.startsWith("SEC EDGAR")) return edgarFilingsUrl(ticker);
  return undefined;
}

// ── Collection ───────────────────────────────────────────────────────────────

class Collector {
  readonly entries: FactEntry[] = [];

  add(id: string, label: string, kind: FactKind, f: Fact<unknown>, value: number | null, ticker: string | null) {
    const present = f.value != null && finite(value);
    const e: FactEntry = {
      id, label, kind,
      value: present ? value : null,
      text: present ? formatFactValue(kind, value) : UNAVAILABLE,
      source: f.source,
      asOf: f.asOf,
    };
    if (f.period) e.period = f.period;
    const url = urlFor(f, ticker);
    if (url) e.url = url;
    if (f.note) e.note = f.note;
    this.entries.push(e);
  }

  text(id: string, label: string, f: Fact<unknown>, render: string | null, ticker: string | null) {
    const e: FactEntry = { id, label, kind: "text", value: null, text: f.value != null && render ? render : UNAVAILABLE, source: f.source, asOf: f.asOf };
    const url = urlFor(f, ticker);
    if (url) e.url = url;
    if (f.note) e.note = f.note;
    this.entries.push(e);
  }

  /** Which side of a reference level the price is on, in words — so a sign can't be misread. */
  side(id: string, label: string, price: number | null, level: number | null, what: string, basis: Fact<unknown>[]) {
    const ok = finite(price) && finite(level) && basis.every((b) => b.value != null);
    const words = !ok ? UNAVAILABLE : price! > level! ? `Price is above ${what}` : price! < level! ? `Price is below ${what}` : `Price equals ${what}`;
    this.entries.push({
      id, label, kind: "text", value: null, text: words,
      source: `Computed: price compared with ${what}`,
      asOf: basis.map((b) => b.asOf).sort().at(-1) ?? new Date().toISOString(),
    });
  }

  /** A fact computed from others: present only when every input is. */
  computed(id: string, label: string, kind: FactKind, value: number | null, formula: string, basis: Fact<unknown>[], whyMissing: string) {
    const ok = finite(value) && basis.every((b) => b.value != null);
    const asOf = basis.map((b) => b.asOf).sort().at(-1) ?? new Date().toISOString();
    this.entries.push({
      id, label, kind,
      value: ok ? value : null,
      text: ok ? formatFactValue(kind, value) : UNAVAILABLE,
      source: `Computed: ${formula}`,
      asOf,
      ...(ok ? {} : { note: whyMissing }),
    });
  }
}

const val = <T,>(f: Fact<T>) => (hasValue(f) ? f.value : null);

function collectTicker(c: Collector, t: TickerFacts) {
  const T = t.ticker.toUpperCase();
  const n = (key: string, label: string, kind: FactKind, f: Fact<number>) => c.add(`${T}.${key}`, `${T} ${label}`, kind, f, val(f), T);

  const price = val(t.price);
  n("price", "price", "usd", t.price);
  n("change1d", "change today", "chg", t.change1d);
  n("marketCap", "market cap", "usd", t.marketCap);
  n("sharesOut", "shares outstanding", "count", t.sharesOut);
  n("pe", "P/E (TTM)", "ratio", t.pe);
  n("evEbitda", "EV/EBITDA (TTM)", "ratio", t.evEbitda);
  n("epsTTM", "EPS (TTM)", "usd", t.epsTTM);

  const range = val(t.range52w);
  c.add(`${T}.low52w`, `${T} 52-week low`, "usd", t.range52w, range?.low ?? null, T);
  c.add(`${T}.high52w`, `${T} 52-week high`, "usd", t.range52w, range?.high ?? null, T);
  const noRange = "Needs a price and the 52-week range";
  c.computed(`${T}.pctFrom52wHigh`, `${T} % from 52-week high`, "chg", pctChange(price, range?.high), "price ÷ 52-week high − 1", [t.price, t.range52w], noRange);
  c.computed(`${T}.pctFrom52wLow`, `${T} % from 52-week low`, "chg", pctChange(price, range?.low), "price ÷ 52-week low − 1", [t.price, t.range52w], noRange);

  n("revenueTTM", "revenue (TTM)", "usd", t.revenueTTM);
  n("netIncomeTTM", "net income (TTM)", "usd", t.netIncomeTTM);
  n("fcfTTM", "free cash flow (TTM)", "usd", t.fcfTTM);
  const revenue = val(t.revenueTTM);
  const share = (x: number | null) => (x != null && revenue != null && revenue > 0 ? (x / revenue) * 100 : null);
  c.computed(`${T}.netMarginTTM`, `${T} net margin (TTM)`, "pct", share(val(t.netIncomeTTM)), "net income ÷ revenue (TTM)", [t.netIncomeTTM, t.revenueTTM], "Needs net income and revenue for the same four quarters");
  c.computed(`${T}.fcfMarginTTM`, `${T} free-cash-flow margin (TTM)`, "pct", share(val(t.fcfTTM)), "free cash flow ÷ revenue (TTM)", [t.fcfTTM, t.revenueTTM], "Needs free cash flow and revenue for the same four quarters");
  n("cash", "cash & short-term investments", "usd", t.cashAndSTI);
  n("debt", "total debt", "usd", t.debt);
  n("beta", "beta", "number", t.beta);
  n("dividendYield", "dividend yield", "pct", t.dividendYield);

  const earnings = val(t.nextEarnings);
  c.text(`${T}.nextEarnings`, `${T} next earnings date`, t.nextEarnings, earnings ? `${earnings.date}${earnings.estimated ? " (estimated)" : ""}` : null, T);

  n("streetTarget", "Street price target", "usd", t.streetTarget);
  const target = val(t.streetTarget);
  c.computed(`${T}.upsideToStreetTarget`, `${T} upside from price to Street target (negative means the price is above the target)`, "chg", pctChange(target, price), "Street target ÷ price − 1", [t.streetTarget, t.price], "Needs a price and a Street target");
  c.side(`${T}.priceVsStreetTarget`, `${T} price vs Street target`, price, target, "the Street target", [t.price, t.streetTarget]);

  const score = val(t.score);
  c.add(`${T}.score`, `${T} Finava Score (0-100)`, "count", t.score, score?.total ?? null, T);
  c.text(`${T}.grade`, `${T} Finava grade`, t.score, score?.grade ?? null, T);

  const dcf = val(t.dcf);
  c.add(`${T}.dcfFairValue`, `${T} DCF fair value per share`, "usd", t.dcf, dcf?.fairValue ?? null, T);
  c.computed(`${T}.upsideToDcf`, `${T} upside from price to DCF fair value (negative means the price is above fair value)`, "chg", pctChange(dcf?.fairValue, price), "DCF fair value ÷ price − 1", [t.dcf, t.price], "Needs a price and a DCF fair value");
  c.side(`${T}.priceVsDcf`, `${T} price vs DCF fair value`, price, dcf?.fairValue ?? null, "DCF fair value", [t.price, t.dcf]);
}

function collectInsider(c: Collector, i: InsiderFacts) {
  const T = i.ticker;
  c.add(`${T}.insider.buyTotal`, `${T} insider open-market buys, total value`, "usd", i.buyTotal, val(i.buyTotal), T);
  c.add(`${T}.insider.buyCount`, `${T} insider open-market buys, count`, "count", i.buyCount, val(i.buyCount), T);
  c.add(`${T}.insider.sellTotal`, `${T} insider open-market sales, total value`, "usd", i.sellTotal, val(i.sellTotal), T);
  c.add(`${T}.insider.sellCount`, `${T} insider open-market sales, count`, "count", i.sellCount, val(i.sellCount), T);
  const b = val(i.largestBuy);
  const who = b ? `: ${b.name}, ${b.shares.toLocaleString("en-US")} shares @ $${b.price.toFixed(2)} on ${b.date}` : "";
  c.add(`${T}.insider.largestBuy`, `${T} largest insider buy${who}`, "usd", i.largestBuy, b?.value ?? null, T);
  c.add(`${T}.insider.largestBuyShares`, `${T} largest insider buy, shares`, "count", i.largestBuy, b?.shares ?? null, T);
  c.add(`${T}.insider.largestBuyPrice`, `${T} largest insider buy, price per share`, "usd", i.largestBuy, b?.price ?? null, T);
}

function collectPortfolio(c: Collector, p: PortfolioFacts) {
  c.add("PORT.total", "Portfolio total value (holdings + cash)", "usd", p.totalValue, val(p.totalValue), null);
  c.add("PORT.cash", "Portfolio cash", "usd", p.cash, val(p.cash), null);

  // Weights at cost share today's denominator shape: holdings at cost + cash.
  const costTotal = p.holdings.reduce((a, h) => a + h.shares * (val(h.costBasis) ?? 0), 0) + (val(p.cash) ?? 0);

  for (const h of p.holdings) {
    const T = h.ticker.toUpperCase();
    const mv = val(h.marketValue);
    const cost = val(h.costBasis);
    const costValue = cost != null ? cost * h.shares : null;
    c.add(`PORT.${T}.value`, `Your ${T} position value`, "usd", h.marketValue, mv, T);
    const w = val(h.weight);
    c.add(`PORT.${T}.weight`, `Your ${T} weight of portfolio`, "pct", h.weight, w != null ? w * 100 : null, T);
    c.add(`PORT.${T}.costBasis`, `Your ${T} average cost per share`, "usd", h.costBasis, cost, T);

    const noPrice = "Needs a live price for the position";
    c.computed(`PORT.${T}.pnl`, `Your ${T} unrealized P&L`, "usd", mv != null && costValue != null ? mv - costValue : null, "position value − shares × average cost", [h.marketValue, h.costBasis], noPrice);
    c.computed(`PORT.${T}.pnlPct`, `Your ${T} unrealized P&L %`, "chg", pctChange(mv, costValue), "position value ÷ cost − 1", [h.marketValue, h.costBasis], noPrice);
    c.computed(
      `PORT.${T}.weightChange`, `Your ${T} weight change since purchase`, "pts",
      weightChangePts(w, costValue != null && costTotal > 0 ? costValue / costTotal : null),
      "weight now − weight at cost", [h.weight, h.costBasis], noPrice
    );
    for (const s of positionShocks(mv)) {
      c.computed(`PORT.${T}.down${s.shockPct}`, `Your ${T} position $ change if ${T} falls ${s.shockPct}%`, "usd", s.loss, `position value × −${s.shockPct}%`, [h.marketValue], noPrice);
    }
  }
}

export function collectFacts(input: FactsInput): FactEntry[] {
  const c = new Collector();
  for (const t of input.tickers ?? []) collectTicker(c, t);
  for (const i of input.insider ?? []) collectInsider(c, i);
  if (input.portfolio) collectPortfolio(c, input.portfolio);
  return c.entries;
}

export function indexFacts(entries: FactEntry[]): Map<string, FactEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function renderFactsBlock(entries: FactEntry[]): string {
  if (!entries.length) return "No facts were retrieved for this turn. Every market or portfolio number is \"Unavailable\".";
  return entries
    .map((e) => {
      if (e.value == null && e.kind !== "text" || e.text === UNAVAILABLE) {
        return `[F:${e.id}] ${e.label} = ${UNAVAILABLE}${e.note ? ` (${e.note})` : ""}`;
      }
      const period = e.period ? ` · period ${e.period}` : "";
      const note = e.note ? ` · ${e.note}` : "";
      return `[F:${e.id}] ${e.label} = ${e.text} · ${e.source} · as of ${day(e.asOf)}${period}${note}`;
    })
    .join("\n");
}

/** The rule every facts-grounded prompt carries. */
export const FACT_CITATION_RULE = `## Citing facts — NON-NEGOTIABLE
- Every number you write about a security or the user's portfolio must come from the FACTS block, written exactly as the block writes it, followed immediately by its ID: "trades 6.7% below its 52-week high [F:NVDA.pctFrom52wHigh]". In the Key numbers table, put the ID right after the value in the Value cell.
- Never calculate, convert, re-total or round a number yourself. Differences, percentages, upside, dollar downside, P&L and weight changes are already precomputed in the block — quote those. If the comparison you want is not in the block, don't make it: no ratios, multiples or "x times" comparisons of your own (e.g. "a 22:1 buy/sell ratio").
- A number that is not in the block (or is listed as Unavailable) is "${UNAVAILABLE}". Do not recall it from memory — fees, targets, holdings and past prices from memory are stale.
- Numbers quoted from a sub-agent's report that are not in the block may be used only with that agent named as the source, and never recomputed.`;

/** How much to explain, from the reader's experience level. */
export function readerBlock(level: ExperienceLevel | undefined): string {
  const lvl = sanitizeExperienceLevel(level);
  const lines = [experiencePromptLine(lvl)];
  if (lvl === "beginner") {
    lines.push(
      "Define each finance term inline, in plain words, the first time you use it (e.g. \"P/E — the price divided by a year of profit per share\").",
      "Skip technical-analysis indicators (RSI, MACD, moving averages) entirely.",
      "Keep ## Answer to 3-5 sentences, each short, and keep the whole answer short."
    );
  }
  return `## Reader\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
