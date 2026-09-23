# Investment Research

Sourced Buy / Watch / Avoid reports with an explicit horizon, scenario
valuations, and expected returns whose probability basis is always stated.

Behind `INVESTMENT_RESEARCH_ENABLED`, off by default.

---

## 1. Setup

```bash
# Off unless EXACTLY "true" — a typo disables the feature rather than enabling it.
INVESTMENT_RESEARCH_ENABLED=true

# Scenario probabilities (OPTIONAL — see §4). Either credential works:
AI_GATEWAY_API_KEY=...     # Vercel AI Gateway → ai-gateway.vercel.sh/typesafe
TYPESAFE_API_KEY=...       # TypeSafe direct → api.typesafe.ai (console is waitlisted)

TYPESAFE_MODEL=jev-latest  # optional; the RESOLVED version is recorded per run
TYPESAFE_BASE_URL=         # optional host override (proxy)
```

Both go in `.env.local` (gitignored). A direct TypeSafe key wins if both are set,
as the more specific configuration. **Without either, the feature still works** —
see §4.

Adding any new variable means editing **two** places in `src/lib/env.ts`: the Zod
schema and the explicit `process.env` mapping. Editing one fails silently.

### Jev routing

Vercel AI Gateway exposes Jev two ways, and they are **not** equivalent:

| path | dialect |
|---|---|
| `/typesafe/v1/systemone` | TypeSafe native — `noul`, `choice`, `score`, **includes `confidence`** |
| `/v1/evaluate` | Gateway's own — `boolean`, camelCase usage, **omits `confidence`** |

We use the TypeSafe-compatible endpoint. `POLICY_V1.minScenarioConfidence` gates
on `confidence`, so routing through `/v1/evaluate` would silently disable a
quality gate while everything still appeared to work.

Cost via the Gateway: **$0.042 per million input tokens, output free**, with
zero-data-retention and no-training both `all`. A scenario assessment costs a
small fraction of a cent.

---

## 2. What a report means

| Field | Meaning — and what it is NOT |
|---|---|
| As-of price | What it trades at now. Not a target. |
| Expected return | Probability-weighted, over the **whole horizon**. Not annual. |
| Annualized | Annualized equivalent of expected **terminal wealth**. **Not expected CAGR.** Hidden below one year. |
| Bear-case loss | The bear **scenario's** loss. Not the maximum possible loss, not a drawdown. |
| Return hurdle | The annual hurdle **compounded over this horizon**. 10%/yr is ~21% over two years. |
| Finava Score | A sector-relative factor ranking. **Not a probability**, and not an input to the rating. |
| Confidence | How concentrated a model's answer distribution was. **Not** how often it has been right. |
| Coverage | Fraction of the **enumerated required** inputs present for the chosen method. Not accuracy. |

### Ratings

- **Buy** — passed every quality gate and the expected return clears the
  horizon-compounded hurdle with acceptable downside.
- **Watch** — either below the hurdle, or a quality gate blocked the judgment.
- **Avoid** — negative expected return, a bear loss above the limit, or a
  declared exclusion the company demonstrably violates.

**A lack of evidence is never an Avoid.** Thin coverage, a stale price, an
uncomputable estimate and missing probabilities all yield Watch with a reason
code. Inverting this would turn a provider outage into investment advice, and the
more broken the pipeline got, the more confident the sell signals would look. A
test asserts no combination of missing inputs can produce an Avoid.

### Statuses

`complete` · `partial` · `insufficient_data`. The last is a statement about **our
data**, not about the company, and the UI says so in those words.

---

## 3. Horizons

Supported: **calendar months, 1–60.** Presets Short 3 / Medium 12 / Long 36. With
no horizon specified, 12 months is assumed and **labelled `assumed`** so the user
can see and change it.

**Trading-day horizons return `unsupported_calendar`.** Resolving one to a real
exchange session needs a holiday calendar this repo does not have —
`marketHours.ts` and `marketSession.ts` both say they ignore holidays. Counting 63
weekdays forward would call Thanksgiving a session and leave the prediction
unresolvable, because the date promised was never a trading day. An injectable
calendar adapter can be added later without touching callers.

Month arithmetic clips to month-end: 31 Jan + 1mo = 28 Feb; 31 Jan 2028 + 1mo =
29 Feb. A target date landing on a weekend gets a `note`, not a silent shift.

---

## 4. Scenario probabilities and the fixed prior

`ProbabilityBasis` records where the weights came from, and the four cases are
**not** interchangeable:

- `fixed_prior` — the configured 25/50/25 default. **An assumption, not a
  forecast.** Labelled as such everywhere it appears.
