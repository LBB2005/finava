# Validation — 2026-09-28

Code tested: `8aea16f58ca6c1b937faeadf15ddf61aeeed25bb` on
`feat/prediction-tournament`. Original checkout changes were preserved in a
separate worktree.

## Automated checks

- `npm run lint`: passed, zero errors; 22 pre-existing warnings.
- `npm run typecheck`: passed.
- `npm run test:cov -- --maxWorkers=2`: 290 files, 3,739 tests passed.
  Coverage: statements 92.97%, branches 84.16%, functions 92.93%, lines 94.31%.
  The existing coverage ratchet was not lowered.
- `npm run eval:smoke -- --maxWorkers=2`: 7 files, 130 tests passed.
- `npm run build`: passed with temporary throwaway Firebase configuration.
  This verifies compilation and prerendering, not a production Firebase connection.
- Independent code review identified three defects: resumed metadata could drift,
  journal chunks could be orphaned, and known terminal corporate actions could
  freeze paper books. All were fixed and the focused reassessment cleared them.

A concurrent full-suite attempt suffered host scheduling/worker timeouts.
The final full suite above ran with two workers and passed without raising test
timeouts or changing the coverage gate.

## Offline integration run

```sh
npm run tournament:daily -- --dry-run --offline --state-dir=.tournament/reviewed-8aea16f
npm run tournament:grade -- --dry-run --offline --state-dir=.tournament/reviewed-8aea16f
npm run tournament:report -- --dry-run --offline --state-dir=.tournament/reviewed-8aea16f
```

The first command created 1,200 rows (30 synthetic names × 8 arms × 5 horizons),
1,200 simulated matured grades, and 1,080 paper marks. Both model arms exercised
their disabled/skipped path; no paid model executed. Repeating daily returned
`duplicate` with chain verification; repeating grading created zero records.
An explicit `--date=2026-07-03` returned `market closed` with exit code zero.

Recorded batch hash:
`88861335b50e8c17de0a93731557182e59eade34cf8216585ee66b60ff466631`.

Reports: [Markdown](../../reports/tournament_dryrun/2026-07-02.md) and
[JSON](../../reports/tournament_dryrun/2026-07-02.json). These contain synthetic
fixture outcomes and are excluded from calibration. Offline measured API spend
was **$0 across zero paid HTTP requests**. This is not a measured live crew or
Jev run; paid-run cost remains unmeasured.

## Jev connection check — 2026-09-28 follow-up

The user supplied a direct TypeSafe key in ignored local configuration. The
existing Finava crew, calendar and Firebase settings were reused locally.
TypeSafe's [model reference](https://docs.typesafe.ai/models) confirms $0.042
per million input tokens and free output; that rate is now configured.

One bounded synthetic connection check succeeded against the direct API through
the existing Jev adapter and tournament request guard. Resolved model:
`jev-1.13.0`; usage: 294 input tokens, 24 output tokens; estimated cost:
`$0.000012348`. The provider did not return dollar usage, so measured invoice
cost remains unknown. The request's conservative reservation was `$0.000355152`.
No personal or market data was submitted, and this check is excluded from
the ledger and calibration. This verifies Jev connectivity, not the full paid
crew/tournament pipeline.

## Live acceptance still blocked

1. Connect a verified dated membership/facts archive plus official entry-open
   and complete corporate-action evidence. Strict ingestion contracts exist,
   but an upstream archive producer is not implemented/connected.
2. Configure CI credentials separately when ready to enable automation. Local
   Jev authentication and public pricing are now verified; other copied
   credentials have not been exercised as a complete live tournament run.
3. Run a prospective paid dry run, inspect real provider usage and Firestore
   persistence, then enable `TOURNAMENT_ENABLED`. No full paid tournament run,
   production ledger write, schedule activation, dashboard or brokerage order
   was performed. Existing GitHub hooks triggered preview deployments.

The backend and offline checks are ready for review. Live readiness and all
requirements of the original request are **not yet complete**; adding the Jev
key alone will not satisfy the data-source gate.

## Operator follow-up — 2026-09-29

Operator implementation commits: `5d5fb89` (audits), `438e9e4` (preparatory
source helpers), `df1090a` (run-only scheduling and documentation).

- Lint passed with zero errors and the same 22 existing warnings; TypeScript passed.
- Final full coverage run: **292 files / 3,756 tests passed** with one worker.
  Statements 93.02%, branches 84.16%, functions 93.12%, lines 94.36%; ratchet unchanged.
- Evaluation smoke: **7 files / 130 tests passed**.
- New coverage checks exercise 10% row-count boundary, strict 5% missingness,
  missing baseline/current batch, tampered chain, unknown invoice cost, strict
  dollar cap, holiday date selection, exact shared leaderboard formatting,
  failed saved artifacts and dated-source derivation.
