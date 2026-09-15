# Beta-fix roadmap (Sep 2026)

Source: the 50-tester beta readout (artifact "Finava Beta Readout", 13–14 Sep 2026, main @ 41277e0).
Headline: NPS −100, 0/50 would pay, 44/50 lost a finished answer, crew median wait 4.2 min.

Product decision (locked): **fast grounded answer by default, full crew only on request.**

## How to run this

- 15 plans in 4 waves. Run **one wave at a time, 3–4 sessions in parallel**.
- Each session: own git worktree → own branch → one PR. Merge the wave's PRs in the listed order, then start the next wave from fresh `main`.
- Each plan starts with a **Kickoff prompt**. Paste it into a new chat session as-is.

| Wave | When | Sessions (merge order) | Theme |
|---|---|---|---|
| 1 | now | W1-1 → W1-3 → W1-2 → W1-4 | Stop losing answers; fail honestly; prompts that tell the truth |
| 2 | after W1 merged | W2-4 → W2-3 → W2-1 → W2-2 | Answer in seconds; redesign the answer; fix data bugs |
| 3 | after W2 merged | W3-1 → W3-2 → W3-3 → W3-4 | One facts layer; trustworthy Skeptic; mobile; credits/pricing |
| 4 | after W3 merged | W4-1 → W4-2 → W4-3 | Chat cites facts; honest DNA; re-run panel + launch gate |

### Wave 1: stop the bleeding
- [W1-1 Chat integrity](W1-1-chat-integrity.md): collapse bug, one transcript, URL, Stop button
- [W1-2 Provider resilience](W1-2-provider-resilience.md): OpenRouter SPOF, silent router fallback, poisoned cache, degraded banner
- [W1-3 Prompt truth & advice line](W1-3-prompt-truth.md): no stop-losses, today's date, computed portfolio weights
- [W1-4 Honest labels](W1-4-honest-labels.md): fake "Connected", "Powered by Claude" on fallbacks, pricing copy, LIVE/TOP PICK

### Wave 2: answer in seconds, and make it land
- [W2-1 Fast grounded lane](W2-1-fast-lane.md): default answer in under 10 s from live data; Auto rewired
- [W2-2 Crew on request](W2-2-crew-on-request.md): "Run full analysis", sized crew, progress/ETA, 300 s-safe
- [W2-3 Answer UI](W2-3-answer-ui.md): verdict first, key numbers w/ source, expander, glossary, experience level
- [W2-4 Data correctness](W2-4-data-correctness.md): EDGAR fiscal years, Form 4, earnings date, split-adjusted cap

### Wave 3: one set of numbers
- [W3-1 Facts layer](W3-1-facts-layer.md): `src/lib/facts`, one score, one DCF, stock + Research on it
- [W3-2 Skeptic rework](W3-2-skeptic-rework.md): full evidence, folded caveats, honest failure
- [W3-3 Mobile & holdings](W3-3-mobile-and-holdings.md): phone-width pages, edit/delete holdings
- [W3-4 Credits & pricing](W3-4-credits-and-pricing.md): measure per-run cost, reset caps, align pricing

### Wave 4: prove it
- [W4-1 Chat cites facts](W4-1-chat-cites-facts.md): model never does arithmetic; source links; Discover ETF honesty
- [W4-2 Investor DNA honesty](W4-2-investor-dna.md): benchmarked track record; DNA reaches chat
- [W4-3 Panel re-run & launch gate](W4-3-panel-rerun.md): in-repo eval harness, re-run 50 personas, legal packet

## File ownership (conflict map)

A session may edit only its **owned** files. It can make a one-line call-site change in a shared file when it has to, but it must say so in the PR description. Hotspots:

