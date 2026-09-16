/**
 * What does one answer actually cost?
 *
 * Nobody had measured it. Every paid plan capped a run at 300 credits (~$0.30),
 * including the $100/mo Quant tier, and the pricing table was placeholder numbers
 * carried since the first commit. This script drives the real lanes against a
 * local dev server, reads the per-run cost the server itself reports, and prints
 * the p50 / p90 / max per lane that `PER_RUN_CAP` and the plan allowances in
 * `src/lib/plans.ts` are then set from.
 *
 * ⚠️ IT SPENDS REAL MONEY. The Sep 2026 run cost $4.33 for the full 30-prompt
 * set (fast is pennies; deep research is half of it). Run `--dry` first — it
 * prints the plan and the estimate without calling anything. Budget ~60 min:
 * runs are serial and a deep run takes 5+ minutes.
 *
 * How it works: the server appends one JSONL row per run to `$RUN_COST_LOG`
 * (see `logRunCost` in src/lib/usageRunCost.ts). Prompts are driven strictly
 * SERIALLY, so every row that appears while a prompt is in flight belongs to it —
 * which is also what makes a multi-request lane like Discover (scout, then waves)
 * add up to one user-visible run instead of three unrelated ones.
 *
 * Usage:
 *   # 1. start the dev server with the cost sidecar enabled
 *   RUN_COST_LOG=/tmp/run-cost.jsonl npm run dev -- --port 3014
 *
 *   # 2. see the plan and the estimated spend, call nothing
 *   RUN_COST_LOG=/tmp/run-cost.jsonl npx tsx --env-file=.env --env-file=.env.local \
 *     scripts/measure-run-cost.ts --dry
 *
 *   # 3. run it for real
 *   RUN_COST_LOG=/tmp/run-cost.jsonl npx tsx --env-file=.env --env-file=.env.local \
 *     scripts/measure-run-cost.ts --out docs/pricing/run-cost-2026-09.json
 *
 * Flags: --lanes fast,full,discover,deep · --base <url> · --out <file> · --dry
 *
 * Auth is the dev bypass (`Authorization: Bearer dev-bypass`), which resolves to
 * `dev-user` — an uncapped account, deliberately: a measurement that trips a cap
 * measures the cap, not the run.
 */
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";

// ── Lanes and prompts ────────────────────────────────────────────────────────
type Lane = "fast" | "full" | "discover" | "deep";

const LANES: Lane[] = ["fast", "full", "discover", "deep"];

/**
 * The prompt set, drawn from the families in the 13–14 Sep beta readout (the
 * same ones `scripts/test-routing.ts` scores the router against): the "is X a
 * buy" questions testers actually asked, the brevity follow-ups, the explicit
 * "full analysis" requests, and the idea-generation prompts.
 */
const PROMPTS: Record<Lane, string[]> = {
  fast: [
    "is it too late to buy NVDA?",
    "is AMD a buy right now?",
    "should I worry about TSLA's margins?",
    "thoughts on PLTR at this price",
    "what's going on with COIN today",
    "is SOFI overvalued",
    "analyze MSFT",
    "what's a P/E ratio?",
    "how risky is my portfolio?",
    "is this a buy?",
  ],
  full: [
    "full analysis of NVDA",
    "give me a deep dive on TSLA",
    "run the crew on MSFT",
    "research report on SOFI please",
    "comprehensive analysis of GOOGL",
    "full analysis of AMD",
    "deep dive on PLTR",
    "complete research report on AAPL",
    "full analysis of COIN",
    "comprehensive analysis of META",
  ],
  discover: [
    "find cheap energy stocks",
    "best AI plays right now",
    "which stocks have low debt and high growth?",
    "ideas for dividend income",
    "undervalued semiconductor names",
  ],
  deep: [
    "deep research on NVDA's competitive position",
    "deep research on TSLA's margin trajectory",
    "deep research on the AI capex cycle and who benefits",
    "deep research on SOFI's path to profitability",
    "deep research on AMD vs NVDA in data centre",
  ],
};

/** A portfolio for the prompts that reference holdings, so those runs do real work. */
const PORTFOLIO_CONTEXT = "NVDA 10 shares, AAPL 5 shares, MSFT 8 shares";

/**
 * $/run per lane for the pre-flight estimate in `--dry`: the p90s measured in
 * Sep 2026 (docs/pricing/run-cost-2026-09.md), so the estimate errs high.
 */
const ESTIMATE_USD: Record<Lane, number> = { fast: 0.0064, full: 0.2231, discover: 0.0908, deep: 0.5213 };

/**
 * Client-side ceiling per run. Deliberately well past the route's 300 s
 * `maxDuration`: the dev server doesn't enforce that limit, and the Sep 2026
 * measurement found deep-research runs taking 310–335 s. A client timeout below
 * the real run length doesn't stop the run — it just loses its cost row.
 */
