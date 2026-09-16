/**
 * Writes the synthetic SSE fixtures the smoke eval replays.
 *
 * The events use the exact wire format of /api/agent and /api/chat (the same
 * `data: {json}\n` lines, the same event types, the same delta/replace rules as
 * ceo.ts, skeptic.ts and discovery.ts emit). The text is written for the eval, not
 * captured from a run, because recording costs money. `npm run eval:live -- --record`
 * captures real ones into evals/fixtures/sse/recorded-*.sse, and the smoke eval
 * replays those too.
 *
 * Each fixture has a `.expected.md`: the answer a user should end up with,
 * written from the source text here, NOT from running the client reducer over the
 * events. A reducer that replaces instead of appending cannot agree with it.
 *
 *   npx tsx evals/fixtures/synthetic.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(__dirname, "sse");
mkdirSync(DIR, { recursive: true });

/** Split text into deltas the way a model streams: uneven, mid-word, mid-line, mid-heading. */
function deltas(text: string, seed: number): string[] {
  const out: string[] = [];
  let s = seed;
  let i = 0;
  while (i < text.length) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const n = 1 + (s % 23);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

const line = (event: unknown) => (typeof event === "string" ? `data: ${event}\n` : `data: ${JSON.stringify(event)}\n`);

function write(name: string, events: unknown[], expected: string) {
  // A blank line between events, as the routes write them.
  writeFileSync(path.join(DIR, `${name}.sse`), events.map((e) => `${line(e)}\n`).join(""));
  writeFileSync(path.join(DIR, `${name}.expected.md`), expected);
}

const DISCLAIMER = "\n\n*This is research, not personalized investment advice. Past performance does not guarantee future results.*";

const CREW_REPORT = `## Answer
NVDA still screens as a high-quality business, but at 38× forward earnings — about 22% above its 5-year median — most of the data-centre growth already looks priced in. The case for buying now rests on estimates continuing to rise.

## Key numbers
| Metric | Value | Source | As of |
|---|---|---|---|
| Price | $182.40 | Polygon | 2026-09-11 close |
| Forward P/E | 38.1× | Facts layer | 2026-09-11 |
| Data-centre revenue (FY2026) | $115.2B | SEC 10-K | 2026-02-25 |
| Options implied move | Unavailable | — | — |

## Bull case
- Data-centre revenue grew 3 years in a row.
- Gross margin held above 70% through the Blackwell ramp.

## Bear case
- Valuation leaves little room for a guidance miss.
- Top-4 hyperscalers are ~46% of revenue.

## What would change the view
- A capex cut from two or more hyperscalers.

## Confidence & gaps
Medium — no options data for this ticker.

## Details
### Valuation agent
DCF fair value range $140–$195 (base $168) — the market price sits near the top of the range.

### Insider activity
Form 4: 14 sales, 0 open-market buys in the last 90 days (≈ $412M, mostly 10b5-1 plans).`;

const TRUNC_NOTE = "\n\n_⚠️ This response reached the length limit and may be cut off._";

// 1. Crew run, revision streamed as deltas (the path that collapsed in the Sep-14 panel).
{
  const report = CREW_REPORT + DISCLAIMER;
  write(
    "agent-crew-streamed-revision",
    [
      { type: "crew_plan", agents: ["valuation", "insider", "fundamentals"], etaSeconds: 150 },
      { type: "agent_start", agent: "run_dcf_agent" },
      { type: "agent_progress", agent: "valuation", status: "running" },
      { type: "agent_complete", agent: "run_dcf_agent", result: "DCF range $140–$195." },
      { type: "agent_progress", agent: "valuation", status: "done", ms: 41000 },
      { type: "ceo_compiling" },
      { type: "skeptic_start" },
      { type: "skeptic_complete", critique: "The draft cited a P/E without a source." },
      ...deltas(report, 7).map((content) => ({ type: "final_response", content })),
      { type: "final_response", content: TRUNC_NOTE },
      { type: "followups", questions: ["What would a capex cut do to the numbers?", "Compare with AMD"] },
      { type: "done" },
    ],
    report + TRUNC_NOTE
  );
}

// 2. Crew run, revision not streamed: one full-report event with replace.
{
  const report = CREW_REPORT.replace("38.1×", "38.0×") + DISCLAIMER;
  write(
    "agent-crew-replace",
    [
      { type: "crew_plan", agents: ["valuation"], etaSeconds: 90 },
      { type: "agent_start", agent: "run_dcf_agent" },
      { type: "agent_complete", agent: "run_dcf_agent", result: "ok" },
      { type: "ceo_compiling" },
      { type: "skeptic_status", status: "skipped", reason: "Time budget reached before review." },
      { type: "final_response", content: report, replace: true },
      { type: "done" },
    ],
    report
  );
}

// 3. Deep research: a draft streams, a replace event swaps in the revision, then a note is appended.
{
  const draft = "## Answer\nAAPL looks expensive versus peers on ";
  const revised = `## Answer
AAPL trades at 31× forward earnings against a large-cap tech median of 27×; services growth (≈14% y/y) carries the premium.

## Key numbers
| Metric | Value | Source | As of |
|---|---|---|---|
| Forward P/E | 31.2× | Facts layer | 2026-09-11 |
| Services revenue growth | 14.1% | SEC 10-Q | 2026-08-01 |

## Confidence & gaps
Low — no segment margin data for Services.`;
  const costNote = "\n\n_This run reached its cost cap, so some agents did not finish._";
  write(
    "agent-deep-replace-then-delta",
    [
      { type: "crew_plan", agents: ["valuation", "fundamentals", "news"], etaSeconds: 300, deep: true },
      ...deltas(draft, 3).map((content) => ({ type: "final_response", content })),
      { type: "budget_warning", remainingSeconds: 20 },
      { type: "final_response", content: revised + DISCLAIMER, replace: true },
      { type: "final_response", content: costNote },
      { type: "done" },
    ],
    revised + DISCLAIMER + costNote
  );
}

// 4. Discover quick scout: framing deltas, then the shortlist event.
{
  const framing = "I read this as low-valuation energy names with positive free cash flow — here are the closest fits.";
  const picks = [
    { ticker: "XOM", name: "Exxon Mobil", sector: "Energy", score: 81, grade: "A", fitRank: 1, f: {}, reason: "Cheapest FCF yield in the group (≈ 8.9%)." },
    { ticker: "EOG", name: "EOG Resources", sector: "Energy", score: 77, grade: "B+", fitRank: 2, f: {}, reason: "Net cash balance sheet and a variable dividend." },
    { ticker: "PSX", name: "Phillips 66", sector: "Energy", score: 70, grade: "B", fitRank: 3, f: {}, reason: "Refining margins recovering; trades below book." },
  ];
  write(
    "agent-discover-scout",
    [
      ...deltas(framing, 11).map((content) => ({ type: "final_response", content })),
      { type: "scout_complete", tier: "quick", query: "cheap energy stocks", interpretation: framing, picks, layout: "ranked" },
      { type: "done" },
    ],
    framing
  );
}

// 5. Fast lane: contract answer as text deltas, then followups.
{
  const answer = `## Answer
At $182.40 NVDA isn't obviously too late, but the price already assumes estimates keep rising — a miss would hurt more than a beat helps.

## Key numbers
| Metric | Value | Source | As of |
|---|---|---|---|
| Price | $182.40 | Polygon | 2026-09-11 close |
| 52-week high | $195.10 | Polygon | 2026-09-11 |
| Short interest | Unavailable | — | — |

## Bull case
- Estimates have risen for 6 straight quarters.

## Bear case
- 6.5% below the 52-week high with a 38× forward P/E.

## What would change the view
- A guidance cut at the November print.

## Confidence & gaps
Medium — no short-interest data.`;
  write(
    "chat-fast-nvda",
    [
      ...deltas(answer, 5).map((text) => ({ text })),
      { followups: ["Run full analysis", "What about AMD?"] },
      "[DONE]",
    ],
    answer
  );
}

// 6. Fast lane, conceptual question: the contract allows `## Answer` alone.
{
  const answer = "## Answer\nAn ETF is a basket of many stocks you buy in one trade — owning a slice of hundreds of companies instead of one. Fees are shown as an expense ratio (e.g. 0.03% a year).";
  write("chat-conceptual-etf", [...deltas(answer, 13).map((text) => ({ text })), "[DONE]"], answer);
}

console.log(`wrote fixtures to ${DIR}`);
