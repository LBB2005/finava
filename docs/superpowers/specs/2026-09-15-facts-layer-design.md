# W3-1 Facts layer: design

**Date:** 2026-09-15 · **Plan:** `docs/superpowers/plans/2026-09-beta-fixes/W3-1-facts-layer.md` · **Branch:** `feat/w3-1-facts-layer`

## Problem

Testers saw two scores and two DCF values for one stock.

- **Two scores.** The rail's Score cell, watchlist pills, portfolio rows and the Research board read `composite()` (6 universe factors, `src/lib/research.ts`). The Finava tab and cached verdict read `computeFinavaScore()` (15 factors, 6 pillars, `src/lib/finavaScore.ts`). AAPL: 45 (D+) in the rail, 58 in the Finava tab.
- **Two DCFs.** `finavaInputs.computeDcfBundle` uses `suggestedWaccFromBeta(null)` (flat 9%) and EDGAR shares only. `api/stock/[ticker]/dcf` uses the real beta (7–13%) and a marketCap÷price shares fallback. The Finava tab then blends its DCF with the Street target and calls the blend "fair value".
- Prices and AI verdicts are shown without an as-of.

## Decisions

1. **One score:** the 15-factor Finava Score is canonical. It is cached globally per ticker. A list row shows it when cached and "—" when not. The 6-factor universe composite is only a *ranking* input: it's labelled as a rank or percentile and never shown as a 0–100 score or a letter grade.
2. **One DCF:** `facts.dcf` is a pure DCF built from one input path. The Street target is its own fact. A surface that wants a blend calls `blendFairValue(dcf, street)` and labels it as a blend.
3. **Cache:** two tiers. Fast fields are cached in process; score and DCF go in a global Firestore doc.
4. **Portfolio:** `getPortfolioFacts` is built in full. `portfolio/page.tsx` only gets its score source changed, because W3-3 owns the rest of that file.
5. **Transport:** new `/api/facts` routes and a `useTickerFacts` hook. `/api/stock/[ticker]/score` and `/dcf` become thin readers of facts.

## 1. Types (`src/lib/facts/types.ts`)

```ts
export interface Fact<T> {
  value: T | null;
  unit?: string;     // "USD" | "%" | "x" | "shares"
  source: string;    // always set, including when value is null
  asOf: string;      // ISO instant or YYYY-MM-DD; always set
  period?: string;   // "TTM" | "FY2025" | "Q3 2026"
  note?: string;     // required when value === null
}

export const SCORE_VERSION = "finava-score-v2";
export const DCF_VERSION = "dcf-v1";

export interface ScoreFact {
  total: number; grade: string;
  pillars: PillarScore[];                 // from finavaScore.ts, factors included
  confidence: "Low" | "Moderate" | "High";
  coverage: number;
  peerPremiumPct: number | null;          // P/E & P/S premium vs peers, for the verdict card
  version: string;
}

export interface DcfFact {
  fairValue: number; wacc: number; growth: number; terminal: number;
  inputs: DcfInputs;                      // the DCF tab's sliders start from these
  version: string;
}

export interface TickerFacts {
  ticker: string;
  price: Fact<number>; change1d: Fact<number>;
  marketCap: Fact<number>; sharesOut: Fact<number>;
  pe: Fact<number>; evEbitda: Fact<number>; epsTTM: Fact<number>;
  range52w: Fact<{ low: number; high: number }>;
  revenueTTM: Fact<number>; netIncomeTTM: Fact<number>; fcfTTM: Fact<number>;
  cashAndSTI: Fact<number>; debt: Fact<number>;
  beta: Fact<number>; dividendYield: Fact<number>;
  nextEarnings: Fact<{ date: string; estimated: boolean; epsEst?: number }>;
  streetTarget: Fact<number>;
  score: Fact<ScoreFact>;
  dcf: Fact<DcfFact>;
  dropped: string[];                      // sources that failed or missed the deadline
}

// Score only. List rows keep their existing live price feeds: batching 50 quotes
// through Finnhub per poll would burst its 60/min limit.
export interface TickerFactsSlim {
  ticker: string;
  score: Fact<Pick<ScoreFact, "total" | "grade" | "version">>;
}

export interface HoldingFact {
  ticker: string;
  shares: number;
  price: Fact<number>;
  marketValue: Fact<number>;
  weight: Fact<number>;         // fraction of totalValue, computed here
  costBasis: Fact<number>;      // per share (Plaid convention)
  score: TickerFactsSlim["score"];
}

export interface PortfolioFacts {
  holdings: HoldingFact[];
  totalValue: Fact<number>;
  cash: Fact<number>;
  weightsSum: number;           // ≈1 when every holding is priced
}
```