- Independent final review found no critical issues. Its saved-Markdown audit
  omission was treated as important because the artifact could hide a failed
  check. The regression failed before the shared summary was implemented;
  all 17 focused tests and the final full suite then passed.
- An earlier two-worker suite suffered test/worker timeouts while other local
  work was running. The final one-worker run passed without raised timeouts.

The saved Codex operator is **PAUSED**, weekdays at 14:30 Pacific. Its main
checkout is clean and holds ignored mode-0600 local credentials; generated
production reports are locally excluded from git. Dependencies must be installed
from the final merged main commit before activation. The old GitHub cron was
removed; its workflow remains a disabled-by-default manual fallback.

[Source-readiness probes](./SOURCE-READINESS.md) found usable dated SEC and
public membership evidence and clarified Alpaca's process-date filtering. These
are not an integrated live archive. No prospective full paid rehearsal,
production batch, fabricated prior-day baseline or schedule activation occurred.
The actual recorded Jev connection cost remains the small, separate check above.

The production build also passed for the operator follow-up, using the existing
ignored local project configuration. This verifies compilation/prerendering;
it does not establish a completed live tournament or deploy anything.

The operator offline sequence was rerun from isolated state
`.tournament/operator-df1090a` against committed code. It created 1,200 synthetic
predictions, 1,200 matured grades and 1,080 marks with zero HTTP model attempts.
A repeated daily wrote zero rows; repeated grading wrote zero records; the holiday
printed `market closed`. Chain hash:
`a5c3ce09e26ca916d3f6a9ba71cd7503a9f15c4126a8a142f868eede3561a723`.
The regenerated sample report deliberately shows
`FAILED (previous_session_batch_missing)` for this single-batch fixture; that is
expected audit behavior, not a passing live operator verification.

The live readiness command `npm run tournament:daily -- --dry-run` exited 1
before model execution with the following captured error (no retry):

```text
Verified dated data source is not configured. Set TOURNAMENT_DATA_DIR or TOURNAMENT_DATA_URL; current UI facts are not a point-in-time archive.
```

## Live collector implementation — 2026-09-29

This supersedes the earlier "archive producer not connected" blocker. The CLI
now collects dated membership, filed SEC financials, Massive issuer-equivalent
shares and Alpaca SIP/action evidence through existing credentials. Historical
source inspection below is research-only: no prediction, grade or model backfill.

- Read-only 2026-09-28 coverage: **503 retained members, 486 composite scored,
  17 unscored (3.3797216699801194%)**, satisfying the strict below-5% source gate.
  Value/quality each 487; growth/momentum each 489; contrarian 442 (its quality
  floor intentionally excludes additional names). Unscored: APTV, BDX, BNY,
  CCL, CMCSA, DD, DOC, FDX, FERG, HON, HONA, OKE, PSKY, SPGI, TEL, VMRK, XOM.
  Reasons retain incomplete financial history, identity discontinuity and
  unsupported corporate actions; none were removed from the universe.
- Full suite: **298 files / 3,822 tests passed** with two workers. Coverage:
  statements 93.21%, branches 84.43%, functions 93.48%, lines 94.62%. Three additional
  final SEC edge-case tests passed in the subsequent **56-test focused check**.
  Coverage thresholds and test timeouts are unchanged.
- Full-universe storage regression publishes 20,120 SHA prediction IDs using
  an immutable chunked ID manifest within Firestore document/request limits;
  exact canonical batch/hash semantics are preserved. Atomic failure, identical
  recovery, legacy batches and chunk corruption are covered. Only the real
  boundary case uses 20,120 rows; smaller chunked cases test recovery/corruption.
- Source regressions cover filing cutoffs, matched balance periods, complete
  debt withholding, actual TTM/annual periods and age, direct same-filing EPS,
  class-equivalent valuation, provider credential isolation, all-page checks,
  official primary auction prices, split/cash entitlements and unknown actions.
- Independent source/storage review completed. Mixed-period returns, partial
  debt labelled as total debt and ambiguous multi-class valuation were fixed.
  Final review found no additional important issues.
- Read-only authentication checks: Anthropic and OpenRouter returned HTTP 200;
  Massive dated reference requests succeeded for multi-class issuers. These
  checks made zero paid model requests and do not establish forecast quality.

Live prospective rehearsal waits for the 2026-09-29 official close plus the
account's SIP delay. It must use the committed source policy and actual current
session evidence. The first production report will still fail the missing
prior-session baseline check; no historical batch will be fabricated.

After those final source changes: lint passed with zero errors and the same 22
pre-existing warnings, TypeScript passed, smoke evaluation passed all 130 tests,
and the production build passed with the existing ignored local configuration.
The latest focused SEC/market/valuation run passed 56 tests, including the three
additional edge cases noted above.

