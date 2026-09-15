# W3-1: One facts layer (stock page + Research on the same numbers)

**Wave 3 · merge 1st · port 3011 · branch `feat/w3-1-facts-layer`** · start from `main` with Waves 1–2 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W3-1-facts-layer.md in the same folder. Confirm Waves 1–2 are merged into main. Set up the worktree exactly as the README says (plan id w3-1-facts-layer, port 3011). Start with superpowers:brainstorming to confirm the Facts type with me before writing code, then superpowers:writing-plans for the detailed steps, then execute with TDD. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- 30 testers hit numbers that conflicted or were retracted across turns or pages. Every browser tester who visited a second surface found a contradiction.
- AAPL's rail shows 45 (D+) beside a Neutral verdict and a 58 in the Finava tab. Two DCF values come from different WACC inputs (`api/stock/[ticker]/score`, `finava-analysis`, `finavaInputs.ts`).
- Stale AI verdict prices are shown without an as-of time.

## Owned files
- new: `src/lib/facts/**` (`types.ts`, `ticker.ts`, `portfolio.ts`, `cache.ts`, tests)
- `src/lib/finavaInputs.ts`, `src/app/api/stock/[ticker]/score/**`, `src/app/api/stock/[ticker]/finava-analysis/**` (the data inputs, not the labels W1-4 fixed)
- stock page data hooks and components that display score, DCF or price; Research board data loaders
- `src/lib/quickContext.ts` (W2-1): re-implement on top of facts and keep its exported interface

**Do not touch:** chat prompts and ceo (W4-1 wires chat), `edgar.ts`/`factors.ts` internals (already fixed in W2-4; call them, don't change them unless there's a bug, and flag any change in the PR).

## Design (confirm in brainstorming)
```ts
type Fact<T> = { value: T | null; unit?: string; source: string; asOf: string; period?: string; note?: string };
interface TickerFacts {
  price: Fact<number>; change1d: Fact<number>; marketCap: Fact<number>; sharesOut: Fact<number>;
  pe: Fact<number>; evEbitda: Fact<number>; revenueTTM: Fact<number>; netIncomeTTM: Fact<number>;
  fcfTTM: Fact<number>; cashAndSTI: Fact<number>; debt: Fact<number>; beta: Fact<number>;
  dividendYield: Fact<number>; nextEarnings: Fact<{ date: string; estimated: boolean; epsEst?: number }>;
  score: Fact<{ total: number; grade: string; pillars: Record<string, number>; version: string }>;
  dcf: Fact<{ fairValue: number; wacc: number; growth: number; terminal: number; version: string }>;
}
getTickerFacts(ticker, { maxAgeSec }): Promise<TickerFacts>
getPortfolioFacts(userId): Promise<{ holdings: HoldingFact[]; totalValue: Fact<number>; cash: Fact<number>; weightsSum: number }>
```
- All derived numbers (P/E, EV/EBITDA, weights, DCF) are computed **here in code**, once, and versioned.
- One cache per ticker with a TTL per field (price 60 s intraday or until next open when closed; fundamentals 24 h). Failed fetches aren't cached (same rule as W1-2).

## Tasks
1. Build `facts/ticker.ts` and `facts/portfolio.ts` on the existing libs (quotes, edgar, factors, finnhub). Tests with fixtures: every field has a source and as-of, and missing data yields `value: null` + a note.
2. **One score**: find why the score route and the finava-analysis route disagree. Pick the deterministic 15-factor score (Finava Score v2) as canonical and delete or redirect the other computation. Every surface reads `facts.score`.
3. **One DCF**: a single WACC/growth input path in `finavaInputs.ts` → `facts.dcf`. The interactive DCF tab starts from those inputs; user tweaks are local only.
4. **Migrate surfaces**: stock page (rail, Finava tab, DCF tab, header), Research board and leaderboard, watchlist score pills, and the portfolio page totals. Every displayed price/score shows as-of on hover or small print.
5. Re-implement `quickContext.ts` on facts; its exports stay unchanged.
6. A consistency test: for 5 tickers, the score/DCF/price from each surface's loader are identical.

## Acceptance
- AAPL shows one score and one DCF on every surface (screenshots of the rail, Finava tab, Research board and watchlist).
- typecheck, lint and tests are green.
