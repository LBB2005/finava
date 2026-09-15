// The portfolio block handed to chat and the crew, with every figure computed.
//
// Left to the model, portfolio arithmetic went wrong in ways users noticed: one
// answer put MRNA at 55.9% of a book where it was 15.3%, and allocations summed
// to 110–125%. So the totals, weights and P&L are computed here, weights are
// rounded to sum to exactly 100.0% (largest remainder), and the model is told to
// quote them verbatim. A holding without a live quote is "Unavailable" and left
// out of the total and the weights — never priced at cost or a guess.
//
// Keep the rendered text free of uppercase acronyms: the CEO extracts ticker
// symbols from this block (agentMemory.extractTickers), so a stray "ET" or "MV"
// would be treated as a stock.

import type { Quote } from "@/types/portfolio";

export interface PortfolioHoldingInput {
  ticker: string;
  shares: number;
  /** Average cost PER SHARE. */
  avgCost: number;
  companyName?: string | null;
  sector?: string | null;
}

export interface PortfolioRow {
  ticker: string;
  shares: number;
  price: number | null;
  marketValue: number | null;
  costBasis: number;
  pnl: number | null;
  pnlPct: number | null;
  dayPct: number | null;
  /** 1-dp weight of total value (holdings + cash); null when unpriced. */
  weightPct: number | null;
}

export interface ComputedPortfolio {
  rows: PortfolioRow[];
  cash: number;
  /** Priced holdings + cash. */
  totalValue: number;
  cashWeightPct: number | null;
  /** Cost basis and P&L across priced holdings only. */
  pricedCostBasis: number;
  pricedPnl: number;
  unpriced: string[];
  /** Latest quote time, when the quotes carry one. */
  quotedAt: number | null;
}

