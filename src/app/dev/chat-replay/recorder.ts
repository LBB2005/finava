/**
 * Chat replay bench (dev only): watches the real chat UI while a recorded turn
 * replays, and scripts a reader who scrolls up mid-answer.
 *
 * Collected in the browser: long tasks, long animation frames, layout shifts,
 * one requestAnimationFrame loop for frame times and scroll position. The maths
 * is in src/lib/chatBench/metrics.ts (unit-tested).
 */
import { useChatStore } from "@/stores/chatStore";
import {
  classifyScroll,
  frameSummary,
  labelElement,
  layoutShiftSummary,
  longTaskSummary,
  shiftsByPhase,
  topScripts,
  transitionAt,
  type FrameSample,
  type FrameStats,
  type ScrollStats,
  type Shift,
  type ShiftPhases,
  type ShiftStats,
} from "@/lib/chatBench/metrics";

export type ReaderKind = "trackpad" | "wheel" | "none";

/**
 * The scripted reader, once, when the answer is `TRIGGER` of the way in: it
 * catches up with the stream (jumps to the bottom and reads there for 10 frames,
 * so the page sees someone following), then scrolls up a little. Trackpad: 5 px
 * a frame for 60 frames (small deltas, like a two-finger scroll). Wheel: three
 * 100 px notches, 100 ms apart. Then it reads for 1.5 s and scrolls back down.
 */
const READERS: Record<Exclude<ReaderKind, "none">, { stepPx: number; everyFrames: number; steps: number }> = {
  trackpad: { stepPx: 5, everyFrames: 1, steps: 60 },
  wheel: { stepPx: 100, everyFrames: 6, steps: 3 },
};
const TRIGGER = 0.35;
const CATCHUP_FRAMES = 10;
const HOLD_FRAMES = 90;
const DOWN_STEP_PX = 10;
const DOWN_MAX_FRAMES = 150;
/** Keep watching after the stream ends: the committed message swaps in here. */
const TAIL_MS = 1_500;

export interface BenchReport {
  fixture: string;
  reader: ReaderKind;
  speed: number;
  viewport: { width: number; height: number; dpr: number };
  /** "visible" or the numbers are meaningless: rAF stops in a hidden tab. */
  visibility: DocumentVisibilityState;
  ranAt: string;
  /** ms after the send. */
  firstTextMs: number | null;
  endMs: number | null;
  answerChars: number;
  /** The committed answer equals the fixture's .expected.md. */
  answerMatches: boolean | null;
  /** From the send to the end of the stream + tail. */
  longTasks: { count: number; maxMs: number; tbtMs: number };
  longAnimationFrames: { count: number; top: { invoker: string; sourceURL: string; ms: number; count: number }[] };
  /** Every frame from first text to the end of the stream. */
  framesStream: FrameStats;
  /** Frames during the reader's scroll-up / read / scroll-down episode. */
  framesReader: FrameStats;
  scroll: ScrollStats;
  layout: ShiftStats;
  /** Layout shift split by moment: waiting, first text, streaming, end-of-stream swap. */
  shiftPhases: ShiftPhases;
  /** How the list's height and scroll position changed when the first text arrived and when the stream ended. */
  transitions: { firstText: { dHeight: number; dScrollTop: number } | null; end: { dHeight: number; dScrollTop: number } | null };
  topShifts: Shift[];
}

function scroller(): HTMLElement | null {
  // MessageList's scroll container (the empty state doesn't carry this class).
  return document.querySelector<HTMLElement>("main .print-transcript");
}

function describe(node: Node | null | undefined): string {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!el) return "(removed)";
  const cls = (e: Element) => (typeof e.className === "string" ? e.className : "");
  const parts = [labelElement({ tag: el.tagName, className: cls(el), text: el.textContent ?? "" })];
  let p = el.parentElement;
  for (let i = 0; i < 2 && p && p.tagName !== "MAIN"; i++, p = p.parentElement) {
    parts.unshift(labelElement({ tag: p.tagName, className: cls(p), text: "" }));
  }
  return parts.join(" > ");
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
  sources: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
}
interface LoafEntry extends PerformanceEntry {
  scripts: { invoker: string; sourceURL: string; duration: number }[];
}

