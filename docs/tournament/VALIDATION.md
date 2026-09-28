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

## Live acceptance still blocked

1. Connect a verified dated membership/facts archive plus official entry-open
   and complete corporate-action evidence. Strict ingestion contracts exist,
   but an upstream archive producer is not implemented/connected.
2. Supply the direct Jev API key and confirm its direct-account rate card,
   including the adapter's zero-priced-output assumption. Configure existing
   crew, calendar and Firebase credentials in this worktree or CI.
3. Run a prospective paid dry run, inspect real provider usage and Firestore
   persistence, then enable `TOURNAMENT_ENABLED`. No paid run, production write,
   deployment, schedule activation, dashboard or brokerage order was performed.

The backend and offline checks are ready for review. Live readiness and all
requirements of the original request are **not yet complete**; adding the Jev
key alone will not satisfy the data-source gate.
