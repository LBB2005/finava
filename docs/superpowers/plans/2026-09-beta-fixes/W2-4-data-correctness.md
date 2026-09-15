# W2-4: Data correctness (the feeds are fine; our parsing isn't)

**Wave 2 · merge 1st · port 3014 · branch `fix/w2-4-data-correctness`** · start from `main` with all of Wave 1 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W2-4-data-correctness.md in the same folder. Set up the worktree exactly as the README says (plan id w2-4-data-correctness, port 3014), then execute the plan with superpowers:systematic-debugging for each bug and TDD (write the failing test from real fixture data first). Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
The fact-check found feeds reliable; errors came from our data layer:
- **SEC financials** (`src/lib/edgar.ts`, `api/stock/[ticker]/financials`): off-calendar fiscal years (AAPL, MSFT, COST) lose quarters and blank the TTM statements; JPM's "latest" quarters are from 2013–14; cash excludes marketable securities.
- **Insider agent** (`insider-agent.ts`): the Form 4 purchase parser never matches, and 20 undated rows are called "last 90 days".
- **Earnings agent** (`earnings-agent.ts:30`): takes the later of two calendar rows (COST Dec 9 instead of Sep 24) with the wrong quarter's EPS consensus.
- **Split-unadjusted market cap** (`factors.ts:353–356, 425–427`): BKNG shows a $5.7B cap and P/E around 1, lifting its value score to 98.

## Owned files
- `src/lib/edgar.ts`, `src/app/api/stock/[ticker]/financials/**`
- `src/agents/sub-agents/insider-agent.ts`, `earnings-agent.ts` (+ their tests)
- `src/lib/factors.ts` (+ tests)
- new: `src/lib/__fixtures__/sec/*.json` (trimmed real companyfacts snippets), `src/lib/__fixtures__/form4/*`

**Do not touch:** chat/agents orchestration, UI.

## Tasks
1. **Fixtures first**: fetch and trim real SEC companyfacts for AAPL (FY ends Sep), MSFT (Jun), COST (Aug/Sep, 52/53-week), JPM (calendar, very long history), and one 10-K-only filer. Keep only the tags you need, so files stay under 200 KB (large companyfacts skip Next's fetch cache; that's harmless, but don't commit megabytes).
2. **Fiscal periods**: derive quarters from `fp`/`fy` + `frame` + `end` dates rather than calendar assumptions. Compute Q4 as FY minus Q1–Q3 when only 10-K annuals exist. "Latest" is the max `end` date, never the first array element. TTM = the sum of the last 4 quarters by end date. Tests per fixture: latest quarter end date, TTM revenue and net income against the filed numbers (check them against the 10-Q/10-K and put the expected values in test comments with their source).
3. **Cash**: add a `cashAndShortTermInvestments` field (cash + marketable securities current). Keep `cash` as it is and label both explicitly in the API response.
4. **Form 4**: fix the purchase-code match (transaction code `P`; also handle `S`, `A`, `M`, `F` explicitly). Every row carries its transaction date. The window label is computed from the actual min/max dates ("12 transactions, 3 Jun–9 Sep"); undated rows are excluded and counted.
5. **Earnings date**: choose the **nearest future** row (≥ today in US/Eastern), falling back to the most recent past row labelled "last reported". Match the EPS consensus to that row's fiscal quarter. Mark estimated dates as `estimated: true` so prompts say "expected".
6. **Split-adjusted market cap**: use current shares outstanding (the latest dei `EntityCommonStockSharesOutstanding` or a quote-feed market cap) × current price. Never mix split-unadjusted historic shares with the current price. Add a sanity guard: if the computed cap differs from the feed's cap by more than 3×, prefer the feed and log it. BKNG fixture test: P/E in a plausible range and value score no longer 98.
7. **Stale reference data**: grep prompts and skills for hard-coded tax brackets, expense ratios (QQQ 0.20% should be 0.18%) and similar. Move them to `src/lib/referenceData.ts` with an `asOf` date, correct the values you can verify, and mark the rest `needs-verify` in a PR checklist. Don't guess numbers.

## Acceptance
- All fixture tests pass; the stock page for AAPL, MSFT, COST, JPM and BKNG on port 3014 shows non-blank TTM statements and a sane market cap and P/E (screenshots).
- typecheck, lint and tests are green.