/** Round shares of `values` to 0.1% so the rounded parts sum to exactly 100.0. */
function roundedWeights(values: number[], total: number): number[] {
  const tenths = values.map((v) => (v / total) * 1000);
  const floors = tenths.map(Math.floor);
  let remaining = 1000 - floors.reduce((a, b) => a + b, 0);
  const order = tenths
    .map((t, i) => ({ i, frac: t - Math.floor(t) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remaining <= 0) break;
    floors[i] += 1;
    remaining -= 1;
  }
  return floors.map((f) => f / 10);
}

export function computePortfolio(
  holdings: PortfolioHoldingInput[],
  cashBalance: number,
  quoteMap?: Map<string, Quote>
): ComputedPortfolio {
  const cash = cashBalance > 0 ? cashBalance : 0;
  let quotedAt: number | null = null;

  const rows: PortfolioRow[] = holdings.map((h) => {
    const quote = quoteMap?.get(h.ticker);
    const price = quote && Number.isFinite(quote.price) && quote.price > 0 ? quote.price : null;
    if (price !== null && quote?.timestamp) {
      const ms = quote.timestamp < 1e12 ? quote.timestamp * 1000 : quote.timestamp;
      quotedAt = Math.max(quotedAt ?? 0, ms);
    }
    const costBasis = h.avgCost * h.shares;
    const marketValue = price !== null ? price * h.shares : null;
    const pnl = marketValue !== null ? marketValue - costBasis : null;
    return {
      ticker: h.ticker,
      shares: h.shares,
      price,
      marketValue,
      costBasis,
      pnl,
      pnlPct: pnl !== null && costBasis > 0 ? (pnl / costBasis) * 100 : null,
      dayPct: price !== null && Number.isFinite(quote?.changePct) ? quote!.changePct : null,
      weightPct: null,
    };
  });

  const priced = rows.filter((r) => r.marketValue !== null);
  const totalValue = priced.reduce((s, r) => s + r.marketValue!, 0) + cash;

  let cashWeightPct: number | null = null;
  if (totalValue > 0) {
    const weights = roundedWeights([...priced.map((r) => r.marketValue!), cash], totalValue);
    priced.forEach((r, i) => (r.weightPct = weights[i]));
    cashWeightPct = weights[weights.length - 1];
  }

  return {
    rows,
    cash,
    totalValue,
    cashWeightPct,
    pricedCostBasis: priced.reduce((s, r) => s + r.costBasis, 0),
    pricedPnl: priced.reduce((s, r) => s + r.pnl!, 0),
    unpriced: rows.filter((r) => r.marketValue === null).map((r) => r.ticker),
    quotedAt,
  };
}

const UNAVAILABLE = "Unavailable";

const usd = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (n: number) => (n >= 0 ? `+${usd(n)}` : usd(n));
const signedPct = (n: number, dp: number) => `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;
const pnlCell = (pnl: number | null, pct: number | null) =>
  pnl === null ? UNAVAILABLE : pct === null ? signedUsd(pnl) : `${signedUsd(pnl)} (${signedPct(pct, 1)})`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function asOfLabel(ms: number): string {
  // Numeric month + our own labels: ICU's short month varies ("Sep" vs "Sept").
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = String(parseInt(get("hour"), 10) % 24).padStart(2, "0"); // Intl can emit "24"
  return `${get("day")} ${MONTHS[parseInt(get("month"), 10) - 1]} ${get("year")}, ${hour}:${get("minute")} US/Eastern`;
}

/**
 * The portfolio as a computed markdown table for a prompt. Empty string for an
 * empty account (callers treat "" as "no portfolio").
 */
export function buildPortfolioContext(
  holdings: PortfolioHoldingInput[],
  cashBalance: number,
  quoteMap?: Map<string, Quote>,
  now: Date = new Date()
): string {
  if (holdings.length === 0 && !(cashBalance > 0)) return "";

  const p = computePortfolio(holdings, cashBalance, quoteMap);
  const weight = (w: number | null) => (w === null ? UNAVAILABLE : `${w.toFixed(1)}%`);

  const lines: string[] = [
    `Computed by Finava from the user's holdings. Prices as of ${asOfLabel(p.quotedAt ?? now.getTime())}.`,
    "",
    "| Ticker | Shares | Price | Market value | Weight | Cost basis | Unrealized P&L | Today |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of p.rows) {
    lines.push(
      `| ${r.ticker} | ${r.shares} | ${r.price === null ? UNAVAILABLE : usd(r.price)} | ${
        r.marketValue === null ? UNAVAILABLE : usd(r.marketValue)
      } | ${weight(r.weightPct)} | ${usd(r.costBasis)} | ${pnlCell(r.pnl, r.pnlPct)} | ${
        r.dayPct === null ? UNAVAILABLE : signedPct(r.dayPct, 2)
      } |`
    );
  }
  lines.push(`| Cash | — | — | ${usd(p.cash)} | ${weight(p.cashWeightPct)} | — | — | — |`);
  const pricedPnlPct = p.pricedCostBasis > 0 ? (p.pricedPnl / p.pricedCostBasis) * 100 : null;
  lines.push(
    `| **Total** | — | — | ${usd(p.totalValue)} | ${p.totalValue > 0 ? "100.0%" : UNAVAILABLE} | ${usd(
      p.pricedCostBasis
    )} | ${p.rows.length > p.unpriced.length ? pnlCell(p.pricedPnl, pricedPnlPct) : UNAVAILABLE} | — |`
  );
  lines.push("");
  lines.push(
    p.totalValue > 0
      ? "Weights sum: 100.0% (holdings + cash)."
      : "Weights sum: Unavailable (no holding could be priced)."
  );
  if (p.unpriced.length) {
    lines.push(
      `Note: ${p.unpriced.join(", ")} ${p.unpriced.length === 1 ? "has" : "have"} no live quote — price, market value, weight and P&L are Unavailable, and ${
        p.unpriced.length === 1 ? "it is" : "they are"
      } excluded from the total and the weights.`
    );
  }
  const described = holdings.filter((h) => h.companyName || h.sector);
  if (described.length) {
    lines.push(
      `Names: ${described
        .map((h) => `${h.ticker}${h.companyName ? ` = ${h.companyName}` : ""}${h.sector ? ` (sector: ${h.sector})` : ""}`)
        .join("; ")}.`
    );
  }
  lines.push("Use these weights verbatim; do not recompute. Quote market values, weights and P&L from this table only.");
  return lines.join("\n");
}