| File | W1 | W2 | W3 | W4 |
|---|---|---|---|---|
| `src/components/chat/ChatEngine.tsx` | **W1-1** | W2-1 (`runAuto`, `runSimpleChat`), W2-2 (`runAgentMode`, `deepen`) | — | W4-1 (context payload only) |
| `src/agents/ceo.ts` | **W1-3** (prompts); W1-2 one call to `toUserFacingError` | **W2-2** | **W3-2** (skeptic block) | W4-1 (facts block) |
| `src/components/chat/Message.tsx` | W1-1 (verdict fill, Stop state only) | **W2-3** | W3-2 (Second Opinion box) | — |
| `src/lib/llm.ts` | **W1-2** | — | W3-4 (cost metering hooks) | — |
| `src/app/api/classify/route.ts` | W1-2 (catch block), W1-3 (date line) | **W2-1** | — | — |
| `src/app/api/chat/route.ts` | **W1-3** | **W2-1** | — | W4-1 |
| `src/components/chat/ChatContainer.tsx` | **W1-3** | — | — | W4-1 |
| `src/lib/factors.ts` | — | **W2-4** | W3-1 (reads only) | — |
| `src/app/settings/page.tsx` | **W1-4** | W2-3 (experience-level control) | W3-3 (layout) | — |
| `src/lib/plans.ts`, `Pricing.tsx` | W1-4 (copy only) | — | **W3-4** | — |

Two sessions in the same wave editing different functions of one file (W2-1/W2-2 in ChatEngine) is OK. Git merges non-overlapping hunks. Merge in the listed order and rebase the later PR.

## The answer contract (shared by W2-1, W2-2, W2-3, W3-2, W4-1)

Every fast-lane and crew answer is markdown with these exact H2 headings, in this order. The model writes them; the UI parses them. If the headings are missing, the UI falls back to rendering plain markdown.

```
## Answer
2–3 plain-English sentences. The verdict/answer to the literal question. No hedging preamble.

## Key numbers
| Metric | Value | Source | As of |
(only numbers that came from data/tools; "Unavailable" when missing, never invented)

## Bull case
- up to 3 bullets

## Bear case
- up to 3 bullets

## What would change the view
- 1–3 bullets

## Confidence & gaps
One line: High/Medium/Low + what data is missing (e.g. "no options data for this ticker").

## Details
(crew-only: per-agent sections, tables, charts, conflicting signals. UI collapses this by default.)
```

- Simple conceptual questions ("what is an ETF") may use only `## Answer` (+ optional `## Details`). The UI must handle any subset.
- Brevity or format requests ("yes or no", "3 bullets", "simpler") override the contract. Answer in the requested shape.
- Research framing only: no stop-loss levels, share counts, trim plans, or "you should buy/sell" about the user's own holdings.
- A shared constant lives at `src/lib/answerFormat.ts` (heading names + a `parseAnswer(md)` function). **W2-3 creates it.** W2-1 and W2-2 copy the heading strings from this README until W2-3 merges, then switch to importing it.

## Rules for every session

1. **Worktree setup** (from the main checkout):
   ```bash
   git -C /Users/liamblackshaw-brown/code/finava worktree add ../finava-<plan-id> -b fix/<plan-id> main
   cp /Users/liamblackshaw-brown/code/finava/.env /Users/liamblackshaw-brown/code/finava/.env.local ../finava-<plan-id>/
   cd ../finava-<plan-id> && npm install
   ```
   Use a unique dev port per session: W?-1 → 3011, W?-2 → 3012, W?-3 → 3013, W?-4 → 3014. Add a `.claude/launch.json` entry inside the worktree. If the dev server dies on start, `rm -rf .next`.
2. Read `AGENTS.md`. This Next.js version differs from training data. Check `node_modules/next/dist/docs/` before touching routing or config.
3. Previewing authenticated pages: use the dev-auth toggle (localStorage key `finava_dev_auth`). Check at 375 px width and at desktop width.
4. **No fabricated data.** Missing data renders "Unavailable". No plausible stand-ins, ever.
5. UI follows the 2026-07 consistency standards: tokens-only colours, `.std-focus`, the z-scale, and the existing modal/button/skeleton components. Motion stays subtle.
6. TDD for logic (vitest). Before opening the PR: `npm run typecheck && npm run lint && npm test` all green. Don't lower the coverage threshold.
7. Shell-exported `ANTHROPIC_API_KEY` shadows `.env.local`. Scripts already `env -u` it; do the same for any ad-hoc run.
8. Before any live chat test, confirm the OpenRouter balance: classify "full analysis of NVDA" should return in ~1 s, not 0.1 s.
9. Stay inside your owned files. If you find an out-of-scope bug, note it in the PR under "Found, not fixed".
10. PR title `fix(<area>): …` or `feat(<area>): …`. The body lists: what changed, the readout issue(s) addressed, verification evidence (test names, screenshots), shared-file touches, and follow-ups.
