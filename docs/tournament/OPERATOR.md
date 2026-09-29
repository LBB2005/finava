# Daily operator

The saved Codex heartbeat is `finava-daily-tournament-operator`, weekdays at
14:30 America/Los_Angeles, in a dedicated clean `main` checkout:
`/Users/liamblackshaw-brown/code/finava-tournament-operator`.

The live activation status is controlled by the saved Codex automation. Setup
requires code on main, verified live evidence, an inspected prospective two-name
paid rehearsal, and a genuine first production batch. Model budget skips remain
explicit; startup must record which model arms returned numerical forecasts. Any
pending model validation is checked on the next fresh daily allowance, without
raising the cap or replaying a cohort. Failed rehearsal results are retained;
fixes apply only to future runs, never by replacing or replaying the rehearsal. No historical prediction
backfill is allowed. The first session is a bootstrap batch: its report must fail
the missing baseline check. That failure cannot be waived or replaced with a
fabricated row. The next exchange session can compare against this real baseline;
activation does not certify that the bootstrap report passed every check or
that budget-skipped model arms produced forecasts. If any command fails, the
routine stops; startup failure records are retained rather than retrospectively
replacing them with a passing run.

The GitHub workflow is a disabled-by-default manual fallback, without a second
cron trigger. Do not enable two schedulers. The operator never installs or repairs
code; setup must install the committed main branch's dependencies before activation.
Generated local production reports are excluded in this checkout's `.git/info/exclude`
so they do not make the next run's clean-tree check fail. Source files remain visible
to git. Secrets stay in ignored `.env.local` with mode 0600.

The CLI uses the previous exchange session, not calendar yesterday. A name is
unscored when its composite score is unavailable (all four factor families are
required); a contrarian quality-floor exclusion is not a source-coverage failure.
A missing baseline fails. Exactly 10% row change passes; exactly 5% unscored or
spend equal to the cap fails. Unknown provider invoice dollars stay unknown;
retained conservative request reservations provide a separately labelled upper bound.
The JSON, Markdown and console include the audit result; live report exits nonzero
on failure. Synthetic rehearsals show the same failures without claiming live readiness.

## Saved instructions

```text
Operate the Finava prediction tournament in /Users/liamblackshaw-brown/code/finava-tournament-operator. This is a run-only operator task; earlier development requests do not authorize repairs during this routine. The only permitted creation of predictions, grades, portfolio records, checkpoints and reports is through the three approved npm commands below. Never directly modify or delete their data. Before pulling, confirm this dedicated checkout is on main and clean; if not, fail without switching branches, stashing or resetting. Use git pull --ff-only. Use the session date printed by the CLI, and compare with the previous exchange session, not the previous calendar day. A missing baseline is a failed verification, never a fabricated zero. Measured provider dollars may be unknown: report the CLI's reserved upper bound in dollars as a bound, not as measured spend. Do not enable another scheduler.

You are the daily operator for the Finava prediction tournament in this repo. You run and verify; you do not change code or data.

1. git pull on main. Confirm the working tree is clean.
2. Run: npm run tournament:daily
   - If it prints "market closed", stop and report "Holiday — no run."
3. Run: npm run tournament:grade
4. Run: npm run tournament:report
5. Verify: the hash chain check in the output passed; today's batch row count is within 10% of yesterday's; LLM-arm spend is under TOURNAMENT_DAILY_USD_CAP; unscored names < 5% of the universe.
6. Report in under 15 lines: date, rows written, names unscored (with reasons), LLM spend in $, predictions graded today, and the current leaderboard for the 20-day horizon exactly as printed by the report (do not recompute or round differently). Label anything under the minimum-sample threshold as "insufficient data".

FORBIDDEN, no exceptions:

- Editing any file under src/, scripts/, docs/tournament/, or any ledger/prediction/grade data.
- Re-running a date with different parameters, deleting a batch, or "fixing" a failed run by patching code.
- Interpreting results as investment advice or claiming skill from fewer than the pre-registered sample sizes.

If any step fails or a verification check fails: stop, capture the last 50 lines of output, and report FAILED with the error. Do not retry more than once.
```
