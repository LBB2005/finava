/** Summary + markdown for `eval:live` results. Pure. */
import type { Lane } from "../lib/conversation";
import type { TurnMetrics } from "../lib/measure";
import { median, mismatchRate, percentile } from "../lib/metrics";

export interface LaneSummary {
  lane: Lane;
  turns: number;
  ttftP50Ms: number | null;
  totalP50Ms: number | null;
  totalP90Ms: number | null;
  collapsed: number;
  errors: number;
}

export interface LiveSummary {
  turns: number;
  errors: number;
  collapsed: number;
  routingMisses: { scenario: string; prompt: string; expected: Lane; got: Lane | null }[];
  lanes: LaneSummary[];
  contract: { full: number; answer_only: number; partial: number; none: number };
  /** Null until the server emits `number_check` events (W4-1). */
  numberMismatchRate: number | null;
}

type Row = TurnMetrics & { scenario: string; expect: Lane };

export function summarizeLive(rows: Row[]): LiveSummary {
  const lanes = [...new Set(rows.map((r) => r.lane).filter((l): l is Lane => l !== null))];
  const contract = { full: 0, answer_only: 0, partial: 0, none: 0 };
  for (const r of rows) if (r.contract) contract[r.contract.kind] += 1;
  return {
    turns: rows.length,
    errors: rows.filter((r) => r.error).length,
    collapsed: rows.filter((r) => r.collapse?.collapsed).length,
    routingMisses: rows
      .filter((r) => r.lane !== r.expect)
      .map((r) => ({ scenario: r.scenario, prompt: r.prompt, expected: r.expect, got: r.lane })),
    lanes: lanes.map((lane) => {
      const xs = rows.filter((r) => r.lane === lane);
      const ok = xs.filter((r) => !r.error);
      return {
        lane,
        turns: xs.length,
        ttftP50Ms: median(ok.map((r) => r.ttftMs).filter((v): v is number => v != null)),
        totalP50Ms: median(ok.map((r) => r.totalMs)),
        totalP90Ms: percentile(ok.map((r) => r.totalMs), 90),
        collapsed: xs.filter((r) => r.collapse?.collapsed).length,
        errors: xs.length - ok.length,
      };
    }),
    contract,
    numberMismatchRate: mismatchRate(rows.map((r) => r.numberCheck)),
  };
}

const sec = (ms: number | null) => (ms == null ? "Unavailable" : `${(ms / 1000).toFixed(1)} s`);

export function liveMarkdown(s: LiveSummary, base: string): string {
  return [
    `# eval:live: ${base}`,
    "",
    `${s.turns} turns · ${s.errors} errors · **${s.collapsed} collapsed** · ${s.routingMisses.length} routing misses`,
    "",
    "| Lane | Turns | TTFT p50 | Total p50 | Total p90 | Collapsed | Errors |",
    "|---|---|---|---|---|---|---|",
    ...s.lanes.map((l) => `| ${l.lane} | ${l.turns} | ${sec(l.ttftP50Ms)} | ${sec(l.totalP50Ms)} | ${sec(l.totalP90Ms)} | ${l.collapsed} | ${l.errors} |`),
    "",
    `Contract shape: ${s.contract.full} full · ${s.contract.answer_only} answer-only · ${s.contract.partial} partial · ${s.contract.none} none`,
    `Number-check mismatch rate: ${s.numberMismatchRate == null ? "Unavailable (no number_check events; W4-1)" : `${(s.numberMismatchRate * 100).toFixed(1)}%`}`,
    ...(s.routingMisses.length
      ? ["", "Routing misses:", ...s.routingMisses.map((m) => `- ${m.scenario}: "${m.prompt}" → ${m.got ?? "none"} (expected ${m.expected})`)]
      : []),
    "",
  ].join("\n");
}
