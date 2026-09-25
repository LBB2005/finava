/**
 * Formatting for `evals/bench/run.ts`: bench reports as rows of the chat-feel
 * plan's Baseline table, and the CLI flags.
 */
import type { BenchReport, ReaderKind } from "@/app/dev/chat-replay/recorder";

export const BASELINE_HEADER = [
  "Fixture",
  "Width",
  "Long tasks > 50 ms",
  "TBT",
  "Frame p95 while scrolling",
  "Scroll jumps",
  "CLS (largest shift)",
];

const minus = (n: number) => (n < 0 ? `−${Math.abs(n)}` : `+${n}`);

export function baselineRow(label: string, r: BenchReport): string[] {
  const flags = [r.answerMatches === false ? "⚠ answer mismatch" : "", r.visibility !== "visible" ? "⚠ hidden tab" : ""].filter(Boolean);
  const lt = r.longTasks.count ? `${r.longTasks.count} (max ${r.longTasks.maxMs} ms)` : "0";
  const fr = r.framesReader.p95Ms == null ? "—" : `${r.framesReader.p95Ms} ms (${r.framesReader.dropped} dropped)`;
  const s = r.scroll;
  const jumps = s.yanks
    ? `${s.yanks} yanks (${s.yankPx} px); reader held ≤ ${s.maxAwayPx} px from the bottom`
    : s.maxAwayPx
      ? `0; reader stayed ${s.maxAwayPx} px up`
      : "n/a (answer fits on screen)";
  // One render can add up to ~120 px before the pin catches up; past that the page stopped following.
  const behind = s.leftBehindPx > 150 ? `; stream ran ${s.leftBehindPx} px past a still reader` : "";
  const big = r.layout.largest;
  const cls = big && big.value >= 0.001
    ? `${r.layout.cls.toFixed(3)} (largest ${big.value.toFixed(3)}: ${big.sources[0]?.label ?? "?"}, moved ${minus(big.sources[0]?.dy ?? 0)} px)`
    : r.layout.count
      ? r.layout.cls.toFixed(3)
      : "0";
  return [[label, ...flags].join(" "), String(r.viewport.width), lt, `${r.longTasks.tbtMs} ms`, fr, jumps + behind, cls];
}

export function markdownTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), `|${header.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}

export interface BenchArgs {
  base: string;
  fixtures: string[];
  widths: number[];
  /** CDP CPU throttling rates; 1 = none. */
  cpu: number[];
  reader: ReaderKind;
  speed: number;
  out: string | null;
}

export function parseArgs(argv: string[]): BenchArgs {
  const arg = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const list = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : []);
  return {
    base: arg("base") ?? "http://localhost:3011",
    fixtures: list(arg("fixture")),
    widths: arg("width") ? list(arg("width")).map(Number) : [1440, 375],
    cpu: arg("cpu") ? list(arg("cpu")).map(Number) : [1],
    reader: (arg("reader") as ReaderKind) ?? "trackpad",
    speed: Number(arg("speed") ?? 1),
    out: arg("out") ?? null,
  };
}
