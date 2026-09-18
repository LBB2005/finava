/**
 * Chat replay bench, from the command line. FREE: replays recorded fixtures, no model calls.
 *
 *   npm run bench:replay -- --fixture recorded-chat-verdict-then-escalate-1,recorded-agent-verdict-then-escalate-3
 *   npm run bench:replay -- --fixture … --width 375 --cpu 1,4 --reader wheel --out evals/results/bench.json
 *
 * Needs the dev server running (the page is dev only) and Google Chrome installed
 * (CHROME_PATH to override). It drives headless Chrome over the DevTools protocol:
 * a visible tab, a fixed viewport, optional CPU throttling, and a fresh page load
 * per run, so the numbers repeat. Each run opens /dev/chat-replay and calls
 * `window.__chatBench.run(...)`: the real chat client replays the fixture at the
 * recorded pace while the page measures itself (src/app/dev/chat-replay/recorder.ts).
 *
 * Flags: --base (default http://localhost:3011) · --fixture a,b (required) ·
 * --width 1440,375 · --cpu 1 (CDP throttling rates) · --reader trackpad|wheel|none ·
 * --speed 1 · --out file.json · --shots dir (also save a mid-stream and a final
 * screenshot of the chat column per run; screenshots cost frames, so don't use
 * them for the numbers) · --shot-at ms,ms (extra screenshots at those replay times) ·
 * --profile prefix (save a .cpuprofile per run and print the top self-time functions;
 * diagnosis only, sampling adds overhead).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BenchReport } from "@/app/dev/chat-replay/recorder";
import { BASELINE_HEADER, baselineRow, markdownTable, parseArgs } from "./table";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HEIGHT: Record<number, number> = { 1440: 900, 375: 812 };
const argv = process.argv.slice(2);
const args = parseArgs(argv);
const shotsIdx = argv.indexOf("--shots");
const SHOTS = shotsIdx === -1 ? null : argv[shotsIdx + 1];
const profileIdx = argv.indexOf("--profile");
const PROFILE = profileIdx === -1 ? null : argv[profileIdx + 1];
const shotAtIdx = argv.indexOf("--shot-at");
/** Extra screenshots at these replay times (ms), e.g. mid-way through the crew's wait. */
const SHOT_AT = shotAtIdx === -1 ? [] : argv[shotAtIdx + 1].split(",").map(Number);

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: Msg) => void>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as Msg;
      const p = m.id != null ? this.pending.get(m.id) : undefined;
      if (p) {
        this.pending.delete(m.id!);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      } else {
        this.listeners.forEach((l) => l(m));
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    return new Cdp(ws);
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  once(method: string, sessionId: string, timeoutMs = 60_000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      const l = (m: Msg) => {
        if (m.method === method && m.sessionId === sessionId) {
          clearTimeout(timer);
          this.listeners.delete(l);
          resolve(m);
        }
      };
      this.listeners.add(l);
    });
  }

  close() {
    this.ws.close();
  }
}

async function launchChrome(): Promise<{ wsUrl: string; proc: ChildProcess; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "chat-bench-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    proc.stderr!.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}): ${buf.slice(-500)}`)));
    setTimeout(() => reject(new Error("Chrome did not start in 20 s")), 20_000);
  });
  return { wsUrl, proc, dir };
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** A JPEG of the chat column only: the sidebar (conversation titles, portfolio) stays out of the picture. */
async function screenshot(cdp: Cdp, sessionId: string, file: string) {
  const clip = await evaluate<{ x: number; y: number; width: number; height: number }>(
    cdp,
    sessionId,
    "(() => { const r = document.querySelector('main').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()"
  );
  const { data } = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    { format: "jpeg", quality: 70, clip: { ...clip, scale: 1 } },
    sessionId
  );
  writeFileSync(file, Buffer.from(data, "base64"));
}

/** A fresh tab at the bench page, signed in with the dev-auth bypass, at this size and CPU rate. */
async function openBench(cdp: Cdp, width: number, cpu: number): Promise<{ sessionId: string; targetId: string }> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const s = (m: string, p: object = {}) => cdp.send(m, p, sessionId);
  await s("Page.enable");
  await s("Runtime.enable");
  const mobile = width < 768;
  await s("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT[width] ?? 900, deviceScaleFactor: 1, mobile });
  if (mobile) await s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const load = cdp.once("Page.loadEventFired", sessionId);
  await s("Page.navigate", { url: `${args.base}/login` });
  await load;
  await evaluate(cdp, sessionId, "localStorage.setItem('finava_dev_auth','1')");
  const load2 = cdp.once("Page.loadEventFired", sessionId, 120_000);
  await s("Page.navigate", { url: `${args.base}/dev/chat-replay?panel=0` });
  await load2;
  for (let i = 0; i < 240; i++) {
    if (await evaluate<boolean>(cdp, sessionId, "typeof window.__chatBench === 'object'")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await s("Emulation.setCPUThrottlingRate", { rate: cpu });
  return { sessionId, targetId };
}

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
}

/** The functions the main thread spent the most of its own time in. */
function topSelfTime(p: CpuProfile, limit = 15): string {
  const byNode = new Map<number, number>();
  p.samples.forEach((id, i) => byNode.set(id, (byNode.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
  const byFn = new Map<string, number>();
  for (const n of p.nodes) {
    const us = byNode.get(n.id) ?? 0;
    if (!us) continue;
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) ?? 0) + us);
  }
  return [...byFn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, us]) => `    ${String(Math.round(us / 1000)).padStart(6)} ms  ${k}`)
    .join("\n");
}

