# Prediction Tournament Implementation Plan

**Goal:** Forward-only, immutable daily predictions with deterministic, crew and Jev arms; reproducible grading, calibration diagnostics and paper portfolios.
**Spec:** `docs/tournament/REQUEST.md`, plus the user's approved separate Jev competitor using identical evidence and horizons. The user authorized autonomous implementation and will provide the direct Jev key afterward.
**Architecture:** Extend evaluation records/resolution, live ledger hashing and persisted budget. Add an exchange calendar, strict dated facts adapter, orchestration, reports and CI. No broker orders. No dashboard until backend gates are green.
**Tech stack:** Existing TypeScript, Vitest, Firebase Admin, Next.js; CLI with tsx.

## Global constraints
- Append-only predictions and grades; hash-chain each daily batch; resumable creates may verify identical bytes but never replace them.
- As-of is exchange close. Entry is the next session's official open. Trading sessions come only from Alpaca calendar.
- Separate 1/5/20/60/120 session forecasts, rejects and neutral/unscored/skipped rows included.
- No unknown source dates, post-cutoff evidence, undated membership, synthetic history or model confidence masquerading as outcome probabilities.
- $8 shared daily model cap by default, including admins, enforced before paid requests. Unknown usage retains reservations.
- Dry run uses tournament_dryrun and at most two subjects per model arm. Fixtures are explicitly non-live and never calibrate.

## Tasks
- [x] Calendar and evaluation contracts: red tests for holiday/DST/early close and next-open maturation, then implement optional exchange-calendar resolution without changing calendar-month behavior.
- [x] Strict evidence and strategies: red tests for future/restated/undated inputs, null scores, ties, shortlists and withheld forecasts; reuse scoreFactors, facts and calibration promotion.
- [x] Ledger: red tests for mutation, delete/update, incomplete publication recovery, concurrent date ordering and verified reruns; reuse canonical hashes and create-only Firestore boundaries.
- [x] Model adapters: red tests for missing keys, Jev question/answer mapping and cap; use the existing Jev client and full crew with frozen evidence.
- [x] Grading and portfolios: red tests for entry opens, distributions, splits, delistings, missing prices, turnover costs and cash; reuse resolvePrediction and metrics.
- [x] CLI/report/workflow: test orchestration, idempotence and offline dry run; preflight live providers, write registration and setup guide; lint/typecheck/full suite/coverage.

## Review focus
- Crash after a paid call must not cause unlimited repeat spend or rewrite forecasts.
- A future or missing source timestamp never reaches the deterministic score or either model.
- A 1-day target ends at next session close, never that date's midnight.
- An absent price/action feed must not create a cash loss, zero return or omitted issuer.
- A dry-run report and fixtures must be visibly separated from prospective evidence.

## Remaining live acceptance gates
- [ ] Connect a verified dated membership/facts archive and complete official-open/corporate-action evidence. Current cached UI facts do not certify these properties; the strict archive ingestion contract is ready.
- [ ] Add the user's direct Jev key and confirm its rate card, then run a prospective paid dry run. Offline integration cost is $0 with no paid models; this is not a measured live crew run.
- [ ] Enable the scheduled workflow only after those gates pass. Dashboard remains a later task.

These are explicit blocked live integrations, not completed deliverables. No fabricated fallback was substituted.
