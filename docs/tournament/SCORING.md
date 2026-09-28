# Prediction tournament preregistration — v1

This file's exact UTF-8 SHA-256 is stored in every daily batch. Changes require
a new strategy version and a new prospective cohort. Never refit and overwrite
prior predictions. Registration date: 2026-09-28. No live cohort has started.

## Population and time

Use a dated, source-attributed S&P 500 membership archive, including every
member, even when inputs are unavailable. The repository's undated constituent
list does not establish historical membership. Financial facts must have an
availability timestamp, not merely a fiscal period date. SEC facts are filtered
by filing date before extraction; same-day filings without intraday timestamps
are excluded conservatively. Future, undated and nonfinite inputs are null.

Alpaca exchange sessions define the cutoff (official session close), next-session
entry open and the 1, 5, 20, 60 and 120-session target closes. A one-session
forecast runs from the next open through that same session's close. Predictions
must be published before entry. No live historical reconstruction or LLM
backfill. A closed date requested explicitly returns `market closed`.

Each batch commits its source snapshot, membership, code SHA, versions, this
registration and prior daily hash. Grades and paper marks are separate immutable
records. Input snapshots and interrupted model attempts are archived in a
create-only checkpoint journal. A failed model attempt is not replayed.

## Arms

Reuse Finava's deterministic 15-factor transformations. Value averages available
relative/absolute valuation factors; quality averages profitability, returns,
financial health and cashflow; growth uses the growth factor; momentum averages
trend and relative strength. Contrarian is 100 minus momentum, eligible only
when quality is at least 50. Composite equally weights value, quality, growth
and momentum and requires all four. Missing price or unverified membership
makes a name unscored. No earnings-revisions arm without dated premium estimates.

Within each arm, descending scores rank eligible names; ticker order breaks
ties. Top 10 are long, bottom 10 avoid, remainder neutral. With fewer than 20
eligible names, each tail is floor(n/2), capped at 10. Decile 10 is highest.
Unscored names have null rank. The cold-start prior is explicitly 0.5 for each
binary event in every decile, **not an estimated historical base rate**. Expected
return stays null until evidence supports one. No invented monotonic probabilities.

The ensemble and Jev compete on the same frozen snapshot for the union of
composite long/avoid tails and the five best eligible contrarian names, at most
25 subjects. Dry runs cap each arm at two subjects. Other members retain
`not_selected_for_model` rows. Budget denials are `skipped_budget`; provider
failures are `unavailable`. Model ranks use their 20-session beat-SPY probability,
with the same tail and tie rules. This is a shortlist contest; its coverage
differs from the full-universe deterministic arms and is reported separately.

Ensemble calls the existing CEO, crew planner, routed specialists and skeptic.
In `full-crew-frozen-evidence-v1`, specialists interpret only the supplied facts
instead of fetching fresh web data; user memory, live facts and followup calls
are disabled. This evaluates controlled-evidence forecasting, not the ordinary
web-research product. Cache scope is unique per attempted subject. Jev asks
separate noul questions for the two binary events. Confidence is never an event
probability. Jev's binary responses cannot identify an expected return: null
with reason. Model probabilities remain `model_unvalidated`.

## Targets and corporate actions

Total return is (split/spin-off-adjusted exit close + entitled cash distributions
− adjusted official entry open) / adjusted entry open. No dividend reinvestment;
gross of transaction costs and taxes. A buyer on an ex-date is not entitled to
that day's dividend. Distributions and prices must use the same share basis.
P(positive) means strictly greater than zero; P(beat SPY) means strictly greater
than SPY's total return over the identical window. Cash/stock acquisitions and
delistings follow the existing outcomes resolver: stop at the event and use
known proceeds, with SPY shortened to the same date. Unknown proceeds, missing
prices, halts and unverified adjustments remain NON_RESOLUTION. Never omit them
from the denominator of the missingness report.

An immutable grade reflects the evidence available at grading. Missing grades
are not silently replaced later. Corrections require an explicit future
versioned correction policy; v1 conservatively keeps the original unresolved
result. Do not grade from unconfirmed corporate-action coverage.

## Reporting and ranking

Calibration is the headline diagnostic: binary Brier scores and reliability
bins for both events, by arm and horizon. Reuse evaluation metrics with at least
30 paired observations and at least 10 observations per reliability bin.
Publish coverage, missingness, dispositions, hit rate, mean excess return,
top-minus-bottom decile spread and overlap/issuer independence diagnostics.
Unresolved outcomes and absent probabilities must not become zeros. Below
display floors, say insufficient data. Do not pool different probability bases.

Pre-registered leaderboard order: highest **20-session mean daily long-cohort
excess return**, gross of costs, shown with calibration alongside. Each date
contributes one equal-weight mean, and only if all selected longs resolve;
publish excluded dates. At least 30 complete daily cohorts are required. Ties
use arm name. Report descriptive Bartlett/Newey-West HAC t-statistic with lag
19 (h−1 for other horizons), covariance denominator n, standard error
sqrt(long-run variance/n). Zero variance has no t-statistic. No p-values,
significance labels, multiple-testing claims or inference of independence.

No automatic calibration fitting or promotion is included in v1. Promotion
must separately pass the existing chronological calibration gate on clean,
prospective arm/horizon/event cohorts. Fixtures and dry runs are never eligible.

## Paper portfolio

Each arm starts with $100,000 cash. Equal-weight up to ten longs at next official
open, fractional shares, no leverage or shorts. Rebalance daily using 0.1% of
absolute traded notional on each buy/sell; unchanged holdings incur no cost.
Solve investable capital after costs rather than borrow to pay costs. SPY buys
once at inception and is held, with the same entry cost. Splits alter shares;
cash distributions accrue without automatic reinvestment. Mark NAV at the close.
Missing held prices or action coverage withholds NAV/trades. An unresolved book
is frozen rather than silently skipping a split, delisting or dividend.

## Spend and operational assumptions

$8 default shared daily upper-bound reservation cap, configurable through
TOURNAMENT_DAILY_USD_CAP; zero disables paid requests. Reserve atomically before
every HTTP attempt, including SDK retries. Retain reservations after failures
and after successful settlement, so admission is conservative. No admin bypass.
Unknown routes/models are refused. Rate-card ceilings are an explicit assumption
and must be checked when provider pricing changes; no software can guarantee an
invoice amount under an unannounced vendor price change. Jev direct-account
pricing must be confirmed separately from the existing gateway price table.
Only provider-reported dollar usage is labelled measured USD. Unknown billed
cost stays null; token estimates and reserved limits are not measured bills.
