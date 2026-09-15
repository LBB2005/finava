# W1-3: Prompt truth & the advice line

**Wave 1 · merge 2nd · port 3013 · branch `fix/w1-3-prompt-truth`**

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W1-3-prompt-truth.md in the same folder. Set up the worktree exactly as the README says (plan id w1-3-prompt-truth, port 3013), then execute the plan with superpowers:executing-plans and TDD. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- The crew prompt demands stop-losses, trim levels and "actionable recommendations" (`ceo.ts:214, 353, 380`), contradicting the no-personalized-advice rule in the same prompt. It produced share-count rebalance plans labelled "not personalized advice".
- No prompt knows today's date. Reports were dated "July 2026", filed FY2025 results were called projections, and estimated earnings dates were stated as fact.
- Portfolio totals and weights are left to the model (`ChatContainer.tsx:13–44`). One answer put MRNA at 55.9% of a book where it was 15.3%; allocations summed to 110–125%.
- Chat refused "does this app cost money?" (public info), and an inferred profile was called "your stated profile".

## Owned files
- `src/agents/ceo.ts`: prompts and the `final_response` emit sites
- `src/app/api/chat/route.ts`, the skills prompt (`getSkillsPrompt` and the `DATA_ACCURACY_RULE` location)
- `src/agents/discovery.ts` prompts, and sub-agent prompts where a date matters (earnings, news, macro)
- `src/app/api/classify/route.ts`: **add the date line only**
- `src/components/chat/ChatContainer.tsx` (`buildPortfolioContext`)
- new: `src/lib/promptClock.ts`, `docs/legal/advice-line-audit.md`

**Do not touch:** `ChatEngine.tsx` (W1-1), `llm.ts` (W1-2).

## Tasks
1. **`promptClock.ts`**: `promptClockLine(now = new Date())` returns e.g. `Today is Monday, 14 September 2026 (US/Eastern). US market: closed (weekend); last close Fri 11 Sep.` Use the existing market-hours util if there is one; otherwise write a small one with a holiday list. Tests cover weekend, pre-market, open, after-hours, and a holiday. Inject it into: the CEO system prompt, `/api/chat`, classify, discovery, and date-sensitive sub-agents.
2. **Advice line** in `ceo.ts`: replace the "Triggers & Guardrails / stop-loss / trim levels / actionable recommendations" instructions with research framing:
   - Allowed: scenario levels about the **stock** ("below $X the valuation case breaks"), what would change the view, and risk factors.
   - Forbidden: stop-loss or trim levels for the user's holdings, share counts, rebalance plans, "you should buy/sell", or calling an inferred profile "your stated profile" (say "based on your holdings").
   - Keep the no-personalized-advice rule as the single source of truth and make sure nothing in the prompt contradicts it. Add a vitest that asserts the assembled CEO prompt contains none of: `stop-loss`, `trim level`, `actionable recommendation`, `rebalance threshold`.
3. **Emit side of the collapse fix**: every place that emits `final_response` with the **full** text (not a delta) sets `replace: true` (W1-1 adds the field). Deltas stay as they are. Update `ceo.test.ts` and `discovery.test.ts`.
4. **Computed portfolio context**: `buildPortfolioContext` outputs a table with per-holding market value, weight %, cost basis (per-share × qty), unrealized P&L, total value, cash, and the weights sum (=100%), with a price as-of time. It tells the model: "Use these weights verbatim; do not recompute." Tests: the weights sum to 100 ± 0.1; cash is included; a missing quote yields "Unavailable" and is excluded from weights, with a note saying so.
5. **Product questions**: add a short "About Finava" block to the chat/skills prompt covering current plans and prices (read from `src/lib/plans.ts`, not hard-coded), the free tier, and what the app does. The model answers directly. Test that the prompt includes the plan names from `plans.ts`.
6. **Legal packet**: `docs/legal/advice-line-audit.md` lists every prompt instruction touching recommendations (before/after), the disclaimer text, and 3 example outputs for a lawyer to review. It's documentation only.

## Acceptance
- A real crew run on a held ticker (port 3013) shows no stop-loss or share-count guidance; it's correctly dated; the portfolio weights match the table.
- typecheck, lint and tests are green.
