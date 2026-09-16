/**
 * Build the readout from eval results. No spend: it reads files and runs the
 * smoke eval.
 *
 *   npx tsx evals/report/build.ts --panel evals/results/panel-… --live evals/results/live-… [--out dir]
 *
 * Writes readout.json (the data the published artifact renders) and readout.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import baselineJson from "../baseline/2026-09-14.json";
import type { PanelAnalysis } from "./analyze";
import { CAVEATS, compare, factCheckCounts, launchGate, summarizePanel, type Baseline, type GateInputs, type PanelRow, type Readout } from "./compare";
import type { LiveSummary } from "./live";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const readJson = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null);

interface VitestJson {
  testResults: { name: string; assertionResults: { title: string; fullName: string; status: string }[] }[];
}

/** Run the smoke eval and read the switch and collapse results out of it. */
export function smokeResults(): GateInputs["smoke"] {
  const outFile = path.join("evals", "results", "smoke.json");
  mkdirSync(path.dirname(outFile), { recursive: true });
  try {
    execFileSync("npx", ["vitest", "run", "--config", "evals/vitest.config.ts", "--reporter=json", `--outputFile=${outFile}`], { stdio: "ignore" });
  } catch {
    /* failures are read from the report below */
  }
  const r = readJson<VitestJson>(outFile);
  if (!r) return null;
  const all = r.testResults.flatMap((f) => f.assertionResults.map((a) => ({ ...a, file: f.name })));
  const switches = all.filter((a) => /^#\d+ /.test(a.title));
  const collapse = all.filter((a) => a.file.endsWith("stream.smoke.test.ts"));
  return {
    collapsePassed: collapse.length > 0 && collapse.every((a) => a.status === "passed"),
    switchesPassed: switches.filter((a) => a.status === "passed").length,
    switchesTotal: switches.length,
  };
}

/** `- [x] Legal packet reviewed…` in the launch-gate doc. */
export function manualGate(md: string): GateInputs["manual"] {
  const ticked = (re: RegExp) => md.split("\n").some((l) => /^\s*-\s*\[x\]/i.test(l) && re.test(l));
  return {
    lawyerReviewed: ticked(/lawyer/i),
    capsMeasured: ticked(/caps measured/i),
    privacyTodosClosed: ticked(/privacy/i),
  };
}

function markdown(r: Readout): string {
  const fmt = (v: number | string | null) => (v == null ? "Unavailable" : typeof v === "number" ? String(Math.round(v * 100) / 100) : v);
  return [
    `# Finava panel re-run: readout`,
    "",
    `Generated ${r.generatedAt}. Baseline: ${r.baseline.label}.`,
    "",
    "## Compared with Sep-14",
    "| Metric | Sep-14 | Now | Better? |",
    "|---|---|---|---|",
    ...r.comparison.map((c) => `| ${c.metric} | ${fmt(c.baseline)} | ${fmt(c.now)} | ${c.better == null ? "—" : c.better ? "yes" : "no"} |`),
    "",
    "## Launch gate",
    ...r.gate.map((g) => `- **${g.status.toUpperCase()}**: ${g.criterion} (${g.evidence})`),
    "",
    "## Caveats",
    ...r.caveats.map((c) => `- ${c}`),
    "",
  ].join("\n");
}

function main() {
  const panelDir = arg("panel");
  const liveDir = arg("live");
  const baseline = baselineJson as unknown as Baseline;

  const api = panelDir ? readJson<{ results: PanelRow[] }>(path.join(panelDir, "api-results.json")) : null;
  const browser = panelDir ? readJson<{ results: PanelRow[] }>(path.join(panelDir, "browser-results.json")) : null;
  const rows = [...(api?.results ?? []), ...(browser?.results ?? [])];
  const panel = rows.length ? summarizePanel(rows) : null;
  const analysis = panelDir ? readJson<PanelAnalysis>(path.join(panelDir, "analysis.json")) : null;
  const live = liveDir ? readJson<{ summary: LiveSummary }>(path.join(liveDir, "results.json"))?.summary ?? null : null;

  const gateDoc = existsSync("docs/launch/launch-gate.md") ? readFileSync("docs/launch/launch-gate.md", "utf8") : "";
  const readout: Readout = {
    generatedAt: new Date().toISOString(),
    baseline,
    panel,
    comparison: panel ? compare(baseline, panel) : [],
    live,
    analysis: analysis ? { factChecks: analysis.factChecks, themes: analysis.themes } : null,
    factCheckCounts: factCheckCounts(analysis),
    gate: launchGate({ smoke: smokeResults(), live, panel, manual: manualGate(gateDoc) }),
    caveats: CAVEATS,
  };

  const out = arg("out") ?? panelDir ?? path.join("evals", "results");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "readout.json"), JSON.stringify(readout, null, 2));
  writeFileSync(path.join(out, "readout.md"), markdown(readout));
  console.log(markdown(readout));
  console.log(`wrote ${out}/readout.json and readout.md`);
}

// Only as a CLI: the tests import the helpers above.
if (process.argv[1]?.endsWith("build.ts")) main();
