/**
 * eval:live: the fixed scenario set against a running Finava. PAID.
 *
 *   npm run eval:live -- --dry                              # plan + estimate, calls nothing
 *   npm run eval:live -- --yes --base http://localhost:3013  # run it
 *
 * Flags:
 *   --base <url>       app to test (default http://localhost:3013)
 *   --only <id,id>     run only these scenario ids (a small dry run)
 *   --out <dir>        where results go (default evals/results/live-<timestamp>)
 *   --no-persist       skip the save → reload check through /api/conversations
 *   --record           also save every lane stream as a smoke fixture
 *   --token <t>        bearer token (default dev-bypass; a preview deploy needs a real one)
 *
 * Output: results.json (every turn) and summary.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useChatStore } from "@/stores/chatStore";
import { Conversation, type Lane } from "../lib/conversation";
import { appUsd, formatEstimate, type LaneMix } from "../lib/cost";
import { httpFetcher, type HttpOptions } from "../lib/http";
import { deleteConversation, laneRequest, measureTurn, persistAndReload, recordFixture, type TurnMetrics } from "../lib/measure";
import { summarizeLive, liveMarkdown } from "../report/live";
import { SCENARIOS, type ScenarioTurn } from "./scenarios";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};

const BASE = arg("base") ?? "http://localhost:3013";
const ONLY = arg("only")?.split(",");
const scenarios = ONLY ? SCENARIOS.filter((s) => ONLY.includes(s.id)) : SCENARIOS;
const http: HttpOptions = { base: BASE, token: arg("token") };

function mixOf(turns: ScenarioTurn[]): LaneMix {
  const mix: LaneMix = { fast: 0, full_analysis: 0, deep_research: 0, discover: 0, clarify: 0 };
  for (const t of turns) mix[t.expect] += 1;
  return mix;
}

async function main() {
  const allTurns = scenarios.flatMap((s) => s.turns);
  const estimate = appUsd(mixOf(allTurns), allTurns.filter((t) => t.mode === "auto").length);
  console.log(`eval:live against ${BASE} · ${scenarios.length} scenarios · ${allTurns.length} turns`);
  console.log(formatEstimate("Estimated spend (app side, W3-4 p90 per lane):", estimate));
  if (flag("dry") || !flag("yes")) {
    console.log(flag("dry") ? "\n--dry: nothing was called." : "\nRefusing to spend without --yes. Re-run with --dry to see the plan, --yes to run.");
    return;
  }

  const out = arg("out") ?? path.join("evals", "results", `live-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });
  const results: (TurnMetrics & { scenario: string; expect: Lane })[] = [];

  for (const sc of scenarios) {
    const { fetcher, log } = httpFetcher(http);
    const conv = new Conversation(fetcher);
    let created = false;
    for (const [i, t] of sc.turns.entries()) {
      const before = log.length;
      const msgsBefore = conv.messages.length;
      const startedAt = Date.now();
      let error: string | null = null;
      let turn;
      try {
        turn = await conv.send(t.mode, t.text, { portfolioContext: sc.portfolioContext, holdings: sc.holdings });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        turn = { mode: t.mode, lane: null, text: t.text, assistant: null, rendered: "", events: [], stopped: false };
      }
      const requests = log.slice(before);
      let reloaded = null;
      if (!flag("no-persist") && turn.assistant) {
        try {
          reloaded = await persistAndReload(http, conv, created, conv.messages.slice(msgsBefore));
          created = true;
        } catch (e) {
          error ??= `persist: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      const m = { ...measureTurn(turn, requests, startedAt, reloaded, error), scenario: sc.id, expect: t.expect };
      results.push(m);
      if (flag("record")) {
        const req = laneRequest(requests);
        if (req?.bytes.length) console.log(`  recorded ${recordFixture(`${sc.id}-${i + 1}`, req)}`);
      }
      console.log(
        `  ${sc.id} #${i + 1} ${m.lane ?? "—"}${m.lane !== t.expect ? ` (expected ${t.expect})` : ""} · ttft ${m.ttftMs ?? "—"} ms · total ${m.totalMs} ms` +
          `${m.collapse?.collapsed ? ` · COLLAPSED at ${m.collapse.where}` : ""}${m.error ? ` · ERROR ${m.error}` : ""}`
      );
    }
    if (created && !flag("keep")) await deleteConversation(http, conv.id);
    useChatStore.setState((s) => {
      const { [conv.id]: _, ...rest } = s.messagesByConv;
      void _;
      return { messagesByConv: rest };
    });
  }

  const summary = summarizeLive(results);
  writeFileSync(path.join(out, "results.json"), JSON.stringify({ base: BASE, ranAt: new Date().toISOString(), summary, results }, null, 2));
  writeFileSync(path.join(out, "summary.md"), liveMarkdown(summary, BASE));
  console.log(`\n${liveMarkdown(summary, BASE)}\nwrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