Constructors `fact(value, meta)` and `missing(source, note, asOf?)` are the only way to build a Fact. `missing` requires a note, so a null value always explains itself. `fact` takes an optional `missingNote` that applies only if the value turns out to be missing, so a present value never carries a "why it's missing" note.

### What gets derived in code (once, here)

- `pe` = `price ÷ epsTTM`. Null with a note when EPS ≤ 0 ("loss-making, P/E not meaningful"). The same computed value feeds `ScoreInputs.peTTM`. `peerPe` stays on Finnhub's basis, so the peer ratio mixes bases slightly. That's accepted and noted in a code comment.
- `evEbitda` = `(marketCap + debt − cashAndSTI) ÷ EBITDA TTM`. Null with a note when EBITDA isn't available or is ≤ 0.
- `marketCap` = `price × sharesOut` when both exist. Otherwise the Finnhub figure, with its source named.
- `dcf`: WACC = `suggestedWaccFromBeta(beta)`, growth = `defaultGrowthFor(inputs)`, terminal = 2.5%. Shares come from EDGAR, falling back to marketCap÷price. One function in `finavaInputs.ts` (`buildDcfInputs`) builds the inputs. `computeDcfBundle` and the DCF route both call it.
- Portfolio `weight` = `marketValue ÷ totalValue`, where totalValue includes cash.

## 2. Loaders

- `getTickerFacts(ticker, { maxAgeSec?, cachedOnly? }): Promise<TickerFacts>` in `facts/ticker.ts`. It fans out to the existing libs (finnhub, edgar, stockData, finavaInputs, finavaScore, dcf). Each source is failure-isolated: one source failing nulls only its own fields, each with a note. `cachedOnly` never runs the expensive score/DCF assembly.
- `getTickerFactsSlim(tickers)` does batch reads from the score cache only and never calls a market-data vendor.
- `getTickerQuoteFacts(ticker)` returns price, day change and the cached score, which is all a holdings row needs.
- `getPortfolioFacts(userId)` in `facts/portfolio.ts` reads holdings the same way the portfolio API does today, prices them with `getTickerQuoteFacts`, and computes weights with `computePortfolio` (the same arithmetic chat already quotes).
- `edgar.ts` and `factors.ts` are called, not changed. Any bug fix there gets flagged in the PR.

## 3. Cache (`facts/cache.ts`)

| Fields | TTL | Store |
|---|---|---|
| price, change1d | 60 s while the market is open; until the next open while closed (`marketSession.isMarketOpen`) | in process (`globalThis`) |
| fundamentals, beta, range, dividend, earnings date, Street target | 24 h | in process |
| score, dcf | 24 h | Firestore `factsCache/{TICKER}` (global, not per user) |

- A doc whose `version` doesn't match `SCORE_VERSION` / `DCF_VERSION` counts as a miss.
- Only successful computes are written, never a null or failed result (the W1-2 rule).
- Concurrent cold calls for the same ticker share one in-flight promise, like `factorUniverse.ts` does.
- `maxAgeSec` lets a caller demand fresher data than the default TTL.

## 4. Transport

