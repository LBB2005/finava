"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { components as baseComponents, glossaryComponents } from "./Markdown";
import AnswerCard from "./answer/AnswerCard";
import { isContractShaped } from "@/lib/answerFormat";
import { GlossaryMarks, shouldShowGlossary } from "@/lib/glossary";
import { useExperienceLevel } from "@/hooks/useExperienceLevel";

/**
 * Claude-style streaming text. The refinement lives entirely in the *pacing*:
 *   1. useSmoothStream — decouples the reveal from bursty SSE chunks, dripping
 *      characters out at a steady cadence so text grows smoothly and never
 *      stutters.
 *   2. StreamingMarkdown — renders the revealed markdown with the exact same
 *      component styles as settled text, so there is no per-word flicker and no
 *      shift when the stream ends. The steady reveal is the only motion.
 */

/* ── Smooth-paced reveal ─────────────────────────────────────────────── */
export function useSmoothStream(raw: string, active: boolean): string {
  const [display, setDisplay] = useState(raw);
  const rawRef = useRef(raw);
  const idxRef = useRef(active ? 0 : raw.length);

  useEffect(() => {
    rawRef.current = raw;
    if (!active) idxRef.current = raw.length;
  }, [raw, active]);

  useEffect(() => {
    if (!active) {
      idxRef.current = rawRef.current.length;
      setDisplay(rawRef.current);
      return;
    }
    let frame = 0;
    let last = 0;
    const loop = (t: number) => {
      if (!last) last = t;
      const dt = t - last;
      last = t;
      const target = rawRef.current.length;
      // New stream started (content reset) — rewind.
      if (target < idxRef.current) idxRef.current = 0;
      const backlog = target - idxRef.current;
      if (backlog > 0) {
        // Steady base speed; accelerate when far behind so we never lag.
        const cps = Math.max(110, backlog * 6);
        const add = Math.min(backlog, Math.max(1, Math.round((cps * dt) / 1000)));
        idxRef.current += add;
        setDisplay(rawRef.current.slice(0, idxRef.current));
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return active ? display : raw;
}

export default function StreamingMarkdown({ content }: { content: string }) {
  const { level } = useExperienceLevel();
  const glossary = shouldShowGlossary(level);

  // An answer written to the contract streams straight into the answer card, so
  // the verdict is readable the moment it lands instead of after the report —
  // sections fill in underneath it as they arrive.
  if (isContractShaped(content)) {
    return <AnswerCard markdown={content} messageId="streaming" glossary={glossary} streaming />;
  }

  // Reuse the exact settled-text component map — the smooth-paced reveal is the
  // only motion, so there is no per-word flicker and nothing shifts on finish.
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={glossary ? glossaryComponents(new GlossaryMarks()) : baseComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
