/**
 * Verification harness for routing — BOTH kinds.
 *
 * 1. Auto-mode intent routing (W2-1): scores the real router prompt against a
 *    labelled set, including every prompt from the 13-14 Sep beta readout that
 *    was misrouted to the 15-agent crew. Run it on its own with:
 *      npx tsx --env-file=.env --env-file=.env.local scripts/test-routing.ts --intents
 * 2. OpenRouter per-agent model routing (below).
 *
 * Run it twice to exercise the kill-switch:
 *   LLM_ROUTING=on  npx tsx scripts/test-routing.ts    # per-agent routing
 *   LLM_ROUTING=off npx tsx scripts/test-routing.ts    # everything back to Sonnet/Haiku
 *
 * It hits one Tier-A agent (technical → Gemini Flash-Lite), one Tier-B agent
 * (graham → Gemini Flash), and the dcf agent (Sonnet, reduced thinking) for AAPL,
 * prints the model each is routed to + a snippet of output, and confirms the
 * technical data-quality guard still fires when a ticker has no data.
 *
 * Requires OPENROUTER_API_KEY + FINNHUB_API_KEY in .env.local.
 */
// Env MUST come from node's --env-file flags, not a dotenv.config() call here:
// the app imports below are hoisted above any statement in this file, and
// firebase-admin validates its service-account env at module load. Run with:
//   npx tsx --env-file=.env --env-file=.env.local scripts/test-routing.ts
// (.env carries the Firebase creds, .env.local the API keys.)

import { AGENT_MODELS, LLM_ROUTING_ON, generate, type AgentKey } from "@/lib/llm";
import { ROUTER_SYSTEM_PROMPT, resolveIntent, type Intent } from "@/lib/chat/intent";
import { promptClockLine } from "@/lib/promptClock";
import type { PageContext } from "@/lib/pageContext";
import { runTechnicalAgent } from "@/agents/sub-agents/technical-agent";
import { runGrahamAgent } from "@/agents/sub-agents/graham-agent";
import { runDcfAgent } from "@/agents/sub-agents/dcf-agent";

// ── Auto-mode intent routing ────────────────────────────────────────────────

interface LabelledCase {
  prompt: string;
  expect: Intent;
  /** The page the message was composed on, when that is the point of the case. */
  pageContext?: PageContext;
  /** Set when the real send would carry holdings (the app always does). */
  portfolioContext?: string;
  /** Where this case came from, for the failure report. */
  note?: string;
}

/**
 * The labelled set.
 *
 * "old" cases are the pre-W2-1 set carried over, mapped as the plan specifies:
 * agent → full_analysis where the ask is explicit, otherwise fast. "readout"
 * cases are the actual beta prompts that went to the crew and shouldn't have.
 */
const CASES: LabelledCase[] = [
  // ── Carried over: explicit crew requests stay with the crew ────────────────
  { prompt: "full analysis of NVDA", expect: "full_analysis", note: "old" },
  { prompt: "give me a deep dive on TSLA", expect: "full_analysis", note: "old" },
  { prompt: "run the crew on MSFT", expect: "full_analysis", note: "old" },
  { prompt: "research report on SOFI please", expect: "full_analysis", note: "old" },
  { prompt: "comprehensive analysis of GOOGL", expect: "full_analysis", note: "old" },

  // ── Carried over: named-ticker questions are answers, not reports ──────────
  { prompt: "is TSLA a buy?", expect: "fast", note: "old (was agent)" },
  { prompt: "analyze MSFT", expect: "fast", note: "old (was agent)" },
  { prompt: "how risky is my portfolio?", expect: "fast", portfolioContext: "NVDA 10sh, AAPL 5sh", note: "old (was agent)" },
  { prompt: "review my holdings", expect: "fast", portfolioContext: "NVDA 10sh, AAPL 5sh", note: "old (was agent)" },
  { prompt: "what's a P/E ratio?", expect: "fast", note: "old (was simple)" },
  { prompt: "thanks!", expect: "fast", note: "old (was simple)" },
  { prompt: "explain what you just said", expect: "fast", note: "old (was simple)" },

  // ── Carried over: discovery ───────────────────────────────────────────────
  { prompt: "find cheap energy stocks", expect: "discover", note: "old" },
  { prompt: "best AI plays right now", expect: "discover", note: "old" },
  { prompt: "which stocks have low debt and high growth?", expect: "discover", note: "old" },
  { prompt: "ideas for dividend income", expect: "discover", note: "old" },

  // ── The readout's failures: these all went to the crew ─────────────────────
  { prompt: "is it too late to buy NVDA?", expect: "fast", note: "readout" },
  { prompt: "is AMD a buy right now?", expect: "fast", note: "readout" },
  { prompt: "should I worry about TSLA's margins?", expect: "fast", note: "readout" },
  { prompt: "thoughts on PLTR at this price", expect: "fast", note: "readout" },
  { prompt: "what's going on with COIN today", expect: "fast", note: "readout" },
  { prompt: "is SOFI overvalued", expect: "fast", note: "readout" },

  // ── The readout's brevity requests: each one started a fresh crew run ──────
  { prompt: "so yes or no?", expect: "fast", note: "readout brevity" },
  { prompt: "3 bullets", expect: "fast", note: "readout brevity" },
  { prompt: "simpler", expect: "fast", note: "readout brevity" },
  { prompt: "what about the risks?", expect: "fast", note: "readout brevity" },

  // ── Page context pins the subject: never ask "which stock?" ───────────────
  {
    prompt: "is this a buy?",
    expect: "fast",
    pageContext: { kind: "stock", ticker: "NVDA", snapshot: "NVDA $182.50, +1.8%" },
    note: "readout page-context",
  },

  // ── Clarify earns its round-trip only when nothing is specified ───────────
  { prompt: "what should I buy?", expect: "clarify", note: "old" },
  {
    prompt:
      "I have $5,000 to invest, I'm a complete beginner, and I want long-term growth over 10 years. Where do I start?",
    expect: "discover",
    note: "readout (Priya — was clarified at)",
  },
];

