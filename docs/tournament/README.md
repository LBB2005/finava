# Daily prediction tournament

Finava records eight competing strategy arms, grades five session horizons
against SPY, and keeps an immutable paper record. Backend only; no dashboard
and no brokerage orders.

## Run

Node 22+, `npm ci`, then:

```sh
npm run tournament:daily -- --dry-run --offline
npm run tournament:grade -- --dry-run --offline
npm run tournament:report -- --dry-run --offline
```

The offline run exercises ranking, predictions, chain, simulated model skips,
all five matured horizons, paper portfolios and reporting, using explicitly
synthetic prices and a recorded Alpaca calendar. No keys, paid requests or
calibration evidence. Its $0 cost is **not a measured live crew run**. Repeating
the date checks the existing chain without spending again. Local state lives
in ignored `.tournament/offline`; use `--state-dir=/absolute/new/path` for an
independent fixture run. Do not delete published live data to rerun experiments.

With credentials and verified dated evidence configured:

```sh
npm run tournament:daily -- --dry-run
npm run tournament:daily
npm run tournament:grade
npm run tournament:report
```

`--dry-run` writes only to `tournament_dryrun`, permits at most two subjects per
model arm, and also invokes grading and reporting. Genuine forecasts do not
magically mature in a dry run: future horizons remain ungraded. Live production
uses `tournament`; code must be committed. Default daily date is the most recent
completed Alpaca session. It refuses a new prediction after the next entry open.
On a current exchange holiday, the default commands exit successfully with
`market closed`; they do not silently fall back to a previous trading day.

## Configuration

Put secrets in ignored `.env.local` or GitHub Actions secrets; never in reports.
The script loads `.env.local` then `.env`, preserving values already in the
environment. The local rehearsal reuses the existing project credentials; credentials are
not committed or copied into reports.

- `TYPESAFE_API_KEY`: your new Jev direct key. The tournament intentionally does
  not fall back to a different billed gateway account.
