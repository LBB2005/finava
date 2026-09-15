# W1-4: Honest labels (remove claims the product doesn't honour)

**Wave 1 · merge 4th · port 3014 · branch `fix/w1-4-honest-labels`**

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W1-4-honest-labels.md in the same folder. Set up the worktree exactly as the README says (plan id w1-4-honest-labels, port 3014), then execute the plan with superpowers:executing-plans and TDD. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
Small untrue labels erode the one trait testers valued most: 34/50 praised "Unavailable" instead of invented data.
- Settings shows a hard-coded "Alpaca · Connected", but no user has Alpaca linked. The AI-training consent defaults on and nothing reads it.
- A failed AI narrative is still labelled "Powered by Claude · 5-agent analysis", and the canned sentence is cached under that label.
- Grok's badge says "Live social" (`src/lib/models.ts:29`) even when the X search didn't run.
- The pricing page promises "Unlimited chat, lenses & analysis" on a metered plan, plus "Priority processing", which was removed from the code (`Pricing.tsx:35, 51`).
- TOP PICK, grades and "Confidence" read as recommendations. Confidence is distance from 50; placeholder neutral scores get ranked; LIVE and "today" show while the market is closed.

## Owned files
- `src/app/settings/page.tsx`, `src/app/api/user/route.ts`
- `src/app/api/stock/[ticker]/finava-analysis/route.ts`, `src/components/stock/FinavaTab.tsx`
- `src/lib/models.ts`, and wherever the model badge renders its role
- `src/components/landing/Pricing.tsx` (copy only; plan limits belong to W3-4)
- `src/components/research/VerdictHero.tsx`, `src/lib/verdict.ts`, `src/components/research/BoardLeaderboard.tsx`

**Do not touch:** chat engine/prompts (W1-1, W1-3), `llm.ts` (W1-2), `plans.ts` numbers.

## Tasks
1. **Settings connections**: render Alpaca status from real state (linked or not linked). If no per-user Alpaca linking exists, remove the row. The Plaid row is already real; leave it.
2. **AI-training consent**: default **off**. If nothing reads it, either wire it up (exclude that user's data from any training/eval export) or remove the control. Check the codebase for any export first; if there's none, remove the control and note it in the PR.
3. **Finava analysis fallback**: when the AI narrative fails, don't cache it. Render "AI analysis unavailable right now — showing factor data only" with no model badge. Only a real model response gets the "Powered by …" badge, naming the model that actually answered. Test the route: provider error → response flagged `fallback: true`, cache not written.
4. **Model badge roles** describe what ran: Grok shows "X search" only when the X tool actually returned results; otherwise it shows no social claim. Make the role come from the run's metadata, not a static map (keep the map for colours).
5. **Pricing copy**: align it with `plans.ts`. Metered plans say "N credits/month" (import the numbers). Remove "Priority processing" and "Unlimited" wherever a limit exists.
6. **Research labels**:
   - "TOP PICK" → "Highest score"; "Confidence" → "Signal strength". The tooltip explains it's distance from neutral, not a probability.
   - Placeholder or neutral scores (insufficient data) are excluded from ranking and show "Not enough data".
   - LIVE / "today" only while the market is open; otherwise "As of <last close>". Reuse `promptClock`'s market-session util from W1-3 if merged. If not, add a minimal `isMarketOpen` in `src/lib/marketSession.ts` and note it for dedupe.
7. Tests for the verdict/leaderboard label logic and the ranking exclusion.

## Acceptance
- Screenshots (desktop + 375 px) of Settings, the stock Finava tab in its fallback state, the pricing section, and the Research board on a weekend.
- typecheck, lint and tests are green.
