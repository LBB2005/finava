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

## Initial live source policy

The default collector selects the latest public Wikipedia constituent revision
published by the official close, retains every constituent and archives the raw
revision. This is a dated public membership proxy, not an official S&P data
license. Initial membership was independently compared with dated SPY holdings.
SEC company-facts are filtered to filings strictly before the session date.
Trailing four-quarter facts may end up to 365 calendar days before cutoff; each
fact records its actual reporting interval and age. Ratios match numerator and
balance-component period ends. Long-term debt alone is never called total debt;
debt/equity remains null when a complete decomposition is unproven. The explicit
utility total concept RegulatedAndUnregulatedOperatingRevenue is eligible;
category revenues are never added to invent a total. When four complete quarters
are unavailable, a directly reported full fiscal year is an eligible trailing
twelve-month period under the same 365-day age limit. Revenue growth compares
matched annual periods. When revenue growth is unavailable, diluted EPS growth
may use directly reported comparative quarters from the same accession/filing,
60–125 days each, with start/end boundaries within seven days of a year apart
and a positive prior denominator. This quarterly basis is explicitly labelled;
no quarter EPS is inferred by subtracting cumulative EPS.

Valuation uses Massive weighted shares dated the previous calendar day (the
issuer expressed in the requested share class's units), adjusted only for validated
splits/stock dividends effective on the scoring date, times the session's Alpaca
SIP close, divided by
filed trailing income/revenue. This is the provider's class-equivalent valuation,
not an exact sum of prices across every class. The one-day reference lag avoids
using same-day updates with unknown intraday availability; same-day issuance or
repurchases can therefore leave the deliberately older share count stale. This
does not eliminate later vendor revisions. Different listed classes remain
separate index members; market caps are never summed. Missing or mismatched
issuer identifiers/currency/reference evidence withholds valuation. Ordinary
SEC cover-page shares are not a substitute for class-equivalent shares.

Momentum uses raw SIP closes and splits/stock dividends effective by cutoff.
Official entry prices require an opening-condition Q trade from the listing
exchange in the first minute, with complete bounded pagination; ambiguous or
missing auctions stay unresolved. Corporate-action queries cover all types,
all data-quality states and process dates from 366 days before to 366 days after
the event interval, then filter by effective/ex-date. This is a bounded provider
coverage assumption, not a guarantee against delayed or corrected records.
Unsupported mergers, spin-offs, rights, currency/entitlement ambiguity and
incomplete actions remain unresolved. Same-ticker, same-CUSIP name-only
changes can be ignored. Price history may additionally use the current ticker
alone after a same-CUSIP incoming rename: `asof=-` prevents automatic old-symbol
stitching. This exception never applies to holding-period returns or paper marks;
changed or missing CUSIPs and undated identity discontinuities stay unresolved. Valid splits, stock dividends and explicitly USD cash
distributions use dated share entitlements. Actual retrieval times and raw
successful responses are retained without credentials. Providers can revise
historical evidence; the frozen prediction snapshot is never replaced.

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
Missing held prices or action coverage withholds NAV/trades. Unknown corporate-action state freezes the book. Known cash termination
consideration (including a zero-value bankruptcy) removes the holding; known
stock consideration converts it into successor shares without a fictitious sale.
The source must explicitly distinguish before-open from after-open settlement.
A missing close with known holdings withholds NAV but can recover on a later
mark; missing action state cannot silently recover.

## Spend and operational assumptions

$8 default shared daily upper-bound reservation cap across production and paid
dry-run namespaces together, configurable through
TOURNAMENT_DAILY_USD_CAP; zero disables paid requests. Reserve atomically before
every HTTP attempt, including SDK retries. Retain reservations after failures
and after successful settlement, so admission is conservative. No admin bypass.
Each admission transaction reads both namespace budgets before writing its own
reservation; either namespace exceeding its measured reservation blocks both.
The daily operator audits combined spend; namespace entries retain attribution.
Unknown routes/models are refused. Rate-card ceilings are an explicit assumption
and must be checked when provider pricing changes; no software can guarantee an
invoice amount under an unannounced vendor price change. Jev direct-account
pricing must be confirmed separately from the existing gateway price table.
Only provider-reported dollar usage is labelled measured USD. Unknown billed
cost stays null; token estimates and reserved limits are not measured bills.
