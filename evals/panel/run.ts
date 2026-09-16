/**
 * eval:panel: the 50-persona panel re-run. PAID. Ask Liam before running.
 *
 *   npm run eval:panel -- --dry                                  # grid + spend estimate, calls nothing
 *   npm run eval:panel -- --yes --only 1,48 --base http://localhost:3013   # 2-persona dry run
 *   npm run eval:panel -- --yes --base http://localhost:3013               # the 40 API personas
 *
 * Flags:
 *   --base <url>           app under test (default http://localhost:3013)
 *   --only <id,id>         persona ids to run
 *   --persona-model <id>   default claude-opus-5 (the Sep-14 panel used Sonnet for personas)
 *   --judge-model <id>     fact-check + theme synthesis, default claude-opus-5
 *   --concurrency <n>      personas at once, default 4 (Sep-14 ran up to 10; contention inflates waits)
 *   --max-turns <n>        default 4
 *   --out <dir>            default evals/results/panel-<timestamp>
 *   --skip-analysis        skip fact-check + theme synthesis (then run report/analyze.ts later)
 *
 * The 10 browser personas are not driven from here: see evals/panel/BROWSER.md.
 * This script writes their task sheet (browser-tasks.json) next to the results.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Conversation, type Turn } from "../lib/conversation";
import { formatEstimate, panelEstimate, tokenUsd } from "../lib/cost";
import { httpFetcher, type HttpOptions } from "../lib/http";
import { deleteConversation, measureTurn, type TurnMetrics } from "../lib/measure";
import { analyzePanel } from "../report/analyze";
import { PersonaAgent, type Levels, type Persona, type Rating, type Shown } from "./persona";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

const BASE = arg("base") ?? "http://localhost:3013";
const PERSONA_MODEL = arg("persona-model") ?? "claude-opus-5";
const JUDGE_MODEL = arg("judge-model") ?? "claude-opus-5";
const CONCURRENCY = Number(arg("concurrency") ?? 4);
const MAX_TURNS = Number(arg("max-turns") ?? 4);
const ONLY = arg("only")?.split(",").map(Number);

const file = JSON.parse(readFileSync(path.join(__dirname, "personas.json"), "utf8")) as { levels: Levels; personas: Persona[] };
const selected = ONLY ? file.personas.filter((p) => ONLY.includes(p.id)) : file.personas;
const apiPersonas = selected.filter((p) => p.channel === "api");
const browserPersonas = selected.filter((p) => p.channel === "browser");

export interface PersonaResult {
  persona: Persona;
  shown: Shown[];
  reactions: string[];
  metrics: TurnMetrics[];
  rating: Rating | null;
  quitMidSession: boolean;
  usage: { inputTokens: number; outputTokens: number; usd: number };
  error: string | null;
}

async function runPersona(client: Anthropic, http: HttpOptions, p: Persona): Promise<PersonaResult> {
  const agent = new PersonaAgent(client, PERSONA_MODEL, p, file.levels);
  const { fetcher, log } = httpFetcher(http);
  const conv = new Conversation(fetcher);
  const result: PersonaResult = { persona: p, shown: [], reactions: [], metrics: [], rating: null, quitMidSession: false, usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, error: null };
  const patienceMs = agent.patienceSec() * 1000;

  let next: { mode: "auto" | "full_analysis_button"; text: string } | null = { mode: "auto", text: p.opening };
  try {
    for (let i = 0; next && i < MAX_TURNS; i++) {
      const before = log.length;
      const startedAt = Date.now();
      let error: string | null = null;
      let turn: Turn;
      try {
        turn = await conv.send(next.mode, next.text, { stopWhen: () => Date.now() - startedAt > patienceMs });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        turn = { mode: next.mode, lane: null, text: next.text, assistant: null, rendered: "", events: [], stopped: false };
      }
      const m = measureTurn(turn, log.slice(before), startedAt, null, error);
      result.metrics.push(m);
      result.shown.push({
        prompt: next.mode === "full_analysis_button" ? "" : next.text,
        lane: turn.lane,
        waitSec: m.totalMs / 1000,
        answer: turn.assistant?.content ?? "",
        chips: turn.assistant?.followups ?? [],
        stopped: turn.stopped,
        error,
      });
      const d = await agent.decide(result.shown, MAX_TURNS - i - 1);
      result.reactions.push(d.reaction);
      if (d.next.action === "quit") result.quitMidSession = true;
      next = d.next.action === "send" ? { mode: "auto", text: d.next.text } : d.next.action === "run_full_analysis" ? { mode: "full_analysis_button", text: "" } : null;
      console.log(`  #${p.id} ${p.name} turn ${i + 1}: ${turn.lane ?? "—"} ${(m.totalMs / 1000).toFixed(0)} s${turn.stopped ? " STOPPED" : ""}${m.collapse?.collapsed ? " COLLAPSED" : ""} → ${d.next.action}`);
    }
    result.rating = await agent.rate(result.shown, result.reactions);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error(`  #${p.id} failed: ${result.error}`);
  } finally {
    await deleteConversation(http, conv.id);
  }
  result.usage = { ...agent.usage, usd: tokenUsd(PERSONA_MODEL, agent.usage.inputTokens, agent.usage.outputTokens) };
  return result;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function main() {
  // Lane mix assumption for the estimate: the Sep-14 panel averaged 2.8 turns; with
  // the fast lane as default, assume 70% fast, 15% full analysis, 8% discover, 7% clarify.
  const turns = selected.length * 3;
  const est = panelEstimate({
    apiPersonas: apiPersonas.length,
    browserPersonas: browserPersonas.length,
    turnsPerPersona: 3,
    mix: {
      fast: Math.round(turns * 0.7),
      full_analysis: Math.round(turns * 0.15),
      discover: Math.round(turns * 0.08),
      clarify: Math.round(turns * 0.07),
      deep_research: 0,
    },
    personaModel: PERSONA_MODEL,
    judgeModel: JUDGE_MODEL,
    factChecks: Math.min(25, selected.length * 3),
  });
  console.log(`eval:panel against ${BASE} · ${apiPersonas.length} API personas · ${browserPersonas.length} browser personas (run separately)`);
  console.log(formatEstimate("Estimated spend:", est));
  if (flag("dry") || !flag("yes")) {
    console.log(flag("dry") ? "\n--dry: nothing was called." : "\nRefusing to spend without --yes.");
    return;
  }

  const out = arg("out") ?? path.join("evals", "results", `panel-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "browser-tasks.json"), JSON.stringify({ base: BASE, levels: file.levels, personas: browserPersonas }, null, 2));

  const client = new Anthropic();
  const http: HttpOptions = { base: BASE, token: arg("token") };
  const results = await pool(apiPersonas, CONCURRENCY, (p) => runPersona(client, http, p));
  const meta = { base: BASE, ranAt: new Date().toISOString(), personaModel: PERSONA_MODEL, judgeModel: JUDGE_MODEL, concurrency: CONCURRENCY, maxTurns: MAX_TURNS };
  writeFileSync(path.join(out, "api-results.json"), JSON.stringify({ meta, results }, null, 2));
  console.log(`persona spend: $${results.reduce((a, r) => a + r.usage.usd, 0).toFixed(2)} · wrote ${out}/api-results.json`);

  if (!flag("skip-analysis")) {
    const analysis = await analyzePanel(client, JUDGE_MODEL, results);
    writeFileSync(path.join(out, "analysis.json"), JSON.stringify(analysis, null, 2));
    console.log(`analysis spend: $${analysis.usage.usd.toFixed(2)} · wrote ${out}/analysis.json`);
  }
  console.log(`\nNext: add browser-results.json (see evals/panel/BROWSER.md), then\n  npx tsx evals/report/build.ts --panel ${out} [--live <live dir>]`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
