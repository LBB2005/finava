# Launch gate: leaving private beta

**Status: proposed, for Liam to edit.** Written with W4-3 (Sep 2026). Finava leaves private beta
only when every line below passes. The readout (`evals/report/build.ts`) scores the measurable lines
from eval results. Tick the hand-checked lines here: the report builder reads these checkboxes.

## Measured (scored by the readout)

| # | Criterion | Measured by | Why this bar |
|---|---|---|---|
| 1 | **Zero collapse** in smoke and live | `npm run eval:smoke` (CI) + `npm run eval:live` collapse check (streamed = rendered = saved = reloaded) | 44/50 Sep-14 testers lost a finished answer. One recurrence costs the product's credibility. |
| 2 | **Fast-lane p50 < 10 s** | `eval:live`, fast lane, total time | The product decision: a grounded answer in seconds by default. Sep-14 quick chat was 15 s p50. |
| 3 | **Full-analysis p90 < 180 s** | `eval:live`, full_analysis lane | Sep-14 crew p90 was 386 s, over Vercel's 300 s cap. 180 s leaves headroom under the cap. |
| 4 | **13/13 switch tests pass** | `eval:smoke`, `switches.smoke.test.ts` | Sep-14: 13/13 failed. 12 of the 16 testers told their earlier answer never existed quit. |
| 5 | **Number-check mismatch rate < 2%** of cited numbers | `eval:live`, `number_check` events from W4-1 | The Sep-14 fact-check found errors in the model's own arithmetic, not in the feeds. Unavailable until W4-1 emits the event. |
| 6 | **Panel would-return ≥ 6** (mean, 1–10) **and at least some "would pay"** | `eval:panel` | Sep-14: 3.7 and 0/50. Simulated personas are a floor check, not market proof. |

## Hand-checked (tick when done)

- [ ] Legal packet reviewed by a lawyer (W1-3's `docs/legal/advice-line-audit.md`, `/terms`, `/privacy`)
- [ ] Per-lane caps measured (W3-4, `docs/pricing/run-cost-2026-09.md`; re-measure if a lane's prompts changed since)
- [ ] /privacy entity and postal address TODOs closed (`src/app/privacy/page.tsx`)

## Not in the gate, but read before deciding

- The panel is simulated. A pass here earns a small real-user cohort, not a public launch.
- Deep research still runs past the 300 s route cap (W3-4 finding). If it stays user-reachable, it needs its own time bar.
- The provider-resilience banner (W1-2) should be exercised once against a forced OpenRouter failure before launch.
