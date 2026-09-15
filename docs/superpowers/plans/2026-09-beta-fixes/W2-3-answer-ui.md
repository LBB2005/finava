# W2-3: Answer UI (verdict first, one or two screens)

**Wave 2 · merge 2nd · port 3013 · branch `feat/w2-3-answer-ui`** · start from `main` with all of Wave 1 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W2-3-answer-ui.md in the same folder. Confirm Wave 1 PRs are merged into main. Set up the worktree exactly as the README says (plan id w2-3-answer-ui, port 3013). Use superpowers:executing-plans, TDD for parsing logic, and the frontend-design skill for the components (match the existing design system, subtle motion). Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- The median crew answer ran 20,900 characters with the verdict near the end. 25 testers wanted the verdict first, 26 found reports far too long, and 17 hit undefined jargon.
- Testers liked it best whenever a short version appeared (#8, #14, #42, #46, #48).
- Follow-up chips were generated from the question only, producing irrelevant chips.

## Owned files
- `src/components/chat/Message.tsx`, `StreamingMarkdown.tsx`, `Markdown.tsx`, `ResponseTiming.tsx`
- new: `src/lib/answerFormat.ts` (+ tests), `src/components/chat/answer/*` (AnswerCard, KeyNumbers, CaseColumns, DetailsExpander, CrewProgress, GlossaryTerm)
- new: `src/lib/glossary.ts` (+ tests)
- the follow-up chip generator (find where chips are generated; likely an API route or a helper in `llm.ts` callers) and its prompt
- `src/app/settings/page.tsx`: the experience-level control only; `src/app/api/user/route.ts`: the `experienceLevel` field
- the first-run/onboarding component (from commit 70f0eee): add the experience question

**Do not touch:** ChatEngine (W2-1/W2-2), ceo/chat prompts.

## Tasks
1. **`answerFormat.ts`**: export the heading constants from the README contract, `parseAnswer(md) → { answer?, keyNumbers?: Row[], bull?, bear?, changeView?, confidence?, details?, raw }`, and `isContractShaped(md)`. It must work on partial markdown **while streaming** (sections fill in as they arrive). Tests cover full, partial, missing-headings fallback, and a brevity answer with no headings.
2. **AnswerCard** layout:
   - `Answer` in larger type at the top.
   - The Key numbers table has source and as-of as small muted chips; `Unavailable` renders styled, not as an error.
   - Bull and Bear side by side on desktop, stacked on mobile.
   - What would change the view.
   - A Confidence & gaps line.
   - `Details` collapsed behind "Show full analysis" (remember the per-message toggle).
   - Non-contract markdown renders as it does today.
3. **Crew progress** (the events W2-2 defines: `crew_plan`, `agent_progress`, `budget_warning`): a compact row of agent chips with states, plus an ETA countdown that adjusts as agents finish. There's no "Assembling your research crew" with no ETA anymore. If W2-2's events haven't merged yet, build against the types in its plan and keep the rendering behind a null check.
4. **"Run full analysis" button** under fast answers that name a ticker (prop `onRunFullAnalysis`). Show the planned depth ("~2 min · 4 analysts") when available.
5. **Glossary**: `glossary.ts` with about 60 terms (P/E, EV/EBITDA, DCF, RSI, MACD, SMA, beta, 13F, Form 4, ETF, expense ratio, APY, 401(k), IRA, CFP, …) and one-sentence plain-English definitions. `GlossaryTerm` underlines the **first** occurrence per message and shows the definition in a popover (tap on mobile). Only on for `experienceLevel` beginner or intermediate.
6. **Experience level**: one onboarding question ("How familiar are you with investing?" Beginner / Some experience / Professional) and the same control in Settings. Store it on the user doc as `experienceLevel`. Expose it in the chat request payload as a field the prompts can read (W2-1/W4-1 consume it; defaulting to intermediate).
7. **Follow-up chips from the answer**: generate them after the final text using the answer's own content (tickers, gaps, bear points). Max 3, each under 40 characters. Never chips about definitions the user didn't ask about.
8. **Stop/partial states** from W1-1 keep working in the new card.

## Acceptance
- A storybook-style dev page or a vitest+RTL render test with fixtures: a full crew answer, a fast answer, a brevity answer, partial streaming, and a non-contract legacy message.
- Screenshots at 375 px and desktop: the fast answer shows the verdict in the first screen; the crew answer is at most two screens with Details collapsed.
- typecheck, lint and tests are green.
