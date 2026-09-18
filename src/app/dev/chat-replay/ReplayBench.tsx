"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import ChatContainer from "@/components/chat/ChatContainer";
import Button from "@/components/ui/Button";
import { useChatStore } from "@/stores/chatStore";
import { fromStoredMessage } from "@/lib/chat/storedMessage";
import { ReplayClock } from "@/lib/chatBench/replayClock";
import { createReplayFetch } from "@/lib/chatBench/replayFetch";
import { sendFor, type ReplayTiming } from "@/lib/chatBench/timing";
import type { ChatMessage } from "@/types/chat";
import { startRecorder, type BenchReport, type ReaderKind } from "./recorder";

interface FixtureInfo {
  name: string;
  route: string;
  recorded: boolean;
}
interface FixturePayload {
  name: string;
  sse: string;
  expected: string;
  timing: ReplayTiming;
}
interface RunOpts {
  fixture: string;
  speed?: number;
  reader?: ReaderKind;
}
type RunState = "idle" | "loading" | "running" | "done" | "error";

interface BenchApi {
  /** Start a replay; resolves with the report when the stream has ended and settled. */
  run: (o: RunOpts) => Promise<BenchReport>;
  status: () => {
    state: RunState;
    fixture: string | null;
    replayMs: number | null;
    paused: boolean;
    error: string | null;
    /** Length of the viewed conversation's streaming text. */
    streamingChars: number;
  };
  pause: () => void;
  play: () => void;
  setSpeed: (speed: number) => void;
  last: BenchReport | null;
  history: BenchReport[];
}

declare global {
  interface Window {
    __chatBench?: BenchApi;
    __chatBenchRealFetch?: typeof fetch;
  }
}

/** The browser's own fetch, captured once so a replay can always be undone. */
function realFetch(): typeof fetch {
  window.__chatBenchRealFetch ??= window.fetch.bind(window);
  return window.__chatBenchRealFetch;
}

/** What the committed message says the stream was (Discover keeps its text on the attachment). */
function savedAnswer(m: ChatMessage): string {
  const a = m.attachment;
  if (m.mode === "discover" && a) return a.kind === "final" ? a.report : a.kind === "shortlist" ? (a.framing ?? "") : "";
  return m.content;
}

