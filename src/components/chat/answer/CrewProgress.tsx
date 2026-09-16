"use client";
import React, { useState } from "react";
import AgentDetailModal from "@/components/agent/AgentDetailModal";
import ModelBadge from "@/components/ui/ModelBadge";
import { AGENT_LABELS, type AgentStep } from "@/types/chat";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { crewEtaSeconds, crewSummary, formatEta, type BudgetWarning } from "@/lib/chat/crewProgress";

/**
 * What the crew is doing and how much longer it will take.
 *
 * Testers waited a median 4.2 minutes behind "Assembling your research crew"
 * with no count and no estimate. This is a compact row of agent chips that fill
 * in as each one reports, and a countdown that re-estimates from the observed
 * pace rather than a fixed guess.
 */
export default function CrewProgress({
  steps,
  startedAt,
  plannedSeconds,
  budgetWarning,
  note,
}: {
  steps: AgentStep[];
  startedAt?: number | null;
  /** From W2-2's `crew_plan` event, when it is available. */
  plannedSeconds?: number;
  /** From W2-2's `budget_warning` event. */
  budgetWarning?: BudgetWarning | null;
  /** e.g. the CEO's current step. */
  note?: string;
}) {
  const [detailStep, setDetailStep] = useState<AgentStep | null>(null);
  const elapsed = useElapsedSeconds(startedAt ?? null);
  const s = crewSummary(steps);
  const eta = formatEta(crewEtaSeconds({ steps, elapsedMs: elapsed * 1000, plannedSeconds }));

  if (!s.total) return null;
  const pct = Math.round(((s.complete + s.errored) / s.total) * 100);

  return (
    <div className="frost-card fade-in" style={{ borderRadius: "var(--radius-xl)", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--color-text)" }}>
          {note || (s.running > 0 ? `${s.running} analyst${s.running > 1 ? "s" : ""} working` : "Research crew")}
        </span>
        <span
          style={{
            fontSize: "var(--text-meta)",
            color: "var(--color-muted)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {s.complete + s.errored} of {s.total} done
        </span>
        {eta && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: "var(--text-meta)",
              fontWeight: 600,
              color: "var(--color-accent)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {eta}
          </span>
        )}
      </div>

      {/* Progress rail */}
      <div
        style={{
          height: 3,
          borderRadius: 999,
          background: "color-mix(in oklab, var(--color-text) 9%, transparent)",
          overflow: "hidden",
          margin: "9px 0 10px",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: 999,
            background: "var(--color-accent)",
            transition: "width 420ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
      </div>

      {/* Agent chips — one per analyst, openable once it has reported. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {steps.map((step) => (
          <AgentChip key={step.agent} step={step} onOpen={() => setDetailStep(step)} />
        ))}
      </div>

      {detailStep && <AgentDetailModal step={detailStep} onClose={() => setDetailStep(null)} />}

      {budgetWarning && (
        <p
          style={{
            margin: "10px 0 0",
            fontSize: "var(--text-meta)",
            color: "var(--color-warn-text)",
            background: "var(--color-warn-bg)",
            border: "1px solid var(--color-warn-border)",
            borderRadius: "var(--radius-sm)",
            padding: "6px 9px",
          }}
        >
          {budgetWarning.message}
        </p>
      )}
    </div>
  );
}

function AgentChip({ step, onOpen }: { step: AgentStep; onOpen: () => void }) {
  const label = AGENT_LABELS[step.agent] ?? step.agent;
  const done = step.status === "complete";
  const failed = step.status === "error";
  const running = step.status === "running";

  const color = failed
    ? "var(--color-bear)"
    : done
    ? "var(--color-bull)"
    : running
    ? "var(--color-accent)"
    : "var(--color-muted)";

  const openable = (step.status === "complete" || step.status === "error") && !!(step.result || step.error);

  return (
    <Chip
      openable={openable}
      onOpen={onOpen}
      title={openable ? `${label} — view what it found` : failed ? `${label} — failed` : label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: "var(--text-meta)",
        fontWeight: 500,
        whiteSpace: "nowrap",
        color: running ? "var(--color-accent)" : done || failed ? "var(--color-text-secondary)" : "var(--color-muted)",
        background: running ? "var(--color-accent-light)" : "var(--color-bg)",
        border: `1px solid ${running ? "var(--color-accent-medium)" : "var(--color-border)"}`,
        transition: "background 200ms, border-color 200ms, color 200ms",
      }}
    >
      <span
        aria-hidden="true"
        className={running ? "crew-chip-pulse" : undefined}
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          flexShrink: 0,
          background: done || failed || running ? color : "transparent",
          border: done || failed || running ? "none" : "1px solid var(--color-border-strong)",
        }}
      />
      {label}
      {step.models && step.models.length > 0 && (
        <ModelBadge brands={step.models} size={10} lit={running} dim={step.status === "pending"} />
      )}
    </Chip>
  );
}

/** A chip is a button once its agent has something to show, a span before. */
function Chip({
  openable,
  onOpen,
  title,
  style,
  children,
}: {
  openable: boolean;
  onOpen: () => void;
  title: string;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  if (!openable) return <span title={title} style={style}>{children}</span>;
  return (
    <button type="button" title={title} onClick={onOpen} className="std-focus" style={{ ...style, cursor: "pointer", font: "inherit", fontSize: style.fontSize }}>
      {children}
    </button>
  );
}
