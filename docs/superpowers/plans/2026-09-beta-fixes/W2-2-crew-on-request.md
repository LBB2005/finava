# W2-2: Crew on request (sized, visible, under the cap)

**Wave 2 · merge 4th · port 3012 · branch `feat/w2-2-crew-on-request`** · start from `main` with all of Wave 1 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W2-2-crew-on-request.md in the same folder. Confirm Wave 1 PRs are merged into main. Set up the worktree exactly as the README says (plan id w2-2-crew-on-request, port 3012), then execute the plan with superpowers:executing-plans and TDD. Stay inside the owned files. When done, open a PR per the README rules (this PR merges last in Wave 2 — rebase on W2-1 and W2-3 first).
```

## Why
- The crew is valuable when someone wants depth (#48: "better first-draft diligence memo than most junior analysts"), but 12–15 agents on every ticker drove the waits, most of the cost and most of the failures.
- `/api/agent` has `maxDuration 300`; runs took up to 385 s at p90.
- No progress or ETA (11 testers); Deep Research wasn't clearly different from Auto's crew.

## Owned files
- `src/agents/ceo.ts` (orchestration, crew selection, budget; **not** the Skeptic block, which W3-2 reworks)
- `src/app/api/agent/route.ts`
- `src/types/chat.ts` (new event types)
- `src/components/chat/ChatEngine.tsx`: **only** `runAgentMode`, `deepen`, `handleAgentEvent`
- new: `src/agents/crewPlanner.ts` (+ tests)

**Do not touch:** `Message.tsx` (W2-3 renders the button and progress, using the event and prop shapes you define below; agree them via the PR), classify/chat routes (W2-1).

## Contract with W2-3 (define early and push a draft PR within the first hour)
- `Message` gets `onRunFullAnalysis?: () => void`, shown under fast-lane answers that mention a ticker.
- Agent events added to `types/chat.ts`:
  - `{ type: "crew_plan", agents: string[], etaSeconds: number }`
  - `{ type: "agent_progress", agent: string, status: "running"|"done"|"failed"|"skipped", ms?: number }`
  - `{ type: "budget_warning", remainingSeconds: number }`

## Tasks
1. **`crewPlanner.ts`**: `planCrew(question, context) → { agents, etaSeconds }`. It's deterministic: a rules table from question type to agents, with **3–5 agents** for a normal full analysis. Examples:
   - valuation → fundamentals, dcf, comparables, analyst
   - "should I worry / risk" → risk, news, insider, macro
   - earnings → earnings, analyst, news, technical
   - income or dividend → fundamentals, risk, macro
   - Deep Research uses 8–10 agents with a longer budget and is labelled as such. Unit-test the table.
   - ETA = sum of the rolling median per-agent latency (seed it with constants from the readout's timings) plus synthesis.
2. **Budget**: a hard 240 s wall clock for full analysis inside the 300 s route cap. At 200 s, synthesize with whatever agents finished and list the skipped or late agents under `## Confidence & gaps`. Deep Research: move it to a background job only if the codebase already has a job/queue pattern. Otherwise cap Deep Research at 280 s the same way and note in the PR that a durable-workflow follow-up is needed. Don't add new infrastructure in this PR.
3. **Parallelism audit**: make sure the selected agents run concurrently with per-agent timeouts (30–45 s); a slow agent is marked `failed`/`skipped`, never blocks.
4. **Synthesis output** follows the answer contract (README) with crew detail under `## Details`. Keep W1-3's advice-line rules intact.
5. **Reuse gathered data**: save each agent's structured output to `turnData` (W2-1's module). If W2-1 isn't merged yet, write to the same interface with a local stub and rebase. A follow-up after a crew run can then be answered by the fast lane from those outputs.
6. **ChatEngine**: `runAgentMode` handles the new events (store per-conversation progress for W2-3 to render). `onRunFullAnalysis` sends a `full_analysis` request carrying the previous user question + ticker and reuses the QuickContext.
7. Tests: a planner table test; a budget test with fake timers (slow agent → partial synthesis at the deadline, which lists the gap); event emission order.

## Acceptance
- A real "full analysis of AMD" on port 3012: 3–5 agents, `crew_plan` ETA shown in the event log, finished in under 150 s on a healthy backend, contract-shaped output.
- A forced slow agent (env flag) still finishes by 240 s with the gap listed.
- typecheck, lint and tests are green.