const READERS: ReaderKind[] = ["trackpad", "wheel", "none"];
const parseReader = (v: string | null): ReaderKind => (READERS.includes(v as ReaderKind) ? (v as ReaderKind) : "trackpad");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function ReplayBench() {
  const params = useSearchParams();
  const [fixtures, setFixtures] = useState<FixtureInfo[]>([]);
  const [fixture, setFixture] = useState(params.get("fixture") ?? "");
  const [speed, setSpeedState] = useState(Number(params.get("speed")) || 1);
  const [reader, setReader] = useState<ReaderKind>(parseReader(params.get("reader")));
  const [open, setOpen] = useState(params.get("autostart") !== "1");
  const [state, setState] = useState<RunState>("idle");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BenchReport | null>(null);

  const clockRef = useRef<ReplayClock | null>(null);
  const statusRef = useRef<{ state: RunState; fixture: string | null; error: string | null }>({ state: "idle", fixture: null, error: null });
  const historyRef = useRef<BenchReport[]>([]);

  const setRun = useCallback((s: RunState, fx: string | null, err: string | null = null) => {
    statusRef.current = { state: s, fixture: fx, error: err };
    setState(s);
    setError(err);
  }, []);

  useEffect(() => {
    realFetch()("/api/dev/replay-fixtures")
      .then((r) => r.json())
      .then((d: { fixtures: FixtureInfo[] }) => {
        setFixtures(d.fixtures);
        setFixture((f) => f || d.fixtures.find((x) => x.recorded)?.name || d.fixtures[0]?.name || "");
      })
      .catch((e) => setError(String(e)));
  }, []);

  const run = useCallback(
    async (o: RunOpts): Promise<BenchReport> => {
      if (statusRef.current.state === "loading" || statusRef.current.state === "running") throw new Error("a replay is already running");
      const runSpeed = o.speed ?? 1;
      const runReader = o.reader ?? "trackpad";
      setRun("loading", o.fixture);
      setReport(null);
      const net = realFetch();
      try {
        const res = await net(`/api/dev/replay-fixtures?name=${encodeURIComponent(o.fixture)}`);
        if (!res.ok) throw new Error(`fixture ${o.fixture}: ${res.status}`);
        const fx = (await res.json()) as FixturePayload;
        const bytes = Uint8Array.from(atob(fx.sse), (c) => c.charCodeAt(0));

        // Start from the screen the recording started from: the conversation so far.
        const convId = `replay-${fx.name}-${Date.now()}`;
        const store = useChatStore.getState();
        const prevMode = store.mode;
        const send = sendFor(fx.timing);
        useChatStore.setState((s) => ({
          messagesByConv: { ...s.messagesByConv, [convId]: fx.timing.prior.map(fromStoredMessage) },
        }));
        store.setConversationId(convId);
        store.setMode(send.mode);
        setRun("running", o.fixture);
        // Let the transcript (and this panel) render, then put the reader at the bottom,
        // where someone who just read the last answer and sent this turn would be.
        // (MessageList only pins when you're already near the bottom, so a transcript
        // that appears all at once opens at the top.)
        await sleep(600);
        document.querySelector("main .print-transcript")?.scrollTo({ top: 1e9 });
        await sleep(200);

        const clock = new ReplayClock({ speed: runSpeed });
        clockRef.current = clock;
        setPaused(false);
        const replay = createReplayFetch({ bytes, timing: fx.timing }, clock, net);
        window.fetch = replay.fetch as typeof fetch;

        const rec = startRecorder({ convId, fixture: fx.name, expectedChars: fx.expected.length, reader: runReader, speed: runSpeed });
        clock.play();
        store.enqueueSend({ convId, text: send.text, mode: send.mode, context: null, kind: send.kind });
        const r = await rec.done;

        window.fetch = net;
        const last = [...useChatStore.getState().messagesOf(convId)].reverse().find((m) => m.role === "assistant");
        const full: BenchReport = { ...r, answerMatches: last ? savedAnswer(last) === fx.expected : false };
        useChatStore.getState().setMode(prevMode);
        historyRef.current.push(full);
        console.info("[chat-bench]", JSON.stringify(full));
        setReport(full);
        setRun("done", o.fixture);
        return full;
      } catch (e) {
        window.fetch = net;
        const msg = e instanceof Error ? e.message : String(e);
        setRun("error", o.fixture, msg);
        throw e;
      }
    },
    [setRun]
  );

  // The browser tools drive the bench through window.__chatBench.
  useEffect(() => {
    window.__chatBench = {
      run,
      status: () => ({
        ...statusRef.current,
        replayMs: clockRef.current ? Math.round(clockRef.current.elapsed()) : null,
        paused: clockRef.current?.paused ?? false,
        streamingChars: useChatStore.getState().slice(useChatStore.getState().conversationId).streamingContent.length,
      }),
      pause: () => {
        clockRef.current?.pause();
        setPaused(true);
      },
      play: () => {
        clockRef.current?.play();
        setPaused(false);
      },
      setSpeed: (s: number) => {
        clockRef.current?.setSpeed(s);
        setSpeedState(s);
      },
      get last() {
        return historyRef.current.at(-1) ?? null;
      },
      get history() {
        return historyRef.current;
      },
    };
  }, [run]);

  const autostarted = useRef(false);
  useEffect(() => {
    if (autostarted.current || params.get("autostart") !== "1" || !params.get("fixture")) return;
    autostarted.current = true;
    void run({ fixture: params.get("fixture")!, speed, reader }).catch(() => {});
    // Autostart reads the URL once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = state === "loading" || state === "running";
  const togglePause = () => {
    const c = clockRef.current;
    if (!c) return;
    if (c.paused) c.play();
    else c.pause();
    setPaused(c.paused);
  };
  const changeSpeed = (s: number) => {
    setSpeedState(s);
    clockRef.current?.setSpeed(s);
  };

  return (
    <>
      <ChatContainer />
      {/* Fixed overlay, so the chat underneath lays out exactly as /chat does. It
          only re-renders when a run starts or ends, never during the stream. */}
      <div
        className="fixed right-2 top-14 md:top-2 z-[var(--z-dropdown)] w-[min(340px,calc(100vw-16px))] rounded-[var(--radius-lg)] text-[length:var(--text-meta)]"
        style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", boxShadow: "var(--shadow-pop)", color: "var(--color-text)" }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="std-focus w-full flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--radius-lg)]"
          aria-expanded={open}
        >
          <span className="eyebrow-label" style={{ color: "var(--color-muted)" }}>
            Replay bench
          </span>
          <span style={{ color: state === "error" ? "var(--color-bear)" : "var(--color-text-secondary)" }}>
            {state === "idle" ? "ready" : state}
            {paused && busy ? " · paused" : ""}
          </span>
        </button>
        {open && (
          <div className="px-3 pb-3 flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span style={{ color: "var(--color-muted)" }}>Fixture</span>
              <select
                className="std-focus h-[28px] rounded-[var(--radius-sm)] px-2"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                value={fixture}
                onChange={(e) => setFixture(e.target.value)}
                disabled={busy}
              >
                {fixtures.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                    {f.recorded ? "" : " (synthetic)"}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2">
              <span style={{ color: "var(--color-muted)" }}>Speed</span>
              {[1, 4].map((s) => (
                <Button key={s} size="sm" variant={speed === s ? "primary" : "outline"} onClick={() => changeSpeed(s)}>
                  {s}×
                </Button>
              ))}
              <span className="ml-2" style={{ color: "var(--color-muted)" }}>
                Reader
              </span>
              <select
                className="std-focus h-[28px] rounded-[var(--radius-sm)] px-1"
                style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                value={reader}
                onChange={(e) => setReader(parseReader(e.target.value))}
                disabled={busy}
              >
                {READERS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || !fixture} onClick={() => void run({ fixture, speed, reader }).catch(() => {})}>
                Run
              </Button>
              <Button size="sm" variant="outline" disabled={!busy} onClick={togglePause}>
                {paused ? "Resume" : "Pause"}
              </Button>
            </div>
            {error && <p style={{ color: "var(--color-bear)" }}>{error}</p>}
            {report && <ReportSummary r={report} />}
          </div>
        )}
      </div>
    </>
  );
}

function ReportSummary({ r }: { r: BenchReport }) {
  const rows: [string, string][] = [
    ["Answer matches fixture", r.answerMatches ? "yes" : "NO"],
    ["Long tasks > 50 ms", `${r.longTasks.count} (max ${r.longTasks.maxMs} ms)`],
    ["Total blocking time", `${r.longTasks.tbtMs} ms`],
    ["Frame p95 · stream", r.framesStream.p95Ms == null ? "—" : `${r.framesStream.p95Ms} ms (${r.framesStream.dropped} dropped)`],
    ["Frame p95 · reader scrolling", r.framesReader.p95Ms == null ? "—" : `${r.framesReader.p95Ms} ms (${r.framesReader.dropped} dropped)`],
    ["Scroll yanks", `${r.scroll.yanks} (${r.scroll.yankPx} px) · reader got ${r.scroll.maxAwayPx} px up`],
    ["Other scroll moves", `${r.scroll.others} (${r.scroll.otherPx} px)`],
    ["CLS", `${r.layout.cls.toFixed(3)} (total ${r.layout.total.toFixed(3)}, ${r.layout.count} shifts)`],
  ];
  const largest = r.layout.largest;
  return (
    <div className="flex flex-col gap-1 pt-1" style={{ borderTop: "1px solid var(--color-border)" }}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3">
          <span style={{ color: "var(--color-muted)" }}>{k}</span>
          <span className="tabular-nums text-right">{v}</span>
        </div>
      ))}
      {largest && (
        <p className="break-words" style={{ color: "var(--color-text-secondary)" }}>
          Largest shift {largest.value.toFixed(3)} at {largest.t} ms: {largest.sources[0]?.label ?? "?"}
        </p>
      )}
      <p style={{ color: "var(--color-muted)" }}>
        {r.viewport.width}×{r.viewport.height} · {r.speed}× · reader {r.reader} · {r.visibility}
      </p>
    </div>
  );
}
