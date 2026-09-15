# W2-1: Fast grounded lane (answer in seconds by default)

**Wave 2 · merge 3rd · port 3011 · branch `feat/w2-1-fast-lane`** · start from `main` with all of Wave 1 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W2-1-fast-lane.md in the same folder. Confirm Wave 1 PRs are merged into main (git log). Set up the worktree exactly as the README says (plan id w2-1-fast-lane, port 3011), then execute the plan with superpowers:executing-plans and TDD. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- Auto sent 80 of 138 turns to the crew: median 253 s, a solo run 382 s, over the 300 s Vercel cap. 48/50 testers complained about waits.
- 13 brevity requests ("yes or no", "3 bullets", "simpler") started a brand-new crew run.
- Quick chat answered in about 15 s and was never collapsed; its answers were just ungrounded.
- **Product decision:** every question gets a grounded answer in under 10 s; the crew only runs on request (W2-2 builds the button).

## Owned files
- `src/app/api/classify/route.ts`
- `src/app/api/chat/route.ts` (becomes the fast grounded lane; keep the path)
- new: `src/lib/quickContext.ts` (+ tests), `src/lib/turnData.ts` (+ tests)
- `src/components/chat/ChatEngine.tsx`: **only** `runAuto` and `runSimpleChat` and their helpers
- `scripts/test-routing.ts` (update labelled cases)

**Do not touch:** `ceo.ts`, `api/agent` (W2-2); `Message.tsx` (W2-3); data libs (W2-4).

## Tasks
1. **Router intents** become `fast | discover | clarify | full_analysis`.
   - `full_analysis` only when the user explicitly asks ("full analysis", "deep dive", "run the crew", "research report on X") or clicks the button (W2-2).
   - "is X a buy", "should I worry about Y" → `fast`.
   - Clarify only when a ticker/target is truly unknown **and** the page context doesn't provide one. Don't ask a clarifying question when the user already gave amount, level and goal (the Priya case).
   - Update `scripts/test-routing.ts` with the readout's failure prompts and keep accuracy at or above today's on the old labelled set (map agent→full_analysis where explicit, else fast).
2. **`quickContext.ts`**: given the tickers in the message, page context and holdings, fetch in parallel with a **2.5 s total budget**, dropping whatever misses the budget:
   - quote (price, change, as-of), key stats (market cap, P/E, 52w range, dividend yield if the feed has it), next earnings date, the 3–5 latest dated headlines, and the Finava score if cheap.
   - Each value is `{ value, source, asOf }`; missing → `Unavailable`.
   - Reuse existing data libs; don't add providers. The W3-1 facts layer replaces this later, so keep the interface small: `getQuickContext(input): Promise<QuickContext>`.
3. **Fast lane prompt** (`/api/chat`): inject the QuickContext as a fenced data block (use `fenceExternal`), the answer contract headings from the README, the brevity/format override, and the clock line. Model: fast Claude (check `src/lib/models.ts` routing; don't pick a new vendor). Target: **first token < 3 s after data, whole answer < 10 s** for a typical ticker question.
4. **Follow-up reuse (`turnData.ts`)**: store the QuickContext (and, when W2-2 lands, the crew's gathered agent outputs) per conversation per turn, in memory plus Firestore on the conversation doc with a 24 h TTL. Short or meta follow-ups ("simpler", "yes or no", "3 bullets", "what about the risks") route to `fast` and reuse the last turn's data without refetching unless it's older than 15 min.
5. **ChatEngine `runAuto`**: wire the new intents. `full_analysis` calls W2-2's entry point (`runAgentMode`); until W2-2 merges, keep calling today's `runAgentMode`. Show the answering lane in the message metadata (4 testers asked for this): `mode: "fast"` and so on.
6. **Timing telemetry**: log `ttft_ms` and `total_ms` per lane through the existing usage/Langfuse path so W4-3 can compare.

## Acceptance
- Routing script: explicit crew requests → `full_analysis`; everything from the readout's "is it too late to buy NVDA" family → `fast`.
- Locally, "is AMD a buy right now?" returns a contract-shaped answer with a Key numbers table (source + as-of) in under 10 s; "so yes or no?" answers in one or two sentences in under 5 s with no refetch (log shows cache hit).
- typecheck, lint and tests are green.
