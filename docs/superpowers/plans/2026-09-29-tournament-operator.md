# Tournament operator readiness

Goal: implement the user's daily run-only operator protocol and prepare its
schedule without enabling a routine that cannot pass its required checks.
Spec: docs/tournament/REQUEST.md and the user's 2026-09-29 operator prompt.

Global constraints: existing feature worktree, preserve original dirty checkout,
no fabricated data or backfill, no ledger edits, no secrets in output. Operator
restrictions apply to scheduled operation; the user separately authorized setup.

### Task 1: Verifiable operator outputs
Produces: read-only audit of sealed rows, previous exchange-session batch,
strict 5% composite data-coverage threshold, conservative dollar spend bound,
same formatter for printed/file leaderboard, named holiday outcome.
Consumes: existing ledger, calendar and reservation interfaces.
Tests: threshold boundaries, missing baseline, missing batch, tampering, real
universe denominator, unknown billed dollars, report formatting, holiday dates.
Expected: failing tests before implementation; focused tests then full suite pass.

### Task 2: Source readiness and operator checkout
Verify the candidate membership and dated-facts providers. Never label an
undated source as verified. Prepare a separate clean main checkout for the
operator, without switching or cleaning the user's checkout. Preserve prompt.
Expected: explicit source blockers or evidence of usable dated sources.

### Task 3: Scheduled operator and review
Save the user's run-only instructions as a weekday after-close heartbeat.
Leave it paused until the code is on main, verified data collection is connected,
a live two-name dry run passes, and genuine previous-session baseline exists.
Avoid two competing schedulers. Review changes and publish to existing draft PR.
Expected: tool-confirmed saved schedule, honest activation status, checks passed.

## Review focus
- The operator must fail rather than hide a missing previous-session batch.
- An unknown invoice is not zero; only a bounded request reservation may prove
  the cap without inventing measured cost.
- Report formatting must be shared, not recomputed by the routine.
- No operator may repair code, stash user work or mutate published observations.
