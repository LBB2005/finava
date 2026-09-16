/**
 * Panel analysis (PAID, runs at the end of eval:panel): a 25-claim fact-check
 * sample and theme coding across every tester's write-up.
 *
 * The Sep-14 fact-check picked claims to find problems. This one takes a
 * deterministic spread (one claim per persona in id order, then a second round)
 * so the two rates are not directly comparable. The readout says so.
 */
import Anthropic from "@anthropic-ai/sdk";
import { tokenUsd } from "../lib/cost";
import type { PersonaResult } from "../panel/run";
import baseline from "../baseline/2026-09-14.json";

function previousThemes(): string {
  const t = baseline.themes;
  return [
    ...t.likes.map((x) => `likes: ${x.t}`),
    ...t.frustrations.map((x) => `frustrations: ${x.t}`),
    ...t.missing.map((x) => `missing: ${x.t}`),
  ].join("\n");
}

export type Verdict = "correct" | "minor" | "stale" | "wrong" | "fabricated" | "unverifiable";

export interface FactCheck {
  personaId: number;
  claim: string;
  verdict: Verdict;
  note: string;
  sources: string[];
}

export interface Theme {
  t: string;
  c: number;
  ex: string;
}

export interface PanelAnalysis {
  factChecks: FactCheck[];
  themes: { likes: Theme[]; frustrations: Theme[]; missing: Theme[] };
  usage: { inputTokens: number; outputTokens: number; usd: number };
}

/** Round-robin one claim per persona until `n`. Pure, exported for tests. */
export function sampleClaims(results: { persona: { id: number }; rating: { claims: string[] } | null }[], n = 25) {
  const out: { personaId: number; claim: string }[] = [];
  for (let round = 0; out.length < n; round++) {
    let added = false;
    for (const r of results) {
      const c = r.rating?.claims[round];
      if (c && out.length < n) {
        out.push({ personaId: r.persona.id, claim: c });
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

/** The last JSON object in a text block. Web search responses can't use structured outputs alongside citations. */
export function lastJsonObject<T>(text: string): T | null {
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        /* keep widening */
      }
    }
  }
  return null;
}

export async function analyzePanel(client: Anthropic, model: string, results: PersonaResult[]): Promise<PanelAnalysis> {
  const usage = { inputTokens: 0, outputTokens: 0, usd: 0 };
  const count = (u: Anthropic.Usage) => {
    usage.inputTokens += u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.outputTokens += u.output_tokens;
  };
  const today = new Date().toISOString().slice(0, 10);

  const factChecks: FactCheck[] = [];
  for (const { personaId, claim } of sampleClaims(results)) {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Today is ${today}. Fact-check this claim a stock-research app made to a user. Use web search against primary sources (SEC EDGAR, company IR, exchange data, dated news).

Claim: """${claim}"""

Verdicts: correct · minor (right in substance, small error) · stale (was true, out of date now) · wrong · fabricated (no basis anywhere) · unverifiable (cannot be checked from public sources).
End your reply with one JSON object: {"verdict": "...", "note": "one sentence", "sources": ["url", ...]}`,
      },
    ];
    let text = "";
    for (let hop = 0; hop < 4; hop++) {
      const res = await client.messages.create({
        model,
        max_tokens: 16000,
        messages,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
        output_config: { effort: "medium" },
      } as never) as unknown as Anthropic.Message;
      count(res.usage);
      text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content as never });
    }
    const v = lastJsonObject<{ verdict: Verdict; note: string; sources: string[] }>(text);
    factChecks.push({ personaId, claim, verdict: v?.verdict ?? "unverifiable", note: v?.note ?? "No verdict returned.", sources: v?.sources ?? [] });
  }

  const writeups = results
    .filter((r) => r.rating)
    .map((r) => `#${r.persona.id} (${r.persona.ai}/${r.persona.stock})\nliked: ${r.rating!.liked.join(" | ")}\nfrustrations: ${r.rating!.frustrations.join(" | ")}\nmissing: ${r.rating!.missing.join(" | ")}`)
    .join("\n\n");
  const themeList = { type: "array", items: { type: "object", additionalProperties: false, required: ["t", "c", "ex"], properties: { t: { type: "string" }, c: { type: "integer" }, ex: { type: "string" } } } };
  const res = (await client.messages.create({
    model,
    max_tokens: 16000,
    messages: [
      {
        role: "user",
        content: `Code these beta-tester write-ups into themes. For each of likes, frustrations and missing, give up to 10 themes. c = number of DISTINCT testers who raised it (count carefully; never more than the number of write-ups). ex = one short example with the tester number. Keep themes specific ("Multi-minute waits with no ETA", not "speed"). Where a theme matches one from the Sep-14 panel, reuse its exact wording so the two can be compared:\n${previousThemes()}\n\nWrite-ups:\n\n${writeups}`,
      },
    ],
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: { type: "object", additionalProperties: false, required: ["likes", "frustrations", "missing"], properties: { likes: themeList, frustrations: themeList, missing: themeList } } },
    },
  } as never)) as unknown as Anthropic.Message;
  count(res.usage);
  const themeText = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "{}";
  const themes = JSON.parse(themeText) as PanelAnalysis["themes"];

  usage.usd = tokenUsd(model, usage.inputTokens, usage.outputTokens);
  return { factChecks, themes, usage };
}