/** Accuracy the labelled set must not fall below. */
const MIN_ACCURACY = 0.9;

function parseJson(raw: string): Record<string, unknown> | null {
  const match = raw.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Route one prompt exactly as `POST /api/classify` does. */
async function route(c: LabelledCase): Promise<Intent> {
  const prompt = [
    promptClockLine(),
    c.pageContext ? `The user is viewing ${c.pageContext.ticker ?? c.pageContext.label}.` : "",
    c.portfolioContext ? "The user HAS a portfolio with holdings.\n" : "",
    `Latest message: ${c.prompt}`,
  ]
    .filter(Boolean)
    .join("\n");
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = parseJson(await generate({ agent: "chatRouter", system: ROUTER_SYSTEM_PROMPT, prompt, maxTokens: 200 }));
  } catch (err) {
    console.log(`   router call failed (scored as the degraded default): ${String(err)}`);
  }
  return resolveIntent(parsed, {
    userPrompt: c.prompt,
    pageContext: c.pageContext,
    portfolioContext: c.portfolioContext,
  }).intent;
}

async function runIntentCases(): Promise<boolean> {
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`Auto-mode intent routing — ${CASES.length} labelled cases`);
  console.log("══════════════════════════════════════════════════════════════\n");

  const results = await Promise.all(
    CASES.map(async (c) => ({ c, got: await route(c) }))
  );

  const misses = results.filter((r) => r.got !== r.c.expect);
  for (const { c, got } of results) {
    const ok = got === c.expect;
    console.log(`   ${ok ? "✅" : "❌"} ${c.expect.padEnd(14)} got ${got.padEnd(14)} ${c.note ? `[${c.note}] ` : ""}${c.prompt}`);
  }

  const accuracy = (results.length - misses.length) / results.length;
  // The expensive failure direction is a crew run nobody asked for, so it is
  // reported on its own rather than averaged away.
  const falseCrew = misses.filter((m) => m.got === "full_analysis").length;
  const missedCrew = misses.filter((m) => m.c.expect === "full_analysis").length;

  console.log(`\n   accuracy: ${(accuracy * 100).toFixed(1)}% (min ${(MIN_ACCURACY * 100).toFixed(0)}%)`);
  console.log(`   unasked-for crew runs: ${falseCrew} (must be 0)`);
  console.log(`   explicit crew requests missed: ${missedCrew}\n`);

  return accuracy >= MIN_ACCURACY && falseCrew === 0;
}

function snippet(s: string, n = 280): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

async function main() {
  const intentsOk = await runIntentCases();
  if (process.argv.includes("--intents")) {
    console.log(intentsOk ? "✅ INTENT ROUTING PASSED" : "❌ INTENT ROUTING FAILED");
    if (!intentsOk) process.exit(1);
    return;
  }

  console.log("══════════════════════════════════════════════════════════════");
  console.log(`LLM_ROUTING=${process.env.LLM_ROUTING ?? "(unset → on)"}  →  routing ${LLM_ROUTING_ON ? "ON" : "OFF"}`);
  console.log("Model map for the agents under test:");
  for (const a of ["technical", "graham", "dcf"] as AgentKey[]) {
    console.log(`   ${a.padEnd(11)} → ${AGENT_MODELS[a]}`);
  }
  console.log("══════════════════════════════════════════════════════════════\n");

  // ── Tier A: technical (AAPL) ────────────────────────────────────────────────
  console.log("▶ technical(AAPL) — Tier A narration");
  const tech = await runTechnicalAgent({ tickers: ["AAPL"] });
  console.log(`   output (${tech.length} chars): ${snippet(tech)}\n`);

  // ── Tier B: graham (AAPL) ───────────────────────────────────────────────────
  console.log("▶ graham(AAPL) — Tier B judgment");
  const graham = await runGrahamAgent({ ticker: "AAPL" });
  console.log(`   output (${graham.length} chars): ${snippet(graham)}\n`);

  // ── dcf (AAPL) — Sonnet, reduced thinking when routing on ───────────────────
  console.log("▶ dcf(AAPL) — Sonnet + reasoning");
  const dcf = await runDcfAgent({ ticker: "AAPL" });
  console.log(`   output (${dcf.length} chars): ${snippet(dcf)}\n`);

  // ── Data-quality guard: a bogus ticker must trip the no-data block ──────────
  console.log("▶ technical(ZZZZINVALID) — data-quality guard check");
  const guard = await runTechnicalAgent({ tickers: ["ZZZZINVALID"] });
  const guardFired = guard.includes("DATA UNAVAILABLE");
  console.log(`   guard fired: ${guardFired ? "✅ YES" : "❌ NO"} — ${snippet(guard, 160)}\n`);

  // ── Verdict ─────────────────────────────────────────────────────────────────
  const ok =
    intentsOk &&
    tech.trim().length > 0 &&
    graham.trim().length > 0 &&
    dcf.trim().length > 0 &&
    guardFired;
  console.log("──────────────────────────────────────────────────────────────");
  console.log(ok ? "✅ ALL CHECKS PASSED" : "❌ SOME CHECKS FAILED");
  console.log("──────────────────────────────────────────────────────────────");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("test-routing failed:", err);
  process.exit(1);
});