CI exposed a timeout in the combined full-size publication/retry regression.
The size-boundary assertion still publishes and rehydrates all 20,120 IDs; retry
immutability now has a separate 2,001-row chunked case. No timeout or coverage
requirement changed. Final local full suite: **298 files / 3,826 tests passed**;
coverage 93.21% statements, 84.44% branches, 93.48% functions, 94.62% lines.

Before any paid rehearsal, review caught and fixed a cross-namespace budget
loophole: rehearsal and production now read both reservation documents in each
admission transaction and share the same daily cap. Namespace-specific settlement
and attribution are preserved; operator audit/report totals combine the day.
Either namespace's measured overrun blocks further admission in both. Regressions
cover both admission orders, competing requests, overrun blocking, malformed
stored totals, retained attribution and strict combined-cap auditing.

Final checks for that fix: **299 files / 3,837 tests passed**; statements 93.35%,
branches 84.59%, functions 93.69%, lines 94.78%. Lint: zero errors, 22 existing
warnings. TypeScript and all 130 smoke tests passed. Independent review found no
important remaining budget issues. No paid tournament run had started at this
point, so no published cohort or reservation was rewritten.

Before the first paid run, the dated Massive reference policy was tightened to
the previous calendar date, with only validated scoring-day splits and stock
dividends applied to the share basis. This prevents same-day references with
unknown intraday availability from entering the close snapshot. Same-day issuance
and repurchases remain deliberately lagged; vendor retrospective revisions are
not eliminated by this policy. Tests cover forward/reverse splits, stock
dividends, exclusion of prior/future events, unknown/invalid adjustments and
Sunday reference dates for Monday cutoffs. Six regressions failed before the fix.

Final local checks: **299 files / 3,842 tests passed**; coverage 93.35% statements,
84.61% branches, 93.70% functions, 94.78% lines. Lint passed (zero errors and 22
existing warnings), TypeScript passed, all 130 smoke tests passed, and the
production build passed. No paid run or published cohort had started.

## Prospective rehearsal, 2026-09-29

The actual Sep29 snapshot retained 503 names with 486 composite scores and 17
unscored names (3.38%). Rehearsal at commit 47069ef called both model arms on APA
and DELL. Jev 1.13.0 returned numerical event forecasts for all five horizons on
both names. Both crew syntheses stalled and extraction correctly retained null
forecasts. A parsed schema status of ok is not a usable-forecast success.
Fourteen HTTP model attempts reserved $4.25143714 under the combined $8 cap;
measured invoice dollars remain unknown.

The process then exited with `3 INVALID_ARGUMENT: Invalid transaction.` Read-only
inspection found all 20,120 prediction records and a sealed batch. The original
failed run and null crew forecasts are preserved, with no paid replay.

Review reproduced a streaming transport defect: the cost wrapper waited for
response.clone().json() to consume the whole SSE body before returning it to the
SDK, starving the synthesis idle guard. The future-version fix returns streaming
responses unread and retains unknown measured dollars plus the reservation. Two
open-stream regressions failed before the fix and passed after; they verify the
first chunk is available before stream closure. No scoring policy was changed.

Validation of the future-version fix: 299 files / 3,844 tests passed; coverage
93.36% statements, 84.61% branches, 93.70% functions and 94.78% lines. Lint passed
with zero errors and 22 existing warnings, TypeScript passed, 130 smoke tests
passed, and production build passed. Independent review found no important
remaining issues in this fix. The first production run remains separately
identified by its own code SHA and must verify usable numerical forecasts.

## First production batch and startup grading failure

Main commit e886175d9b0538b0040d0a5cbc77cb578e12fd0c sealed 20,120 Sep29
production rows with hash 8a22fff114f4ea7226ac004d0a960c7e18ffa5c872efb5a833cf76162a9f239e.
The daily command exited successfully and its chain check passed; independent
read-only verification confirmed the stored batch. All 25 selected Jev subjects
returned numerical probabilities at all five horizons. All 25 crew entries were
budget-skipped: the rehearsal had already reserved part of the shared allowance.
Production reserved $3.54260406; combined with rehearsal the upper bound was
$7.79404120, below $8. Measured dollars remain unknown. Crew numerical-forecast
validation remains pending a fresh daily allowance; do not call it verified.

The next approved command, tournament:grade, failed with `Invalid calendar range`.
Its first entry date was Sep30 while the as-of date was Sep29. The workflow
stopped: no report command was run, no current-date retry was made, and no
predictions or grades were manually modified. No outcome had matured.

The future-run fix avoids requesting calendar sessions when the earliest entry
is after the as-of date. It keeps normal entry-day and later marking behavior.
A regression reproduced the exact invalid-range error before the guard and
passed afterwards. Today's failure and immutable cohort are retained. The next
regular session has a genuine preceding-session batch for comparison.
