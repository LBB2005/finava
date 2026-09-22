# Investment Research — Implementation Plan (revised)

Revision of `Finava-Claude-Code-Implementation-Plan.md`, corrected against the
actual tree at `main` / `441117f` on 2026-09-21. The original plan's product
spec, contracts and honesty discipline are kept almost intact — they are good.
What changed is the **inventory** (it understated `src/lib/live/`), the
**critical path** (two tasks blocked Milestone A on things that do not exist),
and the **defect descriptions** (now line-level).

Read this alongside the original for the full product spec in §3; it is not
restated here.

---

## 0. Verified baseline — recorded, not assumed

The original Task 0 asked for a baseline and warned not to assume the inspected
commit was current. Done, on 2026-09-21:

```
branch      main (…origin/main), HEAD 441117f
typecheck   clean
tests       238 files / 2806 tests, all passing, 5.95s
uncommitted src/app/api/facts/route.ts, src/app/api/user/route.{ts,test.ts},
            src/hooks/useTickerFacts.ts, src/lib/facts/warm{,.test}.ts (untracked)
```

**There are no pre-existing failures.** This is a stronger starting position than
the original plan allowed for, and it has a consequence worth stating: any red
test from here is unambiguously ours. The original's "record existing baseline
failures separately; never call a failing suite green" hedge is unnecessary —
green means green.

The six uncommitted files are a facts-layer warm-cache change in progress. None
of them are files this plan modifies except `src/lib/facts/` neighbours, so the
risk of collision is low, but **do not `git add -A`** at any point.

---

## 1. Corrections to the inventory

