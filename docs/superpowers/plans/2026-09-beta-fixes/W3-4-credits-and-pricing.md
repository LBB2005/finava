# W3-4: Credits & pricing (measure before charging)

**Wave 3 · merge 4th · port 3014 · branch `fix/w3-4-credits-pricing`** · start from `main` with Waves 1–2 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W3-4-credits-and-pricing.md in the same folder. Confirm Waves 1–2 are merged into main. Set up the worktree exactly as the README says (plan id w3-4-credits-pricing, port 3014), then execute the plan with superpowers:executing-plans. The measurement run spends real API credits — tell me the estimated spend and wait for my OK before running it. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- Every paid plan caps a run at 300 credits (about $0.30) (`plans.ts:76–129`, `ceo.ts:291–300`), including the $100 Quant tier. Admins and dev are uncapped, so no beta tester can hit the abort. Normal crew runs likely exceed it.
- 0/50 testers would pay; 25 said maybe. Pricing has never been checked against real per-run cost.

## Owned files
- `src/lib/plans.ts`, the usage tracker (`src/lib/usage*`), `src/app/api/usage/**`
- `src/lib/llm.ts`: **metering hooks only** (W1-2 owns the logic, already merged)
- `src/components/landing/Pricing.tsx` (numbers now; W1-4 did the copy)
- Stripe plan config under `src/app/api/stripe/**` (read and align; don't create live products)
- new: `scripts/measure-run-cost.ts`, `docs/pricing/run-cost-2026-09.md`

**Do not touch:** crew planner or budget (W2-2), chat UI.

## Tasks
1. **Per-run cost attribution**: make sure every LLM and paid-data call in a run is attributed to one `runId` (fast answer, full analysis, deep research, discover) with tokens, model and $ cost. Add a `run_cost` log line at the end of each run. Tests: a mocked run sums its sub-calls correctly.
2. **`scripts/measure-run-cost.ts`**: run a fixed set of about 30 representative prompts (10 fast, 10 full analysis, 5 discover, 5 deep research; reuse the readout's prompt families) against the local server as a test user. Record cost p50/p90/max and duration per lane. **Estimate the spend first and ask Liam before running.**
3. **Write `docs/pricing/run-cost-2026-09.md`** with the table, then propose per-run caps set at about 1.5× each lane's p90, and monthly credit allowances per plan that keep gross margin ≥ 70% at an assumed usage (state the assumptions).
4. **Apply the caps** in `plans.ts` as per-lane caps (fast / full / deep / discover), not one number. Hitting a cap produces a partial answer with a clear "Run stopped at your plan's per-run limit" (not a silent abort). Admin/dev keep the option to be uncapped, but add an env flag `ENFORCE_CAPS_FOR_ADMINS=1` so testing can see real behaviour.
5. **Beta testers on real plans**: an admin-only way to assign a plan to an allowlisted tester (extend the existing admin allowlist mechanism) so they experience the caps.
6. Update the numbers in `Pricing.tsx` from `plans.ts` imports.

## Acceptance
- The cost report is committed; caps are backed by measured p90s; a forced-cap test shows the graceful stop message.
- typecheck, lint and tests are green.