export function startRecorder(o: {
  convId: string;
  fixture: string;
  expectedChars: number;
  reader: ReaderKind;
  speed: number;
}): { done: Promise<BenchReport>; cancel: () => void } {
  const t0 = performance.now();
  const longTasks: { start: number; duration: number }[] = [];
  const loafs: { scripts: LoafEntry["scripts"] }[] = [];
  const shifts: Shift[] = [];
  const observers: PerformanceObserver[] = [];
  const supported = PerformanceObserver.supportedEntryTypes ?? [];

  const observe = (type: string, onEntry: (e: PerformanceEntry) => void) => {
    if (!supported.includes(type)) return;
    const po = new PerformanceObserver((list) => list.getEntries().forEach(onEntry));
    po.observe({ type, buffered: false });
    observers.push(po);
  };
  observe("longtask", (e) => longTasks.push({ start: e.startTime - t0, duration: e.duration }));
  observe("long-animation-frame", (e) =>
    loafs.push({ scripts: (e as LoafEntry).scripts.map((s) => ({ invoker: s.invoker, sourceURL: s.sourceURL, duration: s.duration })) })
  );
  observe("layout-shift", (e) => {
    const ls = e as LayoutShiftEntry;
    shifts.push({
      t: Math.round(ls.startTime - t0),
      value: ls.value,
      hadRecentInput: ls.hadRecentInput,
      sources: ls.sources.map((s) => ({ label: describe(s.node), dy: Math.round(s.currentRect.y - s.previousRect.y) })),
    });
  });

  const frames: FrameSample[] = [];
  const streamStamps: number[] = [];
  const readerStamps: number[] = [];
  let phase: FrameSample["phase"] = "idle";
  let phaseFrame = 0;
  let readerDone = o.reader === "none";
  let sawStreaming = false;
  let firstTextAt: number | null = null;
  let endAt: number | null = null;
  let answerChars = 0;
  let raf = 0;
  let resolve!: (r: BenchReport) => void;
  const done = new Promise<BenchReport>((r) => (resolve = r));

  const tick = (now: number) => {
    const slice = useChatStore.getState().slice(o.convId);
    if (slice.isStreaming) sawStreaming = true;
    const textLen = slice.streamingContent.length;
    if (textLen) answerChars = textLen;
    if (firstTextAt == null && textLen > 0) firstTextAt = now;
    if (sawStreaming && !slice.isStreaming && endAt == null) endAt = now;

    const el = scroller();
    if (el) {
      const before = el.scrollTop;
      const maxTop = el.scrollHeight - el.clientHeight;
      let after = before;
      if (!readerDone && phase === "idle" && firstTextAt != null && endAt == null && textLen >= o.expectedChars * TRIGGER) {
        phase = "catchup";
        phaseFrame = 0;
        el.scrollTop = maxTop;
        after = el.scrollTop;
      } else if (phase === "catchup") {
        if (++phaseFrame >= CATCHUP_FRAMES) {
          phase = "up";
          phaseFrame = 0;
        }
      }
      if (phase === "up") {
        const r = READERS[o.reader as Exclude<ReaderKind, "none">];
        if (phaseFrame % r.everyFrames === 0) {
          el.scrollTop = before - r.stepPx;
          after = el.scrollTop;
        }
        if (++phaseFrame >= r.steps * r.everyFrames) {
          phase = "hold";
          phaseFrame = 0;
        }
      } else if (phase === "hold") {
        if (++phaseFrame >= HOLD_FRAMES) {
          phase = "down";
          phaseFrame = 0;
        }
      } else if (phase === "down") {
        if (maxTop - before < 2 || phaseFrame >= DOWN_MAX_FRAMES) {
          phase = "idle";
          readerDone = true;
        } else {
          el.scrollTop = before + DOWN_STEP_PX;
          after = el.scrollTop;
          phaseFrame++;
        }
      }
      frames.push({ t: Math.round(now - t0), before, after, maxTop, phase, streaming: firstTextAt != null && endAt == null });
      if (phase !== "idle") readerStamps.push(now);
    }
    if (firstTextAt != null && endAt == null) streamStamps.push(now);

    if (endAt != null && now - endAt > TAIL_MS) finish();
    else raf = requestAnimationFrame(tick);
  };

  const finish = () => {
    observers.forEach((po) => po.disconnect());
    const rel = (t: number | null) => (t == null ? null : Math.round(t - t0));
    const end = endAt != null ? endAt - t0 + TAIL_MS : performance.now() - t0;
    resolve({
      fixture: o.fixture,
      reader: o.reader,
      speed: o.speed,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      visibility: document.visibilityState,
      ranAt: new Date().toISOString(),
      firstTextMs: rel(firstTextAt),
      endMs: rel(endAt),
      answerChars,
      answerMatches: null,
      longTasks: longTaskSummary(longTasks, { start: 0, end }),
      longAnimationFrames: { count: loafs.length, top: topScripts(loafs) },
      framesStream: frameSummary(streamStamps),
      framesReader: frameSummary(readerStamps),
      scroll: classifyScroll(frames),
      layout: layoutShiftSummary(shifts),
      shiftPhases: shiftsByPhase(shifts, { firstTextMs: rel(firstTextAt), endMs: rel(endAt) }),
      transitions: {
        firstText: firstTextAt == null ? null : transitionAt(frames, firstTextAt - t0),
        end: endAt == null ? null : transitionAt(frames, endAt - t0),
      },
      topShifts: [...shifts].sort((a, b) => b.value - a.value).slice(0, 5),
    });
  };

  raf = requestAnimationFrame(tick);
  return {
    done,
    cancel: () => {
      cancelAnimationFrame(raf);
      finish();
    },
  };
}
