# Chat feel: smooth streaming, steady scroll, real progress (Sep 2026)

Source: Liam, 18 Sep 2026, after the panel re-run. The worst place is **chat while it answers**:
scroll **jumps**, scroll **stutters**, content **jumps around** as it loads, and the loading
animations feel bad. Want instead: **show real progress** (what it's doing, how far along).
**Desktop and phone equally.** Motion stays subtle and refined (Liam's standing preference).

**Budget: $10 total API spend across all sessions. Plan for about $5.** UI work runs on recorded
streams replayed locally, which costs nothing.

## How to run this

- 3 sessions, **one after another** (not in parallel): all three touch `MessageList.tsx` /
  `StreamingMarkdown.tsx`. Merge each PR before starting the next session from fresh `main`.
- Each session: own git worktree → own branch → one PR. Paste its **Kickoff prompt** into a new chat.
- This plan lives only in the **main checkout** (not committed), so worktrees won't have it. Read it,
  and update its tables, at `/Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-chat-feel/00-README.md`.

| # | Session | Port | Spend cap | Depends on |
|---|---|---|---|---|
| 1 | [Replay bench & baseline](#session-1-replay-bench--baseline) | 3011 | $1 | — |
| 2 | [Smooth streaming & steady scroll](#session-2-smooth-streaming--steady-scroll) | 3012 | $0 | 1 merged |
| 3 | [Real progress while it loads](#session-3-real-progress-while-it-loads) | 3013 | $4 | 2 merged |

## Rules for every session

1. **Worktree** (from the main checkout):
   ```bash
   git -C /Users/liamblackshaw-brown/code/finava worktree add ../finava-<id> -b fix/<id> main
   cp /Users/liamblackshaw-brown/code/finava/.env /Users/liamblackshaw-brown/code/finava/.env.local ../finava-<id>/
   cd ../finava-<id> && npm install
   ```
   Add a `finava-<id>` entry to the MAIN checkout's `.claude/launch.json`
   (`sh -c "cd <worktree> && exec env -u ANTHROPIC_API_KEY node node_modules/next/dist/bin/next dev --port <port>"`),
   because `preview_start` reads that file. If the dev server dies on start, `rm -rf .next`.
2. Read `AGENTS.md`: this Next.js differs from training data; check `node_modules/next/dist/docs/`.
3. Auth for previews: localStorage `finava_dev_auth` = `1`, then reload. Check **375 px and 1440 px**.
4. **Spend:** the session's cap in the table is hard. Never run `eval:panel`. `eval:live` only with
   `--only <scenario>` and only when the prompt says so. Before any paid call, say what it costs; at the
   end, report what was spent. OpenRouter may be out of credits (calls fall back to direct providers,
   slower) — that's fine for UI work; note it if it skews a timing.
5. UI standards (2026-07 consistency pass): tokens-only colours, `.std-focus`, the z-scale, existing
   skeleton/button components. Motion: subtle, ≤200 ms, and everything respects
   `prefers-reduced-motion`. No new animation library.
6. TDD for logic (vitest). Before the PR: `npm run typecheck && npm run lint && npm test && npm run eval:smoke`,
   all green. The smoke eval guards the old collapse bug (`ChatEngine.tsx:233`): don't break the
   `final_response` replace/append contract.
7. **Measure, don't eyeball.** Every claim of "smoother" comes with before/after numbers from the
   Session 1 bench.
8. PR title `fix(chat): …`. Body: what changed, before/after numbers, screenshots at both widths,
   spend, follow-ups. Stay in scope; note out-of-scope finds under "Found, not fixed".

## What the code suggests (hypotheses — confirm by measuring)

- **Scroll jumps.** `src/components/chat/MessageList.tsx:306-318` runs `scrollIntoView` in an effect
  keyed on `revealed`, which changes on *every animation frame* of the reveal. When the reader is
  within 120 px of the bottom it re-pins every frame, so scrolling up a little mid-answer gets yanked back.
- **Stutter.** `useSmoothStream` (`StreamingMarkdown.tsx`) calls `setDisplay` every rAF, and each
  call re-renders the **whole** growing answer through `react-markdown` + `remark-gfm`, the contract
  parser (`isContractShaped` / `AnswerCard`) and glossary marking. Work per frame grows with length:
  crew answers are 16–20k characters.
- **Content jumps.**
  - `MessageList.tsx:298-300` shows the crew panel only while `!streamingContent`, so the whole
    `CrewProgress` panel unmounts the moment the first token arrives.
  - The answer switches renderer when it becomes contract-shaped (plain markdown → `AnswerCard`).
  - The streaming block is swapped for a committed `Message` when the stream ends.
  - Several `TypingIndicator` variants swap labels.
- **No real progress in the default lane.** The crew already emits `crew_plan`, `agent_progress` and
  an ETA (W2-2). `/api/chat` (the fast lane) sends only `meta` then text, so its ~2.5 s data fetch and
  the model's wait show a generic "Thinking it through".

---

## Session 1: Replay bench & baseline

**Branch** `fix/chat-replay-bench` · **port 3011** · **cap $1**

### Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-chat-feel/00-README.md and do Session 1 (plan id chat-replay-bench, port 3011). Set up the worktree exactly as the README says. Use TDD for logic. Spend cap $1: tell me before any paid call. When done, open a PR per the README rules, put the baseline numbers in the PR body, and fill in the Baseline table in the README in the main checkout.
```

### Why
All later work has to be measured, and it has to be free to repeat. Replaying recorded streams through
the real chat UI gives the same answer every time at zero cost.

### Tasks
1. **Record real streams once (≈ $0.30):** `npm run eval:live -- --yes --record --only <scenarios>` for one
   fast-lane answer, one Discover answer and one full-analysis crew run (the long one matters most).
   Check the estimate with `--dry` first. Recorded files land in `evals/fixtures/sse/recorded-*.sse`; the
   smoke eval already replays them, so keep them small enough to commit (drop any over ~200 KB and say so).
2. **Dev-only replay page** (e.g. `/dev/chat-replay?fixture=…&speed=1`): feeds a fixture through the
   **real** client path — the same stream reader, store and `MessageList` — at the recorded timing
   (support `speed` 1× / 4× and a pause). Never shipped in production (guard it like the dev-auth
   toggle). Do not re-implement the renderer; if a seam is needed, export it from ChatEngine the way W4-3 did.
3. **Measurements** (a small helper the page can run, readable through the browser tools):
   - long tasks > 50 ms and total blocking time during the stream;
   - dropped frames / frame-time p95 while scrolling during the stream;
   - **scroll jumps**: `scrollTop` changes not caused by the user, and whether a reader who scrolled up
     is pulled back;
   - **layout shift** (CLS, via `PerformanceObserver('layout-shift')`) and the largest single shift,
     named by the element that moved.
4. **Baseline:** run each fixture at 1440 px and 375 px (plus a CPU-throttled run if the tooling allows).
   Record the numbers in the README's Baseline table. Confirm or reject each hypothesis above, with evidence.

### Acceptance
- Replaying the crew fixture shows the same final answer as `evals/fixtures` expects (smoke still green).
- Baseline table filled in; each hypothesis marked confirmed / rejected / partly, with the evidence.
- Spend reported (≤ $1).

---

## Session 2: Smooth streaming & steady scroll

**Branch** `fix/chat-smooth-stream` · **port 3012** · **cap $0** (replays only)

### Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-chat-feel/00-README.md and do Session 2 (plan id chat-smooth-stream, port 3012). Session 1 must be merged first; check. Set up the worktree exactly as the README says. Use TDD for logic. Do not make any paid API calls: work only from the replay bench. When done, open a PR per the README rules with before/after numbers from the bench.
```

### Tasks
1. **Scroll that doesn't fight you**
   - Follow the stream only while the reader is at the bottom. The moment they scroll up, stop following
     and show a small "Jump to latest" pill; tapping it (or reaching the bottom) resumes following.
   - At most one scroll adjustment per frame; no smooth-scroll animations stacked during streaming.
     Consider `overflow-anchor` and a single rAF-batched pin rather than `scrollIntoView` in an effect.
   - Test the follow/release/resume logic as a pure function or hook (vitest).
2. **Stop re-rendering the whole answer every frame**
   - Finished blocks (paragraphs, tables, sections) render once and stay memoised; only the live tail
     re-renders. Or split by the contract's H2 sections, since `parseAnswer` already knows them.
   - Throttle the reveal state to what the eye needs (words or ~30 fps), not every rAF.
   - Keep the contract parser and glossary off the hot path where they're pure (memoise by input).
3. **Nothing jumps**
   - Keep the crew/progress panel mounted when text starts; collapse it into a compact summary line
     above the answer instead of unmounting it.
   - Render the streaming answer with the same component and layout as the committed one, so the
     end-of-stream swap moves nothing (compare the element's box before and after).
   - The plain-markdown → `AnswerCard` switch must not reflow what's already on screen.
4. Re-run the bench at both widths. Target: no user-scroll yank, CLS ≈ 0 during the stream, no long
   task > 50 ms from the chat renderer, scrolling frame-time p95 under ~20 ms on desktop.

### Acceptance
- Before/after table from the bench for every fixture at 1440 and 375 px.
- New unit tests for the scroll logic and the memoised block rendering.
- `eval:smoke` green (the collapse contract is unchanged), plus typecheck/lint/test.

---

## Session 3: Real progress while it loads

**Branch** `fix/chat-progress` · **port 3013** · **cap $4**

### Kickoff prompt
```
Read /Users/liamblackshaw-brown/code/finava/docs/superpowers/plans/2026-09-chat-feel/00-README.md and do Session 3 (plan id chat-progress, port 3013). Session 2 must be merged first; check. Set up the worktree exactly as the README says. Use TDD for logic. Spend cap $4: tell me before any paid call. When done, open a PR per the README rules with screenshots of each loading state at 375 and 1440 px.
```

### Tasks
1. **Fast lane sends real progress.** `/api/chat` emits progress events as work actually happens (not
   on a timer):
   - which lane answered;
   - each data source starting, then done or not retrieved (prices, filings, news, insider, portfolio),
     per ticker;
   - "writing the answer".

   Add the event to the stream reader (`src/lib/chat/stream.ts`) without changing how answer text is
   collected (smoke eval guards this). TDD the event sequence in `route.test.ts`.
2. **One progress component for both lanes.** A calm checklist/status line that says what's happening
   ("Getting NVDA price and filings… 2 of 3 · Writing the answer"). The crew reuses it with its existing
   `crew_plan` / `agent_progress` / ETA events: per-analyst rows, an honest ETA that re-estimates, and
   "not retrieved" shown plainly, never as a spinner forever.
3. **Motion:** subtle, meaningful, and only where state changes (a row ticking to done). One gentle
   "in progress" cue at most. `prefers-reduced-motion` gets a static equivalent. No looping decorative
   animation. Replace the current thinking visuals only where the new component covers them.
4. **Layout:** the progress component reserves its space and collapses into the answer's summary line
   when text arrives (Session 2's no-jump rule). Check at both widths.
5. **Verification:**
   - Bench replays (free) for the crew fixture.
   - At most **3 live fast-lane questions** (≈ $0.02 each) and **1 live full analysis** (≈ $0.25–0.50).
   - Optionally `npm run eval:live -- --yes --only verdict-then-escalate` (≈ $0.25) to confirm lanes and
     timings still pass. Report the total.

### Acceptance
- Progress events covered by tests; the stream reader ignores unknown events safely.
- Screenshots of every loading state (fast lane, Discover, crew, a source not retrieved) at both widths.
- The bench shows no regression from Session 2's numbers. Spend reported (≤ $4).

---

## Baseline (Session 1, 18 Sep 2026, [PR #21](https://github.com/LBB2005/finava/pull/21))

| Fixture | Width | Long tasks > 50 ms | TBT | Frame p95 while scrolling | Scroll jumps | CLS (largest shift) |
|---|---|---|---|---|---|---|
| fast lane | 1440 | 1 (max 90 ms) | 40 ms | 33.3 ms (10 dropped) | n/a (answer fits on screen) | 0.000 |
| fast lane | 375 | 1 (max 87 ms) | 37 ms | 16.8 ms (6 dropped) | 64 yanks (779 px); reader held ≤ 15 px from the bottom | 0.000 |
| crew | 1440 | 2 (max 102 ms) | 57 ms | 66.6 ms (96 dropped) | 53 yanks (479 px); held ≤ 51 px | 0.029 (CrewProgress ±640 px) |
| crew | 375 | 2 (max 104 ms) | 58 ms | 50 ms (75 dropped) | 50 yanks (632 px); held ≤ 33 px | **0.182** (CrewProgress ±447 px) |
| fast follow-up | 1440 | 4 (max 128 ms) | 88 ms | 50 ms (63 dropped) | 47 yanks (388 px), held ≤ 50 px; ran 183 px past a still reader | 0.000 |
| fast follow-up | 375 | 3 (max 130 ms) | 83 ms | 50 ms (62 dropped) | 45 yanks (484 px), held ≤ 55 px; ran 281 px past | 0.000 |
| fast lane · 4× CPU | 1440 | 27 (max 409 ms) | 2,041 ms | 166.6 ms (168 dropped) | reader got 168 px up (barely overflows) | 0.000 |
| fast lane · 4× CPU | 375 | 32 (max 391 ms) | 1,891 ms | 149.9 ms (143 dropped) | 13 yanks (860 px), held ≤ 235 px | 0.000 |
| fast follow-up · 4× CPU | 1440 | 22 (max 600 ms) | 2,820 ms | 133.2 ms (165 dropped) | 2 yanks (35 px); ran 183 px past | 0.000 |
| fast follow-up · 4× CPU | 375 | 23 (max 564 ms) | 2,731 ms | 116.7 ms (160 dropped) | 1 yank (60 px); ran 230 px past | 0.000 |
| crew · 4× CPU | 1440 | 325 (max 482 ms) | 23,583 ms | 300 ms (1,534 dropped) | 54 yanks (377 px); held ≤ 10 px | 0.029 |
| crew · 4× CPU | 375 | 336 (max 478 ms) | 25,347 ms | 300.1 ms (1,531 dropped) | 57 yanks (436 px), held ≤ 25 px; ran 2,327 px past | 0.182 |

**Fixtures** were recorded 18 Sep with `eval:live --record`, for about $0.17:
- **fast lane** is `recorded-chat-verdict-then-escalate-1`: Auto's answer to "is it too late to buy nvidia stock i got 3k saved up". It's 1,193 chars; the router takes 2.0 s and first text lands at 3.85 s.
- **fast follow-up** is `…-4`: "summarize what you just told me in 3 bullets" (681 chars), under the whole conversation.
- **crew** is `recorded-agent-verdict-then-escalate-3`: Run full analysis on the same question. It's 8,267 chars; first text at 61 s, done at 109 s.

In all 12 runs the saved answer is exactly the fixture's expected text.

**How to re-run** (from the worktree, with its dev server on 3011):

```
npm run bench:replay -- --fixture recorded-chat-verdict-then-escalate-1,recorded-chat-verdict-then-escalate-4,recorded-agent-verdict-then-escalate-3 --width 1440,375 --cpu 1,4
```

It uses headless Chrome over CDP at the recorded pace, with a scripted trackpad reader. See `evals/README.md` → Replay bench.

**How to read the columns.**
- *Frame p95 while scrolling* covers the reader's ~3 s episode: catch up to the bottom, scroll up 300 px, read, scroll back down.
- A *yank* is the page scrolling toward the bottom while the reader is above it.
- *Ran N px past a still reader* means the page stopped following.
- Frame p95 over the whole text stream, for comparison: fast 16.8 ms; crew and fast follow-up 50 ms; 150–300 ms at 4× CPU.

**Caveats.**
- It's the dev build (React dev mode), so compare runs against each other on one machine.
- Follow loss depends on timing: the crew at 375 left a still reader behind by 99 px in this run and by 1,567 px in an identical earlier run.

### Hypotheses: verdicts (Session 1)

- **Scroll jumps: confirmed.**
  - Every run that could scroll pulled a reader who scrolled up in small steps back 45–64 times in about a second. They tried to go 300 px up and never got more than 15–55 px from the bottom.
  - With a mouse wheel (three 100 px notches) the reader was yanked back in 2 of 3 runs. The one time it escaped, the reveal was momentarily idle: the pin only fires while `revealed` changes.
  - Also new: the same 120 px rule **stops following** when one render adds more than 120 px. That covers the user's own bubble plus the typing indicator on a follow-up, and big sections of the crew answer on a phone.
- **Stutter: confirmed, and broader than stated.**
  - During the crew's text phase the main thread is 96–100% busy for all 48 s (1× CPU, both widths).
  - Markdown parse + markdown→React account for 65% of that and the sidebar for 9%. The contract parser (≈1%), glossary (0.4%) and `useSmoothStream` (≈0.1%) are not the problem.
  - It re-renders the **whole transcript**, not just the answer. `Message` and `AnswerCard` aren't memoized and `MessageList` re-renders every reveal frame. So the 681-char follow-up under a long chat costs 3.2 s of markdown work, against 0.9 s for the 1,193-char first answer.
- **Content jumps: partly confirmed.**
  - *Crew panel unmounts at the first token:* **confirmed**, as a scroll jump, not CLS. At first text the list gets 106 px (1440) / 210 px (375) shorter and the view jumps by as much.
  - *Markdown → `AnswerCard` switch:* **rejected.** There's no shift in any run; answers open with `## Answer`, so the switch happens on line one.
  - *End-of-stream swap:* **partly.** There's no reflow of streamed text (end-phase CLS is 0 everywhere). But the committed message adds 99–256 px of footer, the view scrolls to it, and the avatar flips from "L" to "F".
  - *`TypingIndicator` label swaps:* **rejected**; ≤ 0.0004 CLS.
  - ***The crew's real CLS source (not listed above):*** at 53.4 s the CEO's 6,836-char **draft report arrives as `ceo_thinking`**, and `CrewProgress` shows it as its header. The panel swells by 447–640 px of raw markdown for 6 s, then collapses at `ceo_compiling`: CLS 0.18 on a phone.
- **No real progress in the default lane: confirmed.**
  - *Fast lane:* it sends `meta`, then text, which gives 3.85 s of "Thinking it through".
  - *Crew:* the analysts finish at 9.7 s, then nothing new arrives until 53.4 s. That's 44 s of "Compiling all reports… 4 of 4 done".
  - *Discover:* nothing for 69 s, then everything at 109 s in one chunk.

**Found, not fixed** (details in PR #21):
- the draft report in the progress panel (`ceo.ts:674` → `CrewProgress` `note`);
- the sidebar `ConversationList` re-rendering and remounting every row on every SSE chunk, which also happens on phones (it's only CSS-hidden);
- the streaming avatar still showing "L" (pre-rebrand);
- a fast follow-up that lost its ticker context ("No ticker data pulled yet");
- Discover sending nothing for 69 s.

## Not in scope (noted for later)
- Crew speed itself (full-analysis p90 213 s, deep research over the 300 s cap): these sessions make the
  wait honest and smooth, not shorter.
- The early-panel request hangs, fund data, positions typed in chat, uncited numbers
  (see the Panel Re-run readout).
- Button/press feedback: not selected as a problem this round.
