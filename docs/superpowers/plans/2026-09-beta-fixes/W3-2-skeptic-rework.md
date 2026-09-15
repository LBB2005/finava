# W3-2: Skeptic rework (trustworthy or quiet)

**Wave 3 · merge 2nd · port 3012 · branch `fix/w3-2-skeptic`** · start from `main` with Waves 1–2 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W3-2-skeptic-rework.md in the same folder. Confirm Waves 1–2 are merged into main. Set up the worktree exactly as the README says (plan id w3-2-skeptic, port 3012), then execute the plan with superpowers:executing-plans and TDD. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- 23 testers liked the Skeptic idea, and 23 saw it contradict the report it was attached to. It critiques text that isn't in the report and flags real SEC figures as fabricated.
- It reviews about 800 characters per agent (`ceo.ts:149–195`) and fails open: when its call fails, the step still shows complete.
- It's one of the four real differentiators the readout found. Fix it rather than drop it.

## Owned files
- `src/agents/ceo.ts`: **only** the skeptic/review/revision block and its helpers (extract them to `src/agents/skeptic.ts`)
- new: `src/agents/skeptic.ts` (+ tests)
- `src/components/chat/Message.tsx` / `src/components/chat/answer/*`: **only** the Second Opinion rendering
- `src/types/chat.ts` (skeptic event fields)

**Do not touch:** crew planner or budget (W2-2 code; call it, don't change it), facts (W3-1).

## Tasks
1. **Extract** the review and revision logic to `skeptic.ts` with an injectable LLM client so it's testable.
2. **Review the right thing**: the reviewer gets (a) the **final draft** text in full and (b) the **full structured agent evidence** (each agent's output, sources and as-of, not truncated excerpts). Stay within the token budget by passing structured fields rather than prose; if it's still too large, prioritize the agents whose numbers appear in the draft.
3. **Structured critique**: the reviewer returns JSON `{ issues: [{ quote: string (verbatim from draft), problem: "unsourced"|"contradicts_evidence"|"stale"|"overclaim"|"advice_line", evidence?: string, fix: string }] }`. **Drop any issue whose `quote` isn't found verbatim in the draft**; this removes "critique of a different draft" by construction. Test it.
4. **Fold, don't attach**: the revision pass applies the valid issues. The remaining unresolved issues go into the answer's `## Confidence & gaps` as short caveats. The separate "Second Opinion" box shows only a summary ("Reviewed against 4 analysts' evidence · 3 corrections applied · 1 caveat"), expandable to the issue list.
5. **Budget-aware**: if the W2-2 budget has under 25 s left, skip the review and say so.
6. **Honest failure**: if the review errors or is skipped, emit `{ type: "skeptic_status", status: "skipped"|"failed", reason }` and render "Second opinion didn't run for this answer." Never show the step as complete when it didn't run.
7. **False-positive guard**: a figure that exactly matches a value in the agent evidence (after number normalization, e.g. $1.2B vs 1,200,000,000) can't be flagged `unsourced`. Test with the SEC-figure false positive from the readout.

## Acceptance
- Unit tests: non-verbatim quote dropped; matching evidence number not flagged; failure → honest status.
- A real full analysis on port 3012: the Second Opinion summary matches the corrections visible in the report; no critique references absent text.
- typecheck, lint and tests are green.