- `GET /api/facts/[ticker]` returns full `TickerFacts` and computes on a miss. It's public and rate-limited like the current score route.
- `GET /api/facts?tickers=A,B,C` returns `{ facts: TickerFactsSlim[] }`, cache only, capped at 50 tickers.
- `src/hooks/useTickerFacts.ts` and `useTickerFactsSlim(tickers)` wrap them in SWR.
- `/api/stock/[ticker]/score` keeps its path but reads `facts.score` and returns `{ ticker, score, grade, pillars, asOf, version }`. It returns 404 only when the ticker isn't found. A null score comes back as `score: null` with the note.
- `/api/stock/[ticker]/dcf` keeps `{ ticker, inputs }`, sourced from `facts.dcf.value.inputs`.
- `/api/stock/[ticker]/finava-analysis` takes its pillars and DCF from `getTickerFacts`. The narrative keeps its LLM call, and a successful computed score is written to the facts cache.

## 5. Surfaces migrated

| Surface | Before | After |
|---|---|---|
| Rail Score cell | universe composite | `facts.score` (total + grade, as-of on hover) |
| Rail Fair value | DCF route + local default | `facts.dcf.fairValue` |
| Overview pillar bars (`StockTabs`) | 6 universe factors | the 6 score pillars |
| Finava tab | streamed pillars + blended FV | the same stream, now from facts. FV is labelled "Blend of DCF and Street target" when both exist |
| DCF tab | `/dcf` inputs | `facts.dcf.value.inputs`; slider changes stay local |
| Stock header price | quote | adds an as-of line in small print |
| Watchlist pills | `compositeScore()` | slim `facts.score`, or "—" |
| Research board rows | composite score + grade | rank/percentile from the universe; the score column shows slim `facts.score` or "—" |
| Portfolio rows | `scoreForTicker()` | slim `facts.score` (a one-line call-site change; W3-3 owns the file) |
| `quickContext.ts` | its own Finnhub fan-out + composite | formats `getTickerFacts` (under its 2.5 s budget, with `cachedOnly` for score). Exports are unchanged |

`compositeScore.ts` is deleted once the watchlist and portfolio move off it. A separate `factorRank` helper would have no caller, so none is built; ranking stays on `composite()` / `ranked()` in `research.ts`. The rule going forward: only `facts.score` may be called a score or carry a grade. Other universe consumers (DNA lens, live routes, scout agent, `verdict.ts`) keep using the universe for ranking and aren't changed.

## 6. Errors and honesty

- Every null has a note. The UI renders "Unavailable" or "—" and shows the note on hover. There are no stand-in numbers.
- A ticker with no SEC CIK (ETFs, foreign names) gets `dcf` null ("No SEC filings") and `score` computed from whatever inputs exist. `computeFinavaScore` already reweights for missing pillars and reports coverage and confidence.
- In `/api/facts/[ticker]`, total upstream failure still returns 200 with all fields null and noted. A 4xx is only for an invalid ticker.

## 7. Testing (vitest, TDD)

- `types.test.ts`: `fact` / `missing` invariants.
- `ticker.test.ts`: with mocked libs and fixtures, every field has a non-empty source and asOf; each source failing on its own nulls exactly its own fields with notes; derived P/E, EV/EBITDA, marketCap and DCF math; `cachedOnly` never calls the score assembly.
- `cache.test.ts`: TTL boundaries (open vs closed market), version mismatch counts as a miss, failures aren't written, in-flight dedupe.
- `portfolio.test.ts`: weights sum to 1 with cash; an unpriced holding gets a null weight with a note and is left out of `totalValue`, whose note names it.
- `consistency.test.ts`: for 5 fixture tickers, the score, DCF fair value and price from `/api/facts/[ticker]`, `/api/stock/[ticker]/score`, `/dcf`, the slim batch, `getPortfolioFacts` and `quickContext` are identical. The score is assembled once per ticker however many surfaces read it.
- Route tests are updated for the new score/dcf response shapes.

## Out of scope

Chat prompts and `ceo.ts` (W4-1), `edgar.ts`/`factors.ts` internals, portfolio layout and holdings CRUD (W3-3), and a batch warm-up cron for the S&P 500 score.

## Acceptance

AAPL shows one score and one DCF on the rail, Finava tab, Research board and watchlist (screenshots). `npm run typecheck && npm run lint && npm test` are green, and the coverage threshold isn't lowered.
