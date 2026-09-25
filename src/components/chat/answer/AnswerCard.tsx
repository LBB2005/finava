"use client";
import React, { memo, useMemo, useState } from "react";
import Markdown from "../Markdown";
import KeyNumbers from "./KeyNumbers";
import CaseColumns from "./CaseColumns";
import DetailsExpander from "./DetailsExpander";
import { parseAnswer, type ParsedAnswer } from "@/lib/answerFormat";

/**
 * The answer, verdict first.
 *
 * The beta readout is the whole brief for this component: the median crew
 * answer ran 20,900 characters with the verdict near the end, and 25 of 50
 * testers asked for it at the top. So the first thing on screen is the plain
 * sentence that answers the question; the numbers that back it come next with
 * their sources attached; the long report folds away behind one click.
 *
 * It renders the same while streaming — sections appear as they arrive rather
 * than the card popping in at the end. Each section is memoised on its own
 * text, so only the section being written re-renders; a section that arrives
 * mid-stream fades in once (opacity only, nothing moves).
 */
export default function AnswerCard({
  markdown,
  messageId,
  glossary = false,
  streaming = false,
  footer,
  onRunFullAnalysis,
  runFullAnalysisLabel,
}: {
  markdown: string;
  /** Used to remember this message's Details toggle. */
  messageId: string;
  glossary?: boolean;
  streaming?: boolean;
  /** Timestamp / receipt row rendered under the answer. */
  footer?: React.ReactNode;
  onRunFullAnalysis?: () => void;
  /** e.g. "~2 min · 4 analysts" — shown on the button when the depth is known. */
  runFullAnalysisLabel?: string | null;
}) {
  const p: ParsedAnswer = useMemo(() => parseAnswer(markdown), [markdown]);
  // Decided once, at mount: a card that mounted streaming fades its sections in
  // as they arrive; a settled card (a reload) fades in whole. The streaming card
  // becomes the settled one in place, so nothing replays when the stream ends.
  const [mountedStreaming] = useState(streaming);
  const enter = mountedStreaming ? "fade-in fade-in-still" : undefined;

  return (
    <div className={mountedStreaming ? undefined : "verdict-fadein"} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {p.preamble && <Markdown glossary={glossary} className={enter}>{p.preamble}</Markdown>}

      {p.answer !== undefined && <Lede text={p.answer} glossary={glossary} className={enter} />}

      {p.keyNumbers && <KeyNumbers rows={p.keyNumbers} className={enter} />}

      <CaseColumns bull={p.bull} bear={p.bear} glossary={glossary} enterClassName={enter} />

      {p.changeView !== undefined && p.changeView.trim() && (
        <LabelledSection heading="What would change the view" body={p.changeView} glossary={glossary} className={enter} />
      )}

      {p.confidence !== undefined && p.confidence.trim() && <ConfidenceLine text={p.confidence} className={enter} />}

      {p.other?.map((s) => (
        <LabelledSection key={s.heading} heading={s.heading} body={s.body} glossary={glossary} className={enter} />
      ))}

      {/* The same control before and after the stream ends, so the swap moves nothing. */}
      {p.details !== undefined && (
        <DetailsExpander id={messageId} markdown={p.details} glossary={glossary} pending={streaming} className={enter} />
      )}

      {onRunFullAnalysis && !streaming && (
        <RunFullAnalysisButton onClick={onRunFullAnalysis} depthLabel={runFullAnalysisLabel} />
      )}

      {footer}
    </div>
  );
}

const Lede = memo(function Lede({ text, glossary, className }: { text: string; glossary: boolean; className?: string }) {
  return (
    <section
      className={className ? `answer-lede ${className}` : "answer-lede"}
      style={{
        fontFamily: "var(--font-serif)",
        // Full display size on a laptop; a touch smaller on a phone so the
        // verdict and the first numbers share the opening screen.
        fontSize: "clamp(var(--text-lg), 4.2vw, var(--text-display))",
        lineHeight: 1.45,
        letterSpacing: "-0.012em",
        fontWeight: 500,
        color: "var(--color-text)",
      }}
    >
      {text.trim() ? <AnswerProse text={text} glossary={glossary} /> : <span style={{ color: "var(--color-muted)" }}>…</span>}
    </section>
  );
});

const LabelledSection = memo(function LabelledSection({
  heading,
  body,
  glossary,
  className,
}: {
  heading: string;
  body: string;
  glossary: boolean;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="eyebrow-label" style={{ color: "var(--color-muted)", marginBottom: 6 }}>
        {heading}
      </div>
      <Markdown glossary={glossary}>{body}</Markdown>
    </section>
  );
});

/**
 * The lede reads as one paragraph of serif prose. It goes through markdown only
 * when glossary marks are on (a <p> cannot contain the markdown wrapper, so the
 * section around it is a block, not a paragraph).
 */
function AnswerProse({ text, glossary }: { text: string; glossary?: boolean }) {
  if (!glossary) return <>{text}</>;
  return (
    <Markdown
      glossary
      className="answer-prose"
      style={{ fontFamily: "inherit", fontSize: "inherit", lineHeight: "inherit", fontWeight: "inherit" }}
    >
      {text}
    </Markdown>
  );
}

const LEVEL = /^\s*(high|medium|low)\b/i;

const ConfidenceLine = memo(function ConfidenceLine({ text, className }: { text: string; className?: string }) {
  const level = LEVEL.exec(text)?.[1]?.toLowerCase();
  const rest = level ? text.replace(LEVEL, "").replace(/^\s*[—–-]\s*/, "") : text;
  const tone =
    level === "high" ? "var(--color-bull)" : level === "low" ? "var(--color-bear)" : "var(--color-warn)";

  return (
    <section
      className={className}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 9,
        flexWrap: "wrap",
        paddingTop: 2,
        borderTop: "1px solid var(--color-border)",
        paddingBlockStart: 12,
      }}
    >
      {level && (
        <span
          className="eyebrow-label"
          style={{
            color: tone,
            border: `1px solid color-mix(in oklab, ${tone} 35%, transparent)`,
            background: `color-mix(in oklab, ${tone} 8%, transparent)`,
            borderRadius: 999,
            padding: "2px 8px",
          }}
        >
          {level} confidence
        </span>
      )}
      <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)", lineHeight: 1.6, flex: 1, minWidth: "16ch" }}>
        {rest || "—"}
      </span>
    </section>
  );
});

/**
 * The escape hatch from the fast lane: the same question, run by the full crew.
 * It says up front what that costs in time, because the thing testers hated was
 * not the wait — it was the wait with no idea how long.
 */
export function RunFullAnalysisButton({
  onClick,
  depthLabel,
}: {
  onClick: () => void;
  depthLabel?: string | null;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        className="std-focus run-full-analysis"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 9,
          padding: "9px 15px",
          borderRadius: 999,
          border: "1px solid var(--color-accent-medium)",
          background: "var(--color-accent-light)",
          color: "var(--color-accent)",
          fontSize: "var(--text-sm)",
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          transition: "background 140ms, border-color 140ms",
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
        </svg>
        Run full analysis
        {depthLabel && (
          <span style={{ fontWeight: 500, color: "var(--color-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
            {depthLabel}
          </span>
        )}
      </button>
    </div>
  );
}