- `user_assigned` — the user set them.
- `model_unvalidated` — a model produced them and nothing has tested them.
- `empirically_calibrated` — measured against resolved predictions. The schema
  **refuses** this label without a calibration artifact reference.

Jev is an enhancement, not a dependency. With no credential the engine runs on
`fixed_prior` and every number is still computed and displayed — the report just
says the probabilities are a fixed assumption. This is why the deterministic
engine could be built and tested before any vendor integration existed, and it
gives a **baseline to measure Jev against**: same stock, same evidence, fixed
prior versus model weights, and an eventual answer to whether the model's
distribution actually resolves better.

A failed, timed-out, cancelled or malformed Jev call yields **null weights**, and
the report goes partial. It is never replaced with an equal-probability triple —
an invented distribution presented as a forecast is worse than an absent one,
because the reader cannot tell it was invented.

---

## 5. Version invalidation

A stored report is reusable only when **every** field of `DecisionCacheKey`
matches: ticker, horizon count and unit, snapshot hash, mandate hash, policy
version, valuation version, question-set version, agent version, and owner uid.

- Changing a **threshold** → bump `POLICY_VERSION` in `policyConfig.ts`.
- Changing **valuation semantics** → bump `VALUATION_VERSION`.
- Changing a **question** → bump `QUESTION_SET_VERSION`.

Bump in the same commit as the change, never retroactively. Owner uid is in the
key so private context can never leak through a shared cache entry.

Reports and snapshots are **immutable once complete**. A refresh creates a new run
linked via `supersedes`; nothing is mutated in place.

---

## 6. Rollback

Set `INVESTMENT_RESEARCH_ENABLED` to anything other than `true` (or remove it).
The routes go inert and existing surfaces render exactly as before. No migration
and no data deletion are required — stored runs and reports are inert once the
flag is off.

---

## 7. Known limitations

**No calibration.** Nothing here establishes forecast accuracy or investment
profitability. Scenario probabilities are an assumption or an untested model
output. Calibration requires ~200 matured predictions per horizon cohort, which
takes as long as the horizons take.

**No exchange calendar.** See §3.

**No earnings-call transcripts.** No licensed provider is verified. The adapter
interface and fixtures exist; the default implementation reports transcripts
`not_covered`. Missing transcripts stay missing rather than being fabricated.

**Filing retrieval is partial.** The existing EDGAR 10-K helper truncates text; it
is not full filing retrieval.

**A paused run is paused.** Nothing advances a run in the background. Close the
tab and it stops at its last persisted stage, resumable on return. The UI says
paused rather than implying background work, because there is none.

**Historical backtests are hindsight-contaminated.** A current LLM may simply
remember what happened. Date-filtering retrieved evidence does not remove
model-memory leakage, and any backtest is labelled accordingly.

**Unsupported business types.** Banks, insurers, REITs and loss-making companies
do not get forced through an unsuitable DCF — they receive a partial report until
an appropriate model exists.

**Thresholds are product decisions.** The 10% hurdle, 35% max bear loss, 80%
coverage floor and 0.60 confidence floor are configurable choices, not validated
optima. Nothing in this repository establishes they maximise anything.

---

## 8. Layout

```
src/lib/investment/
  horizon.ts            month arithmetic, unsupported_calendar for trading days
  schemas.ts            scalar contracts; standing imported from live/asOf
  contracts.ts          snapshot / report / run / cache-key shapes
  policyConfig.ts       thresholds + POLICY_VERSION + compounded hurdle
  returns.ts            deterministic scenario arithmetic
  decision.ts           the rating policy; a gap is never an Avoid
  scenarioBuckets.ts    resolvable outcome partition
  presentation.ts       null renders as "Unavailable", never a number
  valuation*.ts         forward multiple, historical range, DCF bridge
  snapshot/evidence/claims.ts   frozen information set + structured findings
  callTranscripts.ts    call-transcript adapter (named apart from live/transcripts)
  discovery*.ts         funnel planning and ranking
  jev/                  transport, question sets, assessment, cost
  evaluation/           predictions, outcomes, metrics, calibration
src/components/investment/   report card, scenario table, evidence, horizon picker
src/hooks/useInvestmentRun.ts
src/app/api/investment/runs/…
```

Reused rather than rebuilt: `live/asOf.ts` (evidence standing), `live/transcripts.ts`
(Firestore chunking), `live/budget.ts` (cross-request spend caps),
`live/version.ts` (dated versions, fail-safe flags), `dcf.ts` (one DCF, so the
stock page and the research agent cannot disagree).
