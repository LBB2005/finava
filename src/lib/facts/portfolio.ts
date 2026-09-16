// src/lib/facts/portfolio.ts
// A user's book as facts. The arithmetic (totals, rounded weights) is
// computePortfolio's — the same numbers chat already quotes — wrapped with
// sources and as-of, and priced from the facts layer's quote cache.
import { db } from "@/lib/firebase-admin";
import { computePortfolio, type PortfolioHoldingInput } from "@/lib/portfolioContext";
import { runPooled } from "@/lib/stockData";
import type { Quote } from "@/types/portfolio";
import { getTickerQuoteFacts } from "./ticker";
import { fact, missing, toSlim, type PortfolioFacts, type HoldingFact, type TickerFacts } from "./types";

type QuoteFacts = Pick<TickerFacts, "ticker" | "price" | "change1d" | "score">;

const SRC = {
  quote: "Finnhub quote",
  marketValue: "Computed: price × shares",
  weight: "Computed: market value ÷ total value (holdings + cash)",
  total: "Computed: priced holdings + cash",
  holdings: "Your holdings",
  cash: "Your portfolio settings",
  score: "Finava Score v2 (15 factors)",
} as const;

const UNPRICED = "No live price; excluded from totals";

export function buildPortfolioFacts(
  holdings: PortfolioHoldingInput[],
  cashBalance: number,
  facts: Map<string, QuoteFacts>,
  now: Date
): PortfolioFacts {
  const iso = now.toISOString();
  const quoteMap = new Map<string, Quote>();
  for (const h of holdings) {
    const f = facts.get(h.ticker.toUpperCase());
    if (f?.price.value != null) {
      quoteMap.set(h.ticker, {
        ticker: h.ticker, price: f.price.value, change: 0,
        changePct: f.change1d.value ?? Number.NaN, timestamp: Date.parse(f.price.asOf),
      });
    }
  }
  const p = computePortfolio(holdings, cashBalance, quoteMap);
  const asOf = p.quotedAt != null ? new Date(p.quotedAt).toISOString() : iso;

  const rows: HoldingFact[] = p.rows.map((r, i) => {
    const h = holdings[i];
    const f = facts.get(h.ticker.toUpperCase());
    const price = f?.price ?? missing<number>(SRC.quote, "No live price", iso);
    return {
      ticker: r.ticker,
      shares: r.shares,
      price,
      marketValue: r.marketValue == null ? missing(SRC.marketValue, UNPRICED, iso) : fact(r.marketValue, { source: SRC.marketValue, asOf: price.asOf, unit: "USD" }),
      weight: r.weightPct == null ? missing(SRC.weight, UNPRICED, iso) : fact(r.weightPct / 100, { source: SRC.weight, asOf, unit: "fraction" }),
      costBasis: fact(h.avgCost, { source: SRC.holdings, asOf: iso, unit: "USD" }),
      score: toSlim({ ticker: r.ticker, score: f?.score ?? missing(SRC.score, "Not scored yet", iso) }).score,
    };
  });

  const nothingPriced = holdings.length > 0 && p.unpriced.length === holdings.length && p.cash === 0;
  const weightsSum = Math.round(
    (rows.reduce((s, r) => s + (r.weight.value ?? 0), 0) + (p.cashWeightPct ?? 0) / 100) * 1e4
  ) / 1e4;

  return {
    holdings: rows,
    totalValue: nothingPriced
      ? missing(SRC.total, "No holdings could be priced", iso)
      : fact(p.totalValue, { source: SRC.total, asOf, unit: "USD", note: p.unpriced.length ? `Excludes unpriced: ${p.unpriced.join(", ")}` : undefined }),
    cash: fact(p.cash, { source: SRC.cash, asOf: iso, unit: "USD" }),
    weightsSum,
  };
}

export async function getPortfolioFacts(userId: string, opts: { now?: () => Date } = {}): Promise<PortfolioFacts> {
  const now = opts.now ?? (() => new Date());
  const user = db.collection("users").doc(userId);
  const [holdSnap, settingsSnap] = await Promise.all([
    user.collection("holdings").orderBy("ticker").get(),
    user.collection("portfolioSettings").doc("default").get(),
  ]);
  const holdings: PortfolioHoldingInput[] = holdSnap.docs.map((d) => {
    const x = d.data() as Record<string, unknown>;
    return { ticker: String(x.ticker ?? d.id).toUpperCase(), shares: Number(x.shares) || 0, avgCost: Number(x.avgCost) || 0 };
  });
  const cash = Number((settingsSnap.exists ? settingsSnap.data() : undefined)?.cashBalance) || 0;
  // Pooled: a large book shouldn't burst the shared Finnhub rate limit.
  const loaded = await runPooled(holdings.map((h) => () => getTickerQuoteFacts(h.ticker, { now })), 3);
  const facts = new Map(loaded.flatMap((f) => (f ? [[f.ticker, f] as const] : [])));
  return buildPortfolioFacts(holdings, cash, facts, now());
}