- `TOURNAMENT_JEV_INPUT_USD_PER_MILLION`: `0.042`, the direct API's published
  input-token rate per million; output is free. Verified against
  [TypeSafe's model reference](https://docs.typesafe.ai/models) on 2026-09-28.
  Use your contract rate instead if it differs from public pricing.
- `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`: existing full crew credentials.
- `ALPACA_API_KEY`, `ALPACA_API_SECRET`: calendar, SIP prices, official auction trades and corporate actions.
- `POLYGON_API_KEY`: existing Massive account, dated issuer reference/weighted shares.
- Existing Firebase Admin/public configuration required by `src/lib/env.ts`.
- `TOURNAMENT_DAILY_USD_CAP`: default 8; zero disables paid HTTP requests.
- Optional `TOURNAMENT_DATA_DIR` or `TOURNAMENT_DATA_URL`: explicit dated data archive
  using the schemas below. A local directory takes precedence. Remote artifacts
  are HTTPS JSON, without credentials in URLs, no automatic retries on 429.

With no explicit archive configured, the CLI collects dated membership, SEC
filings, Massive issuer reference and Alpaca market evidence directly. Successful
raw responses are captured under ignored `.tournament/provider-cache/SESSION/`
(or `TOURNAMENT_RAW_DIR`). Authentication stays in request headers. Missing data
retains the constituent and its reason; it never shrinks the population.
Run after the official close plus the account's SIP delay (at least 15 minutes).
The scheduled 14:30 Pacific run leaves additional time for provider processing.

Source assumptions and conservative unresolved cases are preregistered in
[SCORING.md](./SCORING.md). The collector does not claim exhaustive instantaneous
corporate-action coverage. A real two-name rehearsal and production baseline
must be verified before unattended operation; a first baseline report fails
comparison with its absent predecessor by design.

## Evidence archive contract

Artifact filenames are dated; payloads must match the date. JSON is strictly
validated by `src/lib/tournament/sources.ts`. Never include credentials.

`snapshots/YYYY-MM-DD.json`: `TournamentSnapshot` from `types.ts` with:
`evidenceClass: "prospective"`, `asOf` equal to official close, `observedAt` actual retrieval time,
`membership: {date, source, verified, members:[{ticker,name,sector}]}`, and
`names:[{ticker,sector,inputs,reasons}]`. Every field in `ScoreInputs` must be a
`Fact<number>` with a publication/availability timestamp; missing = null plus
reason. Do not stamp a fiscal-period value with the current time to simulate
provenance. `filterCompanyFacts()` is provided for SEC filing-date filtering.
Missing members get unscored rows automatically; unexpected/duplicate members
are rejected. Raw future facts are stripped before either model sees evidence.

`returns/TARGET-DATE.json`: `{source, coverageConfirmed:true, records:{KEY:DATA}}`.
KEY is `TICKER_ENTRY-DATE_TARGET-DATE`. DATA follows existing
`TotalReturnDataSchema` in `investment/evaluation/outcomes.ts`: subject and SPY
matched windows, split/spin-off-adjusted official entry opens and exit closes,
explicit cash distributions, adjustment source, corporate action/proceeds and
invalidation observations. An early terminating action shortens both windows.
The archive must include delisted issuers. A halt/missing price remains null;
the resolver produces a named non-resolution. Grades never overwrite each other.

`marks/SESSION-DATE.json`: `{source, records:{TICKER:{open,close,splitFactor,
cashPerPreviousShare,actionsComplete,reason}}}`. Opens and closes are raw
per-current-share prices; `splitFactor` converts yesterday's held shares;
cash entitlements are per yesterday's share, credited before trades. A verified
no-action day uses factor 1 and cash 0; unverified actions use null/false.
Optional `termination: {at: "before_open"|"after_open",
cashPerPreviousShare: number|null, successor: {ticker,sharesPerPreviousShare}|null}`
settles known terminal cash and stock consideration. A known zero is a real
writeoff; null is unknown. Successor ratios are current shares per original
predecessor share. Unknown action state freezes holdings; a missing close alone
withholds NAV while preserving known positions for the next mark.

## Storage and recovery

Only `live/ledgerTournament.ts` writes immutable tournament data: per-row
predictions, daily seals, grades, portfolio snapshots and checkpoint chunks.
Predictions are content-verified on retry, never set/updated/deleted. A chain
check runs before every operation. Incomplete daily publications resume from
identical checkpoints; code/registration changes require completing or
explicitly abandoning the unpublished run, not altering a sealed cohort.
The writer lock expires after four hours (workflow timeout is three hours).
An interrupted paid step becomes unavailable rather than being spent again.

Budget working state is separate in `tournamentBudget`, extending `live/budget.ts`.
Reservations count every outbound attempt and stay reserved even on success.
This deliberately underspends the cap. Unknown provider dollar usage stays null.
Check current rate cards before changing model routes.

## Automation

`.github/workflows/tournament.yml` is a manual fallback gated by the repository
variable `TOURNAMENT_ENABLED=true`; its cron was removed to avoid a competing
scheduler. The user-selected [Codex operator](./OPERATOR.md) is saved for weekdays
at 14:30 Pacific and remains **paused** until its activation gates are met. Its
exact run-only prompt, bootstrap behavior and checkout setup are recorded there.
The manual GitHub fallback needs the above secrets (including `POLYGON_API_KEY`),
or an explicitly configured evidence archive;
it serializes daily → grade → report and commits only `reports/tournament/`.
Neither path deploys a site or places orders.

Registration and statistical conventions are in [SCORING.md](./SCORING.md).
Do not interpret fixture reports as a track record or promote raw model output
to calibrated probability without the existing chronological validation gate.

## Primary references checked

- [TypeSafe API contract](https://docs.typesafe.ai/api) — event questions and response usage.
- [Alpaca calendar](https://docs.alpaca.markets/reference/getcalendar-1) — exchange sessions.
- [Alpaca market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) — ordinary bar opens are not a substitute for an identified official opening trade.
- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [OpenRouter model registry](https://openrouter.ai/api/v1/models) — admission-rate checks on 2026-09-28. Provider-dollar usage, reservation ceilings and usage-based estimates are distinct.

Provider probes and live validation status are documented
in [SOURCE-READINESS.md](./SOURCE-READINESS.md). Existing credentials suffice for
the collector; no additional Jev key is required.