const REQUEST_TIMEOUT_MS = 480_000;

/** How long to wait for the server's cost row to land after the stream closes. */
const COST_ROW_WAIT_MS = 8_000;

/**
 * After a client-side failure the server is usually still running the crew.
 * Wait this long for its row, so it's counted against THIS prompt instead of
 * landing in the next prompt's window and being attributed to the wrong run.
 */
const ORPHAN_ROW_WAIT_MS = 180_000;

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const DRY = process.argv.includes("--dry");
const BASE = arg("base") ?? "http://localhost:3014";
const OUT = arg("out");
const SELECTED: Lane[] = (arg("lanes")?.split(",") as Lane[] | undefined)?.filter((l) =>
  LANES.includes(l)
) ?? LANES;

// ── The cost sidecar ─────────────────────────────────────────────────────────
interface CostRow {
  runId: string;
  lane: string;
  credits: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  byModel: Record<string, number>;
  byAgent: Record<string, number>;
}

const COST_LOG = process.env.RUN_COST_LOG;

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0; // not created until the first run writes to it
  }
}

/** Every JSONL row appended after byte offset `from`. */
async function rowsSince(path: string, from: number): Promise<CostRow[]> {
  let text: string;
  try {
    text = (await readFile(path, "utf8")).slice(from);
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CostRow];
      } catch {
        return [];
      }
    });
}

/**
 * Wait for the run's cost row(s). `logRunCost` fires as the stream closes and the
 * file append is not awaited, so the client can see the last SSE byte a beat
 * before the row lands. Polls, then gives up rather than hanging the batch.
 */
async function awaitRows(
  path: string,
  from: number,
  waitMs: number = COST_ROW_WAIT_MS
): Promise<CostRow[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const rows = await rowsSince(path, from);
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) return [];
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ── Driving a lane ───────────────────────────────────────────────────────────
function bodyFor(lane: Lane, prompt: string): { url: string; body: object } {
  if (lane === "fast") {
    return {
      url: "/api/chat",
      body: {
        messages: [{ role: "user", content: prompt }],
        portfolioContext: PORTFOLIO_CONTEXT,
      },
    };
  }
  if (lane === "discover") {
    return {
      url: "/api/agent",
      body: { discover: true, tier: "quick", userPrompt: prompt, portfolioContext: "" },
    };
  }
  return {
    url: "/api/agent",
    body: {
      userPrompt: prompt,
      portfolioContext: PORTFOLIO_CONTEXT,
      deepResearch: lane === "deep",
      holdings: [{ ticker: "NVDA", shares: 10 }],
      ...(lane === "deep" ? { tier: "deep" } : {}),
    },
  };
}

interface RunResult {
  lane: Lane;
  prompt: string;
  credits: number;
  usd: number;
  durationMs: number;
  calls: number;
  rows: number;
  /** Set when the run failed or the server reported no cost — excluded from stats. */
  problem?: string;
}

/** POST and drain the SSE stream to completion. Returns the wall-clock duration. */
async function drive(lane: Lane, prompt: string): Promise<{ ms: number; error?: string }> {
  const { url, body } = bodyFor(lane, prompt);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer dev-bypass" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      return { ms: Date.now() - startedAt, error: `HTTP ${res.status}` };
    }
    // Read to the end — the run isn't over (and hasn't been costed) until it is.
    const reader = res.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    return { ms: Date.now() - startedAt };
  } catch (e) {
    return { ms: Date.now() - startedAt, error: e instanceof Error ? e.message : String(e) };
  }
}

async function runOne(lane: Lane, prompt: string): Promise<RunResult> {
  const from = await fileSize(COST_LOG!);
  const { ms, error } = await drive(lane, prompt);
  // A client-side failure (timeout, dropped connection) doesn't stop the run on
  // the server. Wait for its row either way so it can't leak into the next
  // prompt's window; it is still excluded from the stats below.
  const rows = await awaitRows(COST_LOG!, from, error ? ORPHAN_ROW_WAIT_MS : COST_ROW_WAIT_MS);

  const credits = rows.reduce((n, r) => n + (r.credits ?? 0), 0);
  const usd = rows.reduce((n, r) => n + (r.usd ?? 0), 0);
  const problem =
    error ?? (rows.length === 0 ? "no cost row — was RUN_COST_LOG set on the server?" : undefined);

  return {
    lane,
    prompt,
    credits: Math.round(credits * 100) / 100,
    usd: Math.round(usd * 10_000) / 10_000,
    durationMs: ms,
    calls: rows.reduce((n, r) => n + (r.calls ?? 0), 0),
    rows: rows.length,
    problem,
  };
}