async function runOnce(
  cdp: Cdp,
  fixture: string,
  width: number,
  cpu: number,
  opts: { speed: number; reader: string; shots: string | null; profile?: string | null }
): Promise<BenchReport> {
  const { sessionId, targetId } = await openBench(cdp, width, cpu);
  try {
    const call = `window.__chatBench.run(${JSON.stringify({ fixture, speed: opts.speed, reader: opts.reader })})`;
    if (opts.profile) {
      // Diagnosis only: sampling adds overhead, so profiled numbers aren't baseline numbers.
      await cdp.send("Profiler.enable", {}, sessionId);
      await cdp.send("Profiler.setSamplingInterval", { interval: 2_000 }, sessionId);
      await cdp.send("Profiler.start", {}, sessionId);
      const report = await evaluate<BenchReport>(cdp, sessionId, call);
      const { profile } = await cdp.send<{ profile: CpuProfile }>("Profiler.stop", {}, sessionId);
      const file = `${opts.profile}-${fixture}-${width}.cpuprofile`;
      writeFileSync(file, JSON.stringify(profile));
      console.log(`  profile → ${file}\n${topSelfTime(profile)}`);
      return report;
    }
    if (!opts.shots) return await evaluate<BenchReport>(cdp, sessionId, call);
    // Screenshot pass: kick the run off, catch it mid-stream, then at the end.
    await evaluate(cdp, sessionId, `(${call}, true)`);
    const base = path.join(opts.shots, `${fixture}-${width}${cpu > 1 ? `-cpu${cpu}` : ""}`);
    let shotMid = false;
    const pending = [...SHOT_AT];
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      const st = await evaluate<{ state: string; streamingChars: number; replayMs: number | null }>(cdp, sessionId, "window.__chatBench.status()");
      while (pending.length && st.replayMs != null && st.replayMs >= pending[0]) {
        await screenshot(cdp, sessionId, `${base}-at-${Math.round(pending.shift()! / 1000)}s.jpg`);
      }
      if (!shotMid && st.streamingChars > 400) {
        await screenshot(cdp, sessionId, `${base}-streaming.jpg`);
        shotMid = true;
      }
      if (st.state === "done" || st.state === "error") break;
    }
    await screenshot(cdp, sessionId, `${base}-done.jpg`);
    return await evaluate<BenchReport>(cdp, sessionId, "window.__chatBench.last");
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function main() {
  if (!args.fixtures.length) throw new Error("--fixture <name[,name]> is required (see /api/dev/replay-fixtures for names)");
  const health = await fetch(`${args.base}/api/dev/replay-fixtures`).catch(() => null);
  if (!health?.ok) throw new Error(`${args.base} isn't serving the bench (is the dev server running?)`);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  const out = args.out ?? path.join("evals", "results", `bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  const results: { fixture: string; width: number; cpu: number; report: BenchReport }[] = [];
  const failures: { fixture: string; width: number; cpu: number; error: string }[] = [];
  const tableOf = () =>
    markdownTable(BASELINE_HEADER, results.map(({ fixture, cpu, report }) => baselineRow(`${fixture}${cpu > 1 ? ` · ${cpu}× CPU` : ""}`, report)));
  // Written after every run, so a failure late in a long matrix loses nothing.
  const save = () => writeFileSync(out, JSON.stringify({ args, ranAt: new Date().toISOString(), results, failures, table: tableOf() }, null, 2));

  const { wsUrl, proc, dir } = await launchChrome();
  const cdp = await Cdp.connect(wsUrl);
  try {
    // Warm-up: the first load compiles the page and its chunks; don't time that.
    console.log("warm-up…");
    await runOnce(cdp, args.fixtures[0], args.widths[0], 1, { speed: 4, reader: "none", shots: null });
    for (const cpu of args.cpu) {
      for (const width of args.widths) {
        for (const fixture of args.fixtures) {
          const t = Date.now();
          const once = () => runOnce(cdp, fixture, width, cpu, { speed: args.speed, reader: args.reader, shots: SHOTS, profile: PROFILE });
          let report: BenchReport;
          try {
            report = await once().catch((e) => {
              console.log(`  retrying ${fixture} · ${width}px after: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
              return once();
            });
          } catch (e) {
            failures.push({ fixture, width, cpu, error: e instanceof Error ? e.message : String(e) });
            console.log(`${fixture} · ${width}px · cpu ${cpu}× · FAILED twice: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
            save();
            continue;
          }
          results.push({ fixture, width, cpu, report });
          save();
          console.log(`${fixture} · ${width}px · cpu ${cpu}× · ${Math.round((Date.now() - t) / 1000)} s`);
          console.log(`  ${baselineRow("", report).slice(2).join(" · ")}`);
        }
      }
    }
  } finally {
    cdp.close();
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  save();
  console.log(`\n${tableOf()}`);
  if (failures.length) console.log(`\n${failures.length} run(s) failed: ${failures.map((f) => `${f.fixture} · ${f.width}px`).join(", ")}`);
  console.log(`\nwrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
