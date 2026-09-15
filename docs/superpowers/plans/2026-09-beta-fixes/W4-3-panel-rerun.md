# W4-3: Eval harness, panel re-run & launch gate

**Wave 4 · merge 3rd · port 3013 · branch `chore/w4-3-eval-harness`** · start from `main` with Waves 1–3 merged. Run the panel itself **after W4-1 and W4-2 merge**.

## Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-beta-fixes/00-README.md, then W4-3-panel-rerun.md in the same folder. Set up the worktree exactly as the README says (plan id w4-3-eval-harness, port 3013). Build the harness first (it can merge before W4-1/W4-2). Do NOT run the 50-persona panel or any paid measurement until I confirm the estimated spend and that W4-1/W4-2 are merged. Open a PR per the README rules for the harness; publish the new readout as an artifact.
```

## Why
The first panel's harness wasn't kept in the repo. Without a repeatable eval we can't prove the fixes worked, or catch regressions such as the `:233` collapse coming back.

## Owned files
- new: `evals/**` (harness, personas, scenarios, report generator), `package.json` scripts `eval:smoke`, `eval:live`, `eval:panel`
- `src/components/chat/ChatEngine.tsx`: only to export the stream-handling function for the harness, if it isn't already exported (flag it in the PR)
- `.github/workflows/*`: add `eval:smoke` (mocked, no spend) to CI only
- new: `docs/launch/launch-gate.md`

## Tasks
1. **Smoke eval (no spend, CI)**: replays recorded SSE fixtures through the real client stream-handling code (import ChatEngine's stream reducer, **not** a re-implementation). It asserts:
   - the saved content equals the concatenated deltas;
   - cross-lane follow-up payloads contain prior answers (all 13 scripted switches from the readout);
   - contract-shaped answers parse;
   - the Stop state is kept.
2. **Live scenario eval** (`eval:live`, opt-in, paid): about 20 fixed prompts across lanes against a local or preview URL. Records ttft, total time, lane chosen, collapse (the rendered/saved length vs streamed length), contract shape, number-check mismatches (W4-1 logs) and errors. Outputs JSON + markdown.
3. **Persona panel** (`eval:panel`, opt-in, paid): recreate the 5×5×2 grid (AI expertise × stock knowledge) with persona scripts. 40 go through the API harness using the real client payload builder; 10 go through the browser (3 at phone width), if Browser tooling is available to the session. Keep the same metrics as the first readout: NPS, would-pay, would-return, quit, wait by lane, theme counts, fact-check sample of 25. **Estimate the spend and ask Liam first.**
4. **Readout**: generate a comparison against the Sep-14 baseline (NPS −100, 0/50 pay, 44/50 collapse, crew median 253 s, 26 quit) and publish it as an artifact, with the caveats section kept honest (simulated personas).
5. **`docs/launch/launch-gate.md`** criteria to leave private beta (proposed; Liam edits):
   - zero collapse in smoke + live;
   - fast-lane p50 < 10 s, full-analysis p90 < 180 s;
   - 13/13 switch tests pass;
   - number-check mismatch rate < 2% of cited numbers;
   - W1-3's legal packet reviewed by a lawyer;
   - caps measured (W3-4);
   - panel would-return ≥ 6 and at least some "would pay";
   - the `/privacy` entity and postal address TODOs closed.

## Acceptance
- `npm run eval:smoke` runs in CI and **fails** when the `:233` replace bug is re-introduced (prove it with a temporary revert, described in the PR).
- The live and panel scripts run end-to-end on a 2-persona dry run (with approval for its small spend).