The original inventory's Finava Live row listed `asOf, provenance, ledger,
runState, harness, extractDecision`. The directory actually holds 20 modules,
and four of them are near-exact solutions to problems the plan proposed to solve
from scratch. Reusing them removes roughly a task's worth of work and, more
importantly, avoids shipping a second vocabulary for the same concept.

### 1.1 Evidence standing already exists — do not redefine it

`src/lib/live/asOf.ts:29` already declares, with tests:

```ts
export type FactStandingKind = "clean" | "undated" | "post_asof";
export interface FactStamp { field; source; observedAt; sourceAsOf; standing }
export function standingOf(…); stampFact(…); postDatesAsOf(…);
export function shouldWithhold(stamp); unverifiableStamps(stamps);
```

The original plan's `EvidenceItem.standing: 'clean' | 'undated' | 'post_asof'`
is a character-for-character duplicate, and its "record observation time
separately from publication time" requirement is `observedAt` vs `sourceAsOf`,
already built and already explained at length in that file's header.

**Change:** `EvidenceItem` imports `FactStandingKind` from `@/lib/live/asOf` and
derives `standing` via `standingOf()`. Do not re-declare the union. Two
vocabularies for "we could not date this" is exactly how the honesty property
rots.

### 1.2 Firestore chunking is already solved

`src/lib/live/transcripts.ts` exists because a 12-agent debate transcript pushed
a run document to 1,051,317 bytes and Firestore rejected the write, discarding
an eleven-minute paid step. It defines `CHUNK_CHARS = 200_000` (chosen so 4-byte
UTF-8 worst case stays under 1 MiB), zero-padded chunk doc ids so lexicographic
order is chunk order past 9, and a named subcollection.

Task 4's bullet "store large source excerpts separately in chunked evidence
documents, below Firestore document-size limits" is this module. **Reuse the
chunking helpers rather than writing a second chunker.**

### 1.3 Name collision — rename the transcript adapter

The original Task 4 creates `src/lib/investment/transcripts.ts` for *earnings-call*
transcripts. `src/lib/live/transcripts.ts` is *agent-debate* transcripts. Two
files named `transcripts.ts` holding unrelated concepts, both imported in the
same feature, is a bug waiting to happen.

**Change:** name it `src/lib/investment/callTranscripts.ts`.

### 1.4 Cross-request spend caps already exist — and admin is uncapped

`src/lib/live/budget.ts` solves Task 7's "enforce limits across the whole
persisted run, not only an in-memory request" — `resolveDailyCap()`,
`BudgetExceededError`, and a `chargeStep` that persists the running total
between HTTP invocations precisely because each one gets its own
AsyncLocalStorage context.

Its header also records a trap this plan must not walk into:

> `resolveRunCap()` in `@/agents/ceo` returns Infinity both when there is no
> userId AND for admin UIDs — so a headless daily crew is uncapped by
> construction.

The only user of this feature during personal-use release is an admin UID. So
the per-run credit cap **will not apply to the only person using it.** A research
run that fans out to ~15 agents plus Jev, resumable and retryable, is a plausible
runaway.

**Change:** Task 7 gets an explicit, own budget ceiling modelled on
`live/budget.ts`, enforced independently of `resolveRunCap()`, and it applies to
admins. Add a test that asserts an admin UID is still capped.

### 1.5 Follow the existing version + fail-safe-flag idioms

`src/lib/live/version.ts` establishes both patterns the plan needs:
a dated `AGENT_VERSION` bumped in the same commit as any prompt change, and
`executionMode()`, which returns the mode that *cannot* place an order unless
`LIVE_TRADING_ENABLED === "true"` — "a missing env var during a deploy degrades
to recording rather than trading."

`INVESTMENT_RESEARCH_ENABLED` should read `=== "true"` the same way, so a typo
disables the feature rather than enabling it.

Also: `src/lib/env.ts` validates env through a Zod schema **and** a separate
explicit `process.env` mapping (schema ~L82, mapping ~L156). Adding a var means
editing **two** places; editing one fails silently.

### 1.6 `live/mandate.ts` is the precedent for the quality gates

Its header states the policy the plan's gates re-derive: "MISSING DATA BLOCKS.
If a candidate's market cap or dollar volume is null, eligibility FAILS. We
cannot verify the name is inside the mandate, and a rail that passes when it
can't see is not a rail." Cite this file in the gate code so the two engines
stay recognisably one house style.

---

## 2. Critical-path corrections

Two tasks, as written, blocked Milestone A on things that do not exist in the
repo or the account. Both are fixable by narrowing scope rather than adding work.

### 2.1 There is no exchange calendar — so don't require one to ship

The original Task 2 requires resolving a horizon to an exact exchange-session
date, with "never count weekdays as exchange sessions" as an acceptance
criterion. The repo cannot do this, and says so twice:

- `src/lib/marketHours.ts:5` — "this does not account for exchange holidays"
- `src/lib/marketSession.ts:4` — "exchange holidays ignored"

`grep` finds no holiday table, no session calendar, and no Alpaca `/v2/calendar`
wrapper. So Task 2's acceptance criterion cannot be met, and Milestone A —
everything — sits behind building or licensing an exchange calendar.

That dependency is avoidable, because **the product spec barely needs it.** §3
of the original asks for calendar durations of 1–60 months with presets Short =
3mo, Medium = 12mo, Long = 36mo. Calendar-month horizons need only calendar
arithmetic: clip month-end, add months, done. `yearFraction` (elapsed days /
365.25) needs no calendar either. Only the explicit 5–1260 *trading-day* unit
needs a session calendar, and that unit exists mainly for continuity with Finava
Live's 5/21/63/126.

**Change:**

- `unit: 'calendar_months'` is fully supported now. Month-end clipping, leap
  days, and the 1–60 bound are pure arithmetic and get the tests the original
  listed.
- `unit: 'trading_days'` returns a typed `unsupported_calendar` status until an
  injectable calendar adapter lands. The original already blessed this outcome
  ("Return a clear unsupported-calendar status … rather than inventing a precise
  trading-day target") — this change just makes it the *planned* state instead
  of a failure mode.
- `targetDate` for a calendar-month horizon is a **calendar date**, and the
  contract says so. If it lands on a weekend or holiday, that is a resolution
  note on the mandate, not an error and not a silently-shifted date.
- Wrapping Alpaca `/v2/calendar` behind the adapter interface is a follow-on,
  not a blocker. The interface is injectable from day one so it drops in.

This turns Task 2 from "build an exchange calendar" into an afternoon of date
arithmetic, and unblocks Milestone A.

### 2.2 Jev does not exist in this codebase — take it off the critical path

`grep -rin "typesafe|systemone|jev"` over `src/` and `.env.example` returns
**nothing**. There is no adapter, no key, no env var, no fixture. The plan
depends on an unverified third-party API for the scenario probabilities that
Task 6's rating arithmetic consumes — so as sequenced, Milestone A ("decision
arithmetic works on fixtures") cannot complete until an external vendor
integration is built and its live contract confirmed.

That is backwards. The deterministic engine is the valuable, durable part and it
has no intrinsic need for Jev: `computeReturns` needs a weight triple, and where
the triple came from is exactly what `ProbabilityBasis` exists to record.

**Change — Jev becomes additive, not foundational:**

- `ProbabilityBasis` gains `fixed_prior` alongside the original three. Default
  weights are an explicit, versioned, config-held prior (bear/base/bull =
  .25/.50/.25 as `POLICY_V1.defaultScenarioWeights`), labelled in the UI as a
  fixed assumption, **not** a forecast.
- Tasks 6 and 8 run end-to-end on `fixed_prior`. Milestone A and B complete with
  no vendor dependency at all.
- Task 5 (Jev) moves **after** Task 8, becoming an upgrade that swaps the basis
  from `fixed_prior` to `jev_unvalidated`. Its adapter boundary, validation, and
  "failure leaves weights null" discipline are unchanged and still worth
  building — just not first.
- If the TypeSafe contract turns out to differ from the original plan's §4
  sketch, or the account has no entitlement, the feature still ships. Under the
  original sequencing it would not.

This also honours the original's own rule — "Any investment forecast is an
experimental model judgment until tested on resolved predictions" — more
plainly. A labelled fixed prior is *more* honest than a model-authored
probability presented as a distribution, and it costs nothing per run.

---

## 3. Precise defect descriptions

The original named the right files but described the defects loosely enough that
an implementer could "fix" them without closing them.

### 3.1 Scout constraint leak — three edits, not one

`src/agents/sub-agents/scout-agent.ts`:

1. **L136** — `byTicker` is built from `yearRanked`, i.e. the **whole universe**:
   ```ts
   const byTicker = new Map(yearRanked.map(s => [s.ticker, s]));
   ```
   The pick-validation loop then does `byTicker.get(t)` with the comment
   "validate against the real universe". So a model pick outside the screened
   pool is *accepted*. This is the actual leak. Rebuild the map from the eligible
   pool.

2. **L163** — the survivor gate:
   ```ts
   const poolFloor = tier === "deep" ? n : Math.min(n, 4);
   if (survivors.length >= poolFloor) pool = survivors;
   ```
   A quick-tier screen matching 3 names silently discards the filter and reverts
   `pool` to the full universe. The existing comment shows someone already
   half-fixed this (it used to gate on the full ceiling `n`); finish it. Zero
   survivors must yield an explained empty result, not the S&P 500.

3. **L158** — `applyScreen(universe.stocks, { ...hard, limit: 200 })` caps
   eligibility at 200 of 537 names *before* eligibility is known. The original
   plan warned about `applyScreen`'s default 40 cap but missed that the caller
   already passes a different silent cap. Eligibility must be uncapped; ranking
   and display limits apply afterwards. Prefer splitting `applyScreen` into
   filter and rank/limit halves (`src/lib/screen.ts:104`).

Keep the original's `keepEligiblePicks` guard and its test — they are good, and
they belong on the eligible-pool map from edit 1.

### 3.2 `src/lib/dcf.ts` — three confirmed unit/semantics defects

- **L76** `const equityValue = enterpriseValue - (netDebt ?? 0)` — missing debt
  is silently treated as zero net debt, which *inflates* fair value for exactly
  the companies whose filings are thin. The original's "Missing debt or share
  units are unknown, not zero or one" is this line.
- **L57** `const tg = Math.min(terminalGrowth, a.wacc - 0.005)` — an invalid
  terminal-growth ≥ WACC assumption is silently clamped. The original says
  "do not silently clamp an invalid user assumption"; this is the clamp.
- **L13–L18 + L76** — `baseFcf` may be operating cash flow when capex is
  unavailable (`fcfIsProxy`), and the result is discounted at WACC and then
  bridged by net debt, i.e. treated as FCFF. OCF-without-capex is not FCFF. The
  `fcfIsProxy` flag must survive into the report and suppress precision claims,
  not just annotate a slider.

Also note `suggestedWaccFromBeta` (L40) is a CAPM-flavoured guess clamped to
7–13%. The original is right that it must never be called a measured WACC.

### 3.3 Discovery wave shape — confirmed

`src/agents/discovery.ts:134` — `.slice(0, 3)` confirms heavy valuation reaches
only the top three of each wave, with `WAVE_CONCURRENCY = 4` (L88). Task 9's
requirement that every *highlighted* result carry a complete valuation is
therefore a real change to this file, not a no-op.

---

## 4. Revised sequencing

| # | Task | Change from original |
|---|---|---|
| 0 | Baseline | **Done** — §0 above |
| 1 | Scout constraint leak | Three line-level edits (§3.1) |
| 2 | Mandate / horizon / schemas | `calendar_months` ships; `trading_days` → `unsupported_calendar` (§2.1). Import standing from `live/asOf` (§1.1) |
| 3 | Valuation inputs | Unchanged; defects now line-level (§3.2) |
| 4 | Evidence + claims | Reuse `live/transcripts.ts` chunking; adapter renamed `callTranscripts.ts` (§1.2–1.3) |
| 5 | Returns + rating | **Promoted ahead of Jev.** Runs on `fixed_prior` (§2.2) |
| 6 | Persisted runs | Own budget ceiling that binds admins (§1.4); flag idiom per §1.5 |
| 7 | Single-stock vertical slice | Unchanged |
| 8 | Discovery | Unchanged |
| 9 | **Jev adapter** | **Demoted.** Swaps basis `fixed_prior` → `jev_unvalidated` (§2.2) |
| 10 | Prospective evaluation | Unchanged |
| 11 | Validate + document | Baseline is green, so "green means green" |

Milestones A (tasks 1–5) and B (6–7) now complete with **zero external vendor
dependency**. That is the whole point of the resequencing.

### Per-task done-evidence

"Complete" means a named command passes, not that code was generated:

- Task 1 — `npx vitest run src/agents/sub-agents/scout-agent.test.ts src/lib/screen.test.ts`, including a test that a 3-survivor quick screen keeps the filter.
- Task 2 — `npx vitest run src/lib/investment/`, including `trading_days` → `unsupported_calendar`.
- Task 3 — hand-calculated fixtures; null net debt yields a gap, not a number.
- Task 5 — the original's arithmetic fixtures (`.145`, `.07004672795`) pass.
- Task 6 — admin UID is still budget-capped.
- Every task ends `npm run typecheck && npm test` green against the §0 baseline.

---

## 5. Kept from the original, unchanged

The parts of the original plan that are right and that this revision does not
touch:

- The whole product spec in §3, including the required-report fields and
  `Watch — insufficient evidence` rather than Avoid on missing data.
- All contracts in §4 except the two noted changes (`standing` import,
  `fixed_prior` basis).
- The distinctions it works hardest to protect: score ≠ confidence ≠ probability;
  coverage ≠ accuracy; a provider outage is never an investment Avoid; the
  narrative writer explains a frozen decision and cannot move a number.
- Deterministic-first arithmetic, immutable snapshots, versioned cache identity.
- The evaluation discipline in Task 10 — especially that historical backtests
  with current LLMs are hindsight-contaminated and that date-filtered retrieval
  does not fix model-memory leakage.
- Every execution boundary: local only, no deployment, no trading, no
  `git reset --hard`, don't touch the Live ledger, mock providers in tests.

## 6. Open question for Liam

One product decision I am not making unilaterally: **is Jev (TypeSafe) a
requirement or an experiment?** §2.2 assumes experiment and sequences it last,
which is what makes the feature shippable without vendor risk. If Jev is
actually the point of the exercise, say so and it moves back up — but it should
still not gate the deterministic engine.
