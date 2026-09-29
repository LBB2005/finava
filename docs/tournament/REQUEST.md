You are working in the Finava repo (Next.js + TypeScript + Firebase, deployed on Vercel). Read AGENTS.md first — this Next.js version has breaking changes; consult node_modules/next/dist/docs/ before writing route code.

GOAL
Build the "Daily Prediction Ledger + Strategy Tournament": every US trading day after the close, score the S&P 500, record timestamped append-only predictions for several competing strategies, and grade matured predictions against SPY. The headline metric is CALIBRATION, not returns.

DO NOT BUILD A PARALLEL SYSTEM. Extend what exists. Read these in full before writing code and reuse them:
- src/lib/investment/evaluation/{predictions,outcomes,metrics,calibration}.ts — prediction records, resolution, Brier/reliability bins, chronological calibration gate. Obey every rule in their header comments.
- src/lib/live/{asOf,budget,ledger*,version}.ts and src/app/api/live/* — point-in-time standing vocabulary, persisted spend caps, the ledger write discipline. ledgerDiscipline.test.ts must keep passing; only ledger modules may write ledger collections.
- src/lib/factors.ts, src/lib/factorUniverse.ts, src/lib/sp500.ts, src/lib/finavaScore.ts, src/lib/facts/* — the deterministic 15-factor score and universe.
- src/lib/investment/horizon.ts — currently rejects trading_days on purpose.
- src/lib/investment/runBudget.ts — admin UIDs are NOT exempt from this cap; keep it that way.
- docs/pricing/run-cost-2026-09.md — measured LLM costs.

HARD RULES (non-negotiable)
1. Append-only. A prediction row is never updated or deleted. Grades go in a separate collection keyed by predictionId+horizon. Add a per-day hash chain: each day's batch stores sha256(canonical JSON of its rows + previous day's hash).
2. Point-in-time. Each prediction stores asOf (market close timestamp), the input snapshot hash, code commit SHA, strategy version, and the universe membership as of that date. No data dated after asOf may enter a score.
3. Entry price = NEXT session's official open, not the close used to score. Record that explicitly; grade from it.
4. Trading-day horizons need a real exchange calendar. Add src/lib/marketCalendar.ts wrapping Alpaca GET /v2/calendar (cached in Firestore), then extend horizon.ts to resolve trading_days via it. Never count weekdays.
5. Horizons: 1, 5, 20, 60, 120 trading days. Each prediction states precise events with probabilities: P(beats SPY total return over horizon), P(return > 0), and an expected return. Store target definitions on the record (predictions.ts already does this — follow it).
6. Store rejected/neutral names too (disposition field), not only picks.
7. Delistings, mergers, halts resolve through outcomes.ts NON_RESOLUTION codes — never drop the row.
8. No fabricated numbers anywhere (see DATA_ACCURACY_RULE / no-fabrication conventions). Missing data → null + reason, never a plausible stand-in.
9. No LLM backfill of history. Any backtest you add for pipeline debugging is labelled hindsight-contaminated and can never feed calibration.

STRATEGIES (arms)
Deterministic, $0 LLM, computed from the same factor snapshot:
- value, quality, growth, momentum, contrarian (e.g. oversold + quality floor), composite (equal-weight blend).
- Each arm outputs a full cross-sectional rank; top 10 = "long", bottom 10 = "avoid". Probabilities come from rank-decile base rates; until the calibration gate passes, mark basis "fixed_prior" (see ScenarioWeightsSchema / promoteProbabilityBasis).
- Do NOT create an earnings-revisions arm: estimates are premium-gated on our Finnhub plan. Leave a TODO stub that returns "unavailable".
LLM arm ("ensemble"):
- Run the existing full-analysis crew only on the union of the composite top 10 long, bottom 10 avoid, and 5 contrarian picks (≤25 names). Use withCacheScope so reruns don't replay cached agent output. Hard daily cap via live/budget.ts: default $8/day, configurable by env TOURNAMENT_DAILY_USD_CAP; on cap, stop and record the unrun names as "skipped_budget", don't fail silently.

PAPER PORTFOLIOS
Per arm: $100,000 fake, equal-weight top 10, rebalanced daily at next open, no leverage, 10 bps cost per side. Record positions and daily NAV append-only. SPY buy-and-hold is a benchmark arm.

GRADER
Daily: for every prediction whose horizon matured, compute return from entry open, SPY return over the same window, excess return, hit (beat SPY), and write the grade. Then produce metrics per arm and horizon: count, hit rate, mean excess return, top-decile vs bottom-decile spread, Brier score, reliability bins (use metrics.ts; respect MIN_SAMPLES_TO_REPORT and MIN_BIN_COUNT — show "insufficient data" below them), and independenceDiagnostics so readers see effective sample size.

PRE-REGISTRATION
Before the first live run, write docs/tournament/SCORING.md defining arms, horizons, metrics, the leaderboard ranking rule (primary: 20-day excess return with a Newey-West t-stat; calibration shown alongside), and commit its sha256 into every day's batch.

RUNTIME
- Entry point: `npm run tournament:daily -- --date=YYYY-MM-DD` (script in scripts/, runnable locally and in CI; defaults to the most recent completed session per marketCalendar; exits 0 with "market closed" on holidays; idempotent — rerunning a date that already has a batch is a no-op that re-verifies the hash chain).
- Also `npm run tournament:grade` and `npm run tournament:report` (writes a markdown + JSON summary to reports/tournament/YYYY-MM-DD.*).
- Respect vendor rate limits (Finnhub, Polygon, SEC 429s — facts layer already refuses to score on failing feeds; count those as "unscored", don't retry-storm).
- Add .github/workflows/tournament.yml: weekdays 21:30 UTC cron, runs daily→grade→report, commits reports/ to the repo. Secrets via GitHub Actions secrets; never print them.

DASHBOARD (later task, only if the above is green)
An admin-only page /tournament reading the ledger: leaderboard, reliability diagram, NAV curves. Use existing ui/EmptyState/Skeleton/ErrorState and design tokens.

TESTS
TDD with vitest. Required tests: append-only enforcement (update/delete throws), hash-chain verification detects a mutated row, next-open entry pricing, holiday handling via a mocked calendar, horizon maturation over a holiday, delisting → NON_RESOLUTION, budget cap stops the LLM arm, no data after asOf reaches a score, idempotent rerun. `npm run lint`, `npx tsc --noEmit`, `npx vitest run` must all pass. Don't lower the coverage ratchet.

DELIVERABLE
A branch `feat/prediction-tournament` with small commits, a PR description listing what was reused vs added, the measured cost of one dry run (`--dry-run` flag: full pipeline, LLM arm limited to 2 names, writes to a `tournament_dryrun` namespace), and any assumption you had to make. Stop and ask rather than guess if a data source needed for a rule above is unavailable.