// ── Stats ────────────────────────────────────────────────────────────────────
/** Nearest-rank percentile: with 10 samples, p90 is the 9th — no interpolation. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

interface LaneStats {
  lane: Lane;
  runs: number;
  failed: number;
  creditsP50: number;
  creditsP90: number;
  creditsMax: number;
  usdP50: number;
  usdP90: number;
  usdMax: number;
  secP50: number;
  secP90: number;
  /** The cap this lane should carry: ~1.5x the measured p90, rounded up to 50. */
  suggestedCap: number;
}

function summarize(lane: Lane, results: RunResult[]): LaneStats {
  const ok = results.filter((r) => !r.problem);
  const credits = ok.map((r) => r.credits);
  const usd = ok.map((r) => r.usd);
  const secs = ok.map((r) => r.durationMs / 1000);
  const p90 = percentile(credits, 90);
  return {
    lane,
    runs: ok.length,
    failed: results.length - ok.length,
    creditsP50: percentile(credits, 50),
    creditsP90: p90,
    creditsMax: Math.max(0, ...credits),
    usdP50: percentile(usd, 50),
    usdP90: percentile(usd, 90),
    usdMax: Math.max(0, ...usd),
    secP50: Math.round(percentile(secs, 50)),
    secP90: Math.round(percentile(secs, 90)),
    suggestedCap: Math.ceil((p90 * 1.5) / 50) * 50,
  };
}

const money = (n: number) => `$${n.toFixed(4)}`;

function markdownTable(stats: LaneStats[]): string {
  const head =
    "| Lane | Runs | p50 credits | p90 credits | max | p50 $ | p90 $ | p50 s | p90 s | suggested cap |\n" +
    "|---|---|---|---|---|---|---|---|---|---|";
  const rows = stats.map(
    (s) =>
      `| ${s.lane} | ${s.runs}${s.failed ? ` (+${s.failed} failed)` : ""} | ${s.creditsP50} | ${s.creditsP90} | ${s.creditsMax} | ${money(s.usdP50)} | ${money(s.usdP90)} | ${s.secP50} | ${s.secP90} | ${s.suggestedCap} |`
  );
  return [head, ...rows].join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const planned = SELECTED.map((l) => ({ lane: l, prompts: PROMPTS[l] }));
  const estimate = planned.reduce((n, p) => n + p.prompts.length * ESTIMATE_USD[p.lane], 0);

  console.log(`\nMeasuring run cost against ${BASE}`);
  for (const { lane, prompts } of planned) {
    console.log(`  ${lane.padEnd(9)} ${prompts.length} prompts  ~${money(prompts.length * ESTIMATE_USD[lane])}`);
  }
  console.log(`  ${"TOTAL".padEnd(9)} ${planned.reduce((n, p) => n + p.prompts.length, 0)} prompts  ~${money(estimate)} estimated spend\n`);

  if (DRY) {
    console.log("--dry: nothing was called.\n");
    return;
  }
  if (!COST_LOG) {
    console.error(
      "RUN_COST_LOG is not set. Start the dev server AND this script with the same path, e.g.\n" +
        "  RUN_COST_LOG=/tmp/run-cost.jsonl npm run dev -- --port 3014\n"
    );
    process.exit(1);
  }

  const results: RunResult[] = [];
  for (const { lane, prompts } of planned) {
    for (const [i, prompt] of prompts.entries()) {
      process.stdout.write(`[${lane} ${i + 1}/${prompts.length}] ${prompt.slice(0, 48)}… `);
      const r = await runOne(lane, prompt);
      results.push(r);
      console.log(
        r.problem
          ? `FAILED (${r.problem})`
          : `${r.credits} cr ${money(r.usd)} in ${(r.durationMs / 1000).toFixed(1)}s (${r.calls} calls)`
      );
    }
  }

  const stats = SELECTED.map((l) => summarize(l, results.filter((r) => r.lane === l)));
  const total = results.reduce((n, r) => n + r.usd, 0);

  console.log(`\n${markdownTable(stats)}\n`);
  console.log(`Actual spend this batch: ${money(total)} (estimated ${money(estimate)})\n`);

  if (OUT) {
    await writeFile(OUT, `${JSON.stringify({ measuredAt: new Date().toISOString(), base: BASE, stats, results }, null, 2)}\n`);
    console.log(`Wrote ${OUT}`);
    await appendFile(OUT.replace(/\.json$/, ".md"), `\n<!-- measured ${new Date().toISOString()} -->\n${markdownTable(stats)}\n`);
  }
}

// Importable for unit tests (percentile/summarize) without driving any traffic.
if (process.argv[1]?.endsWith("measure-run-cost.ts")) {
  void main();
}
