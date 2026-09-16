"use client";
import { useState } from "react";
import AnswerCard from "@/components/chat/answer/AnswerCard";
import CrewProgress from "@/components/chat/answer/CrewProgress";
import Markdown from "@/components/chat/Markdown";
import { isContractShaped } from "@/lib/answerFormat";
import type { AgentStep } from "@/types/chat";
import {
  BEGINNER_ANSWER,
  BREVITY_ANSWER,
  CREW_ANSWER,
  FAST_ANSWER,
  LEGACY_ANSWER,
  STREAMING_ANSWER,
} from "./fixtures";

/**
 * Answer-UI preview: every state the answer card has to survive, on one page,
 * with no network and no auth. Check it at 375 px as well as desktop.
 */
const CREW: AgentStep[] = [
  { agent: "run_fundamentals_agent", status: "complete", result: "Revenue +62% YoY." },
  { agent: "run_dcf_agent", status: "complete", result: "Fair value $150–205." },
  { agent: "run_risk_agent", status: "running" },
  { agent: "run_news_agent", status: "running" },
  { agent: "run_insider_agent", status: "error", error: "Filing feed timed out." },
  { agent: "skeptic_review", status: "pending" },
];

const CASES = [
  { id: "crew", title: "Crew answer", note: "Two screens with Details collapsed", md: CREW_ANSWER },
  { id: "fast", title: "Fast answer", note: "Verdict in the first screen, full-crew escape hatch", md: FAST_ANSWER, full: true },
  { id: "brevity", title: "Brevity answer", note: "No headings — renders as plain markdown", md: BREVITY_ANSWER },
  { id: "streaming", title: "Partial (streaming)", note: "Sections fill in as they arrive", md: STREAMING_ANSWER, streaming: true },
  { id: "legacy", title: "Legacy report", note: "Pre-contract message, unchanged rendering", md: LEGACY_ANSWER },
  { id: "beginner", title: "Beginner reader", note: "Glossary marks on first mention", md: BEGINNER_ANSWER, glossary: true },
];

export default function AnswerPreviewPage() {
  const [glossaryAll, setGlossaryAll] = useState(false);
  // 42s into a run, so the ETA has something to count down from.
  const [crewStartedAt] = useState(() => Date.now() - 42_000);

  // The app shell clips its route area, so this page owns its own scroll.
  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto max-w-[760px] px-4 py-10 pb-[160px] flex flex-col gap-10">
      <header>
        <h1
          className="m-0 text-[length:var(--text-display)] font-bold"
          style={{ fontFamily: "var(--font-serif)", color: "var(--color-text)", letterSpacing: "-0.015em" }}
        >
          Answer UI preview
        </h1>
        <p className="mt-1.5 text-[length:var(--text-sm)]" style={{ color: "var(--color-text-secondary)" }}>
          Fixtures only — no network, no auth. Dev route.
        </p>
        <label className="mt-3 inline-flex items-center gap-2 text-[length:var(--text-sm)]" style={{ color: "var(--color-text-secondary)" }}>
          <input type="checkbox" checked={glossaryAll} onChange={(e) => setGlossaryAll(e.target.checked)} />
          Glossary marks everywhere (beginner / intermediate reader)
        </label>
      </header>

      <section>
        <Label title="Crew progress" note="Chips per analyst, ETA re-estimated from the pace" />
        <CrewProgress steps={CREW} startedAt={crewStartedAt} plannedSeconds={150} />
      </section>

      {CASES.map((c) => (
        <section key={c.id}>
          <Label title={c.title} note={c.note} />
          {isContractShaped(c.md) ? (
            <AnswerCard
              markdown={c.md}
              messageId={`preview-${c.id}`}
              glossary={glossaryAll || !!c.glossary}
              streaming={!!c.streaming}
              onRunFullAnalysis={c.full ? () => {} : undefined}
              runFullAnalysisLabel={c.full ? "~2 min · 4 analysts" : null}
            />
          ) : (
            <Markdown glossary={glossaryAll || !!c.glossary}>{c.md}</Markdown>
          )}
        </section>
      ))}
    </div>
    </div>
  );
}

function Label({ title, note }: { title: string; note: string }) {
  return (
    <div className="mb-3 pb-2" style={{ borderBottom: "1px solid var(--color-border)" }}>
      <span className="eyebrow-label" style={{ color: "var(--color-accent)" }}>{title}</span>
      <span className="ml-2 text-[length:var(--text-meta)]" style={{ color: "var(--color-muted)" }}>{note}</span>
    </div>
  );
}
