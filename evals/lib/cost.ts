/**
 * Pre-flight spend estimates for the paid evals. Every paid command prints one
 * of these and exits under `--dry`; nothing runs without `--yes`.
 *
 * App-side costs are the p90 $/run per lane measured in Sep 2026 (W3-4,
 * docs/pricing/run-cost-2026-09.md), so estimates err high. Persona-side costs
 * are token guesses priced at the Anthropic list rates below; the real number
 * is printed from `usage` after the run.
 */

/** p90 $/run by lane (docs/pricing/run-cost-2026-09.md). The router call is a guess (one small Haiku call). */
export const LANE_USD: Record<"fast" | "full_analysis" | "deep_research" | "discover" | "clarify" | "router", number> = {
  fast: 0.0064,
  full_analysis: 0.2231,
  discover: 0.0908,
  deep_research: 0.5213,
  clarify: 0,
  router: 0.0005,
};

/** $ per million tokens, Anthropic first-party list price. */
export const MODEL_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function tokenUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_USD_PER_MTOK[model];
  if (!p) throw new Error(`no price for ${model}`);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export interface LaneMix {
  fast: number;
  full_analysis: number;
  deep_research: number;
  discover: number;
  clarify: number;
}

export interface Estimate {
  lines: { label: string; usd: number }[];
  totalUsd: number;
}

export function appUsd(mix: LaneMix, autoTurns: number): Estimate {
  const lines = (Object.keys(mix) as (keyof LaneMix)[])
    .filter((k) => mix[k] > 0)
    .map((k) => ({ label: `app · ${k} × ${mix[k]}`, usd: mix[k] * LANE_USD[k] }));
  if (autoTurns) lines.push({ label: `app · router × ${autoTurns}`, usd: autoTurns * LANE_USD.router });
  return { lines, totalUsd: lines.reduce((a, l) => a + l.usd, 0) };
}

/**
 * Persona-side token budget per API persona: one call per turn (read the answer,
 * react, write the next message) and one final rating call over the transcript.
 * Adaptive thinking tokens bill as output, so output is sized generously.
 */
export const PERSONA_TOKENS = {
  perTurn: { input: 7_000, output: 1_800 },
  rating: { input: 18_000, output: 3_500 },
  /** One verification call per fact-checked claim; web search results inflate input. */
  factCheck: { input: 20_000, output: 2_500, searches: 5 },
  /** Theme coding: a fixed prompt plus each tester's write-up. */
  synthesis: { baseInput: 4_000, perPersonaInput: 1_500, output: 8_000 },
};

/** Web search server tool, $ per search ($10 per 1,000). */
export const WEB_SEARCH_USD = 0.01;

export function panelEstimate(a: {
  apiPersonas: number;
  browserPersonas: number;
  turnsPerPersona: number;
  mix: LaneMix;
  personaModel: string;
  judgeModel: string;
  factChecks: number;
}): Estimate {
  const personas = a.apiPersonas + a.browserPersonas;
  const turns = personas * a.turnsPerPersona;
  const app = appUsd(a.mix, turns);
  const { perTurn, rating, factCheck, synthesis } = PERSONA_TOKENS;
  const lines = [
    ...app.lines,
    {
      label: `persona turns · ${a.personaModel} × ${a.apiPersonas * a.turnsPerPersona}`,
      usd: a.apiPersonas * a.turnsPerPersona * tokenUsd(a.personaModel, perTurn.input, perTurn.output),
    },
    { label: `persona ratings · ${a.personaModel} × ${a.apiPersonas}`, usd: a.apiPersonas * tokenUsd(a.personaModel, rating.input, rating.output) },
    {
      label: `fact-check · ${a.judgeModel} × ${a.factChecks} (+ up to ${factCheck.searches} web searches each)`,
      usd: a.factChecks * (tokenUsd(a.judgeModel, factCheck.input, factCheck.output) + factCheck.searches * WEB_SEARCH_USD),
    },
    {
      label: `theme synthesis · ${a.judgeModel} × 1`,
      usd: tokenUsd(a.judgeModel, synthesis.baseInput + synthesis.perPersonaInput * personas, synthesis.output),
    },
  ];
  if (a.browserPersonas) {
    lines.push({
      label: `browser personas × ${a.browserPersonas} (run from a Claude Code session: counts against that plan's usage, not listed here)`,
      usd: 0,
    });
  }
  return { lines, totalUsd: lines.reduce((s, l) => s + l.usd, 0) };
}

export function formatEstimate(title: string, e: Estimate): string {
  const w = Math.max(...e.lines.map((l) => l.label.length), 10);
  return [
    title,
    ...e.lines.map((l) => `  ${l.label.padEnd(w)}  $${l.usd.toFixed(2)}`),
    `  ${"TOTAL (estimate, errs high)".padEnd(w)}  $${e.totalUsd.toFixed(2)}`,
  ].join("\n");
}
