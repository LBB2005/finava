# W4-2: Investor DNA honesty (the long-term moat has to be credible)

**Wave 4 · merge 2nd · port 3012 · branch `fix/w4-2-investor-dna`** · start from `main` with Waves 1–3 merged

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W4-2-investor-dna.md in the same folder. Confirm Waves 1–3 are merged into main. Set up the worktree exactly as the README says (plan id w4-2-investor-dna, port 3012), then execute the plan with superpowers:executing-plans and TDD. Stay inside the owned files. When done, open a PR per the README rules.
```

## Why
- The readout names "an analyst that knows you and publishes how well its calls hold up" as the moat no competitor has, but says it "isn't credible yet".
- Investor DNA overclaims a "real edge": returns aren't benchmarked, and traits are scored with **today's** factors (look-ahead) (`src/lib/investorDna.ts`, `src/app/dna/page.tsx`).
- ASK FINAVA sends no DNA to chat, so chat invents a different profile ("your stated profile").
- 16 testers praised downside shown in their own dollars; that's the same "knows your book" value.

## Owned files
- `src/lib/investorDna.ts` (+ tests), `src/app/dna/**`, `src/app/api/dna/**`
- the ASK FINAVA entry point on the DNA page, plus a `dnaSummary` field added to the chat request payload (one call site in the chat payload builder; flag it in the PR)
- Finava Live public track-record page copy/labels (find under `src/app/live` or `api/live`): labels only

**Do not touch:** facts internals (use them), prompts beyond adding the DNA block to `/api/chat` (one insertion, flagged).

## Tasks
1. **Benchmark**: each holding's and each trait's return is compared with SPY (and the sector ETF where mapped) over the same holding window. Show excess return, not raw.
2. **No look-ahead**: score traits with factor values **as of the purchase date** when historical factors exist. If they don't, label the trait "based on current factors (not point-in-time)" and exclude it from any "edge" claim.
3. **Significance gate**: only say "edge" when there are ≥ 8 positions in the trait, ≥ 6 months of history, and excess return beyond a simple threshold (document it). Otherwise say "Too early to tell — N positions, M months." Tests for the gate.
4. **DNA to chat**: a compact `dnaSummary` (style traits, concentration, typical holding period, benchmarked results, and the "too early" flags) goes to `/api/chat` and the crew as context labelled "inferred from your holdings". Never "stated".
5. **Finava Live labels**: the track-record page shows pre-registration date, sample size, benchmark and hit rate with a confidence interval. Remove any unqualified "beats the market" language.

## Acceptance
- A test portfolio with 3 positions shows "Too early to tell" and no edge claim; a fixture with 12 positions over 14 months shows benchmarked excess returns.
- ASK FINAVA from DNA: chat's answer references the inferred traits correctly (screenshot).
- typecheck, lint and tests are green.
