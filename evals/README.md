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
