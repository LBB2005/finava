# evals

A repeatable eval for the chat product. The Sep-14 panel's harness was never saved in the repo. Without
this one we can't show the beta fixes worked, or catch a regression like the `ChatEngine.tsx:233`
collapse coming back.

| Command | Spend | What it does |
|---|---|---|
| `npm run eval:smoke` | none, runs in CI | Replays SSE fixtures through the real client stream code |
| `npm run eval:live -- --dry` / `--yes` | ≈ $1.20 | 20 fixed prompts across every lane against a running app |
| `npm run eval:panel -- --dry` / `--yes` | ≈ $30 (Opus personas) | The 50-persona panel: 40 API personas from here, 10 in a browser |
| `npx tsx evals/report/build.ts` | none | Readout vs the Sep-14 baseline, plus the launch gate |
| `npm run bench:replay -- --fixture …` | none | How chat *feels* while it answers: replays a recorded turn through the real UI and measures jank, scroll jumps, layout shift |

The paid commands print an estimate and exit unless you pass `--yes`. **Don't run them without Liam's
go-ahead on the spend.**

## Smoke (`evals/smoke`)

Every test calls the functions ChatEngine uses (`src/lib/chat/requests.ts`, `src/lib/chat/stream.ts`,
the chat store, `RunRegistry`, `stoppedMessage`, stored-message round trip). None of them re-implements
the client:

- **stream**: each fixture, cut at 5 different byte boundaries, saves exactly its `.expected.md`, and
  the rendered text equals the saved text. There's also a source guard that fails if ChatEngine assigns
  `x = event.content` anywhere (how `:233` was written).
- **switches**: the 13 cross-lane switches from the readout, over 8 conversations. Each follow-up's
  payload carries the previous answer in full.
- **contract-and-stop**: saved answers parse into the answer contract (every partial frame parses
  too). Stop keeps the partial text, marks it stopped, survives a reload, and doesn't disturb the next run.
- **lib/harness.test.ts**: the harness's own maths (percentiles, NPS, collapse stages, cost, readout
  comparison, launch gate).

`evals/lib/conversation.ts` copies ChatEngine's control flow (which lane runs, the clarify continuation,
what gets committed), because ChatEngine is a React component. Its `final_response` handling is checked
against ChatEngine's source.

### Fixtures

`fixtures/sse/*.sse` use the exact wire format. The six synthetic ones come from `fixtures/synthetic.ts`.
They are test data, never shown to a user. `eval:live --record` adds real streams as `recorded-*.sse`,
and the smoke eval replays those too.

## Live (`evals/live`)

```bash
npm run dev -- --port 3013          # or use the worktree's launch.json entry
npm run eval:live -- --dry
npm run eval:live -- --yes --only verdict-then-escalate   # one scenario
npm run eval:live -- --yes
```

For each turn it records the lane, time to first text, total time, collapse at every stage (the wire
answer vs rendered vs saved vs reloaded through `/api/conversations`), contract shape, number-check
mismatches (from W4-1's `number_check` events: `Unavailable` until those exist), routing misses and
errors. Output goes to `evals/results/live-*/results.json` + `summary.md`. The results folder is gitignored.

`--record` also writes a `.timing.json` sidecar per fixture: when each network chunk arrived, Auto's
router call, and the conversation so far. The replay bench below uses it; the smoke eval ignores it.

## Replay bench (`/dev/chat-replay`, `evals/bench`)

Free and repeatable: no model calls. The dev-only page `/dev/chat-replay` (404 in production) mounts the
real `ChatContainer` and swaps only the network. A fetch interceptor (`src/lib/chatBench/replayFetch.ts`)
plays one recorded turn to the real `ChatEngine` at the recorded pace (1× / 4×, pausable). It answers
Auto's router with the recorded decision, swallows conversation writes, and refuses any lane request it
has no recording for, so nothing reaches a paid route. The page measures itself
(`src/app/dev/chat-replay/recorder.ts`, maths in `src/lib/chatBench/metrics.ts`):

- long tasks > 50 ms, Total Blocking Time, long-animation-frame script attribution;
- frame times while the text streams, and while a scripted reader scrolls;
- scroll: a reader catches up to the bottom, then scrolls up 300 px (trackpad: 5 px a frame; wheel: 100 px
  notches). **Yanks** = the page scrolling back toward the bottom while they read above. **Left behind** =
  how far the answer ran past a reader who sat still (the page stopped following);
- layout shift (CLS and the element that moved), split into waiting / first text / streaming / end-of-stream
  swap, plus how the list's height changed at first text and at the end.

```bash
# dev server on 3011 (the worktree's launch.json entry), then:
npm run bench:replay -- --fixture recorded-chat-verdict-then-escalate-1,recorded-agent-verdict-then-escalate-3 \
  --width 1440,375 --cpu 1,4
```

The runner drives headless Chrome over the DevTools protocol (installed Chrome, `CHROME_PATH` to override):
fixed viewport, optional CPU throttling, a fresh page per run, results written after every run to
`evals/results/` (gitignored). `--reader wheel|none`, `--speed 4`, `--profile <prefix>` (a `.cpuprofile`
per run plus the top self-time functions, diagnosis only), `--shots <dir>` (chat-column screenshots).

By hand: open `/dev/chat-replay?fixture=<name>` with dev auth on, or drive `window.__chatBench`
(`run({ fixture, speed, reader })`, `status()`, `pause()`, `play()`, `last`). The page needs a visible
tab: a hidden tab gets no animation frames, and the chat's own text reveal stops too.

Caveats: it's the dev build (React dev mode, StrictMode), so absolute costs run higher than production.
Compare runs against each other on the same machine, not against production numbers. Long-animation-frame
attribution shows chunk delivery as `TimerHandler:setTimeout` (the replay clock); in production that work
sits under the fetch stream read.

## Panel (`evals/panel`)

Same 50 identities, grid cells (AI expertise × stock knowledge × 2) and opening questions as Sep-14, from
`personas.json`. Each API persona is a Claude call per turn that reacts and decides (send, Run full
analysis, done, quit), with a patience limit that presses Stop, plus a final survey on the Sep-14 score
keys. Then comes a 25-claim fact-check (Opus + web search) and theme coding. Browser personas: see
`panel/BROWSER.md`.

Before the full panel, do a 2-persona run: `npm run eval:panel -- --yes --only 1,31`.

## Readout

```bash
npx tsx evals/report/build.ts --panel evals/results/panel-… --live evals/results/live-…
```

It writes `readout.json`/`readout.md`: a comparison with `baseline/2026-09-14.json` (NPS −100, 0/50 pay,
44/50 collapse, crew median 253 s, 26 quit), the launch gate from `docs/launch/launch-gate.md`, and the
caveats. The caveats always ship with the readout.
