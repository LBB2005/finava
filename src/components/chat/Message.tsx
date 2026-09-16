"use client";
import React, { useState, Component } from "react";
import Markdown from "./Markdown";

class MessageErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "12px 16px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "var(--color-surface)", color: "var(--color-muted)", fontSize: "var(--text-sm)" }}>
          This message could not be rendered.
        </div>
      );
    }
    return this.props.children;
  }
}
import AgentDetailModal from "@/components/agent/AgentDetailModal";
import { PoweredByStrip } from "@/components/ui/ModelBadge";
import { rosterFromBrands } from "@/lib/models";
import { AGENT_LABELS } from "@/types/chat";
import { extractVerdict } from "@/lib/chat/verdict";
import { parseDiscoverContent } from "@/lib/chat/discoverText";
import type { ChatMessage, AgentStep } from "@/types/chat";
import { ResponseReceipt } from "./ResponseTiming";
import DiscoverResult from "./DiscoverResult";
import type { DiscoverMessageContent } from "@/lib/scoutTypes";
import { contextPill, type ChatContext } from "@/lib/chatContext";
import { toUserFacingError } from "@/lib/userFacingError";
import AnswerCard from "./answer/AnswerCard";
import { isContractShaped } from "@/lib/answerFormat";
import { shouldShowGlossary } from "@/lib/glossary";
import { useExperienceLevel } from "@/hooks/useExperienceLevel";

/* ── Agent focus blurbs (mirrors MessageList) ────────────────────────── */
const AGENT_FOCUS: Record<string, string> = {
  run_risk_agent:         "Beta, drawdown, correlation",
  run_news_agent:         "Last 72h material headlines",
  run_macro_agent:        "Rates, FX, growth backdrop",
  run_technical_agent:    "Trend, support, momentum",
  run_dcf_agent:          "Intrinsic value range",
  run_earnings_agent:     "EPS trends, upcoming catalysts",
  run_insider_agent:      "Form-4 activity & exec changes",
  run_sentiment_agent:    "Social, news flow, options skew",
  run_competitor_agent:   "Peer comparison",
  run_options_agent:      "Options flow, put/call ratio",
  run_comparables_agent:  "Peer multiples & relative value",
  run_graham_agent:       "Benjamin Graham scorecard",
  run_analyst_agent:      "Wall Street price targets",
  run_hype_agent:         "Reddit, X, YouTube momentum",
  run_fundamentals_agent: "Revenue, margins, FCF trends",
  skeptic_review:         "Stress-test the thesis",
};

/* Short display names for ribbon pills */
const AGENT_SHORT: Record<string, string> = {
  run_risk_agent:         "Ri",
  run_news_agent:         "Ne",
  run_macro_agent:        "Ma",
  run_technical_agent:    "Te",
  run_dcf_agent:          "DC",
  run_earnings_agent:     "Ea",
  run_insider_agent:      "In",
  run_sentiment_agent:    "Se",
  run_competitor_agent:   "Co",
  run_options_agent:      "Op",
  run_comparables_agent:  "Cm",
  run_graham_agent:       "Gr",
  run_analyst_agent:      "An",
  run_hype_agent:         "Hy",
  run_fundamentals_agent: "Fu",
  skeptic_review:         "Sk",
};

/* ── AgentRibbon — collapsed bar + expandable thinking panel ─────────── */
function AgentRibbon({ steps }: { steps: AgentStep[] }) {
  const [expanded, setExpanded] = useState(false);
  const [detailStep, setDetailStep] = useState<AgentStep | null>(null);

  const completed = steps.filter((s) => s.status === "complete").length;
  const total = steps.length;
  const pillSteps = steps.slice(0, 6);
  const extra = steps.length - 6;

  return (
    <div
      className="frost-card"
      style={{
        borderRadius: "var(--radius-xl)",
        overflow: "hidden",
        transition: "border-color 200ms, background 200ms",
      }}
    >
      <button
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="agent-ribbon-toggle"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "11px 14px",
          border: "none",
          font: "inherit",
          textAlign: "left",
          cursor: "pointer",
          transition: "background 140ms",
        }}
      >
        {/* Stack glyph — Frost f4: bare accent, no plate */}
        <span
          style={{
            width: 24, height: 24,
            color: "var(--color-accent)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </span>

        {/* Titles */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--color-text)" }}>
            Research crew
          </div>
          <div style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)", marginTop: 1 }}>
            {completed} of {total} agents complete
          </div>
        </div>

        {/* 2-letter agent pills */}
        <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
          {pillSteps.map((step) => (
            <span
              key={step.agent}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 22, height: 18,
                padding: "0 5px",
                background: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
                borderRadius: 999,
                fontSize: "var(--text-micro)",
                fontWeight: 700,
                letterSpacing: "0.04em",
              }}
            >
              {AGENT_SHORT[step.agent] ?? (AGENT_LABELS[step.agent as keyof typeof AGENT_LABELS] ?? step.agent).slice(0, 2)}
            </span>
          ))}
          {extra > 0 && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 22, height: 18,
                padding: "0 5px",
                background: "var(--color-accent-light)",
                color: "var(--color-accent)",
                borderRadius: 999,
                fontSize: "var(--text-micro)",
                fontWeight: 700,
              }}
            >
              +{extra}
            </span>
          )}
        </span>

        {/* View thinking toggle */}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            color: "var(--color-accent)",
            fontSize: "var(--text-meta)",
            fontWeight: 600,
            padding: "4px 8px",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-accent-light)",
            flexShrink: 0,
          }}
        >
          {expanded ? "Hide thinking" : "View thinking"}
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ transition: "transform 200ms", transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {(() => {
        const brands = rosterFromBrands(steps.flatMap((st) => st.models ?? []));
        return brands.length ? (
          <div style={{ padding: "9px 14px 0" }}>
            <PoweredByStrip brands={brands} />
          </div>
        ) : null;
      })()}

      {detailStep && (
        <AgentDetailModal step={detailStep} onClose={() => setDetailStep(null)} />
      )}

      {/* Thinking panel */}
      {expanded && (
        <div
          style={{
            borderTop: "1px solid color-mix(in oklab, var(--color-text) 8%, transparent)",
            background: "color-mix(in oklab, var(--color-bg) 70%, transparent)",
            padding: "16px 16px 14px",
            animation: "thinking-fadein 220ms ease-out",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 12,
              padding: "0 4px",
            }}
          >
            <span
              className="eyebrow-label"
              style={{
                color: "var(--color-accent)",
              }}
            >
              Thinking trace · {total} agents
            </span>
            <span
              style={{
                fontSize: "var(--text-micro)",
                color: "var(--color-muted)",
                fontStyle: "italic",
                fontFamily: "var(--font-serif)",
              }}
            >
              Findings rolled up into the verdict below
            </span>
          </div>

          {/* Agent rows */}
          <div style={{ display: "grid", gap: 2 }}>
            {steps.map((step, i) => {
              const isSkeptic = step.agent === "skeptic_review";
              const label = isSkeptic
                ? "Skeptic Review"
                : (AGENT_LABELS[step.agent as keyof typeof AGENT_LABELS] ?? step.agent);
              const focus = AGENT_FOCUS[step.agent] ?? "";
              // Saved messages from before errors were sanitized at the source still carry raw vendor text.
              const shownStep = step.error ? { ...step, error: toUserFacingError(step.error) } : step;

              return (
                <div
                  key={step.agent}
                  className="agent-trace-row"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "30px 1fr auto",
                    gap: 12,
                    alignItems: "start",
                    padding: "9px 10px",
                    borderRadius: "var(--radius-md)",
                    transition: "background 120ms",
                  }}
                >
                  {/* Index */}
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-micro)",
                      color: "var(--color-muted)",
                      letterSpacing: "0.04em",
                      paddingTop: 1,
                    }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </div>

                  {/* Body */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--color-text)" }}>
                        {label}
                      </span>
                      {focus && (
                        <span
                          style={{
                            fontSize: "var(--text-meta)",
                            color: "var(--color-muted)",
                            fontStyle: "italic",
                            fontFamily: "var(--font-serif)",
                          }}
                        >
                          {focus}
                        </span>
                      )}
                    </div>
                    {step.result && (
                      <div style={{ fontSize: "var(--text-sm)", lineHeight: 1.55, color: "var(--color-text-secondary)" }}>
                        {step.result.slice(0, 220)}{step.result.length > 220 ? "…" : ""}
                      </div>
                    )}
                    {step.error && (
                      <div style={{ fontSize: "var(--text-sm)", lineHeight: 1.55, color: "var(--color-bear)" }}>
                        {shownStep.error}
                      </div>
                    )}
                  </div>

                  {/* Status + view full */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    {step.status === "complete" && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--color-bull)" strokeWidth="2.5" strokeLinecap="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                    {step.status === "error" && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--color-bear)" strokeWidth="2.5" strokeLinecap="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                    )}
                    {(step.result || step.error) && (
                      <button
                        onClick={() => setDetailStep(shownStep)}
                        style={{
                          fontSize: "var(--text-micro)",
                          fontWeight: 600,
                          color: "var(--color-accent)",
                          background: "var(--color-accent-light)",
                          border: "none",
                          borderRadius: "var(--radius-sm)",
                          padding: "2px 6px",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          letterSpacing: "0.04em",
                        }}
                      >
                        Full
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Verdict wrapper — left-accent card housing the markdown response ── */
function VerdictBlock({
  message,
  glossary,
  onRunFullAnalysis,
  runFullAnalysisLabel,
}: {
  message: ChatMessage;
  glossary?: boolean;
  onRunFullAnalysis?: () => void;
  runFullAnalysisLabel?: string | null;
}) {
  const timestamp = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const isAgentMode = message.mode === "agent" || message.mode === "deep_research";
  // The card holds the report's actual verdict sentence. No verdict found (or a
  // stopped run that never reached it): no card, never a fragment.
  const verdict = isAgentMode ? extractVerdict(message.content) : null;

  const footer = (
    <MessageFooter message={message} timestamp={timestamp} isAgentMode={isAgentMode} />
  );

  // Written to the answer contract: verdict first, numbers with sources, the
  // long report folded away. Anything else renders exactly as it did before.
  if (isContractShaped(message.content)) {
    return (
      <div style={{ padding: "4px 0 8px" }}>
        <AnswerCard
          markdown={message.content}
          messageId={message.id}
          glossary={glossary}
          footer={footer}
          onRunFullAnalysis={onRunFullAnalysis}
          runFullAnalysisLabel={runFullAnalysisLabel}
        />
      </div>
    );
  }

  return (
    <div
      className="verdict-fadein"
      style={{
        padding: "4px 0 8px",
      }}
    >
      {verdict && (
        <div
          style={{
            borderLeft: "2px solid var(--color-accent)",
            background: "var(--color-accent-light)",
            borderRadius: "var(--radius-sm)",
            padding: "10px 14px",
            marginBottom: 16,
          }}
        >
          <div className="eyebrow-label" style={{ color: "var(--color-accent)", marginBottom: 6 }}>
            Verdict
          </div>
          <div style={{ fontSize: "var(--text-body)", fontWeight: 600, color: "var(--color-text)", lineHeight: 1.5 }}>
            {verdict}
          </div>
        </div>
      )}

      {/* Response body */}
      <Markdown glossary={glossary}>{message.content}</Markdown>

      {footer}
    </div>
  );
}

/* ── Footer: timestamp, mode badge, receipt, Stop state ──────────────── */
function MessageFooter({
  message,
  timestamp,
  isAgentMode,
}: {
  message: ChatMessage;
  timestamp: string;
  isAgentMode: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
      <span
        style={{
          fontSize: "var(--text-meta)",
          color: "var(--color-muted)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {timestamp}
      </span>
      {isAgentMode && (
        <span
          style={{
            background: message.mode === "deep_research" ? "var(--color-deep-research-light)" : "var(--color-accent-light)",
            color: message.mode === "deep_research" ? "var(--color-deep-research)" : "var(--color-accent)",
            padding: "2px 7px",
            borderRadius: 999,
            fontSize: "var(--text-micro)",
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          {message.mode === "deep_research" ? "Deep Research" : "Agent"}
        </span>
      )}
      <ResponseReceipt durationMs={message.durationMs} />
      {message.stopped && <StoppedTag />}
    </div>
  );
}

/* ── Stopped tag — the user pressed Stop; the text above is partial ──── */
function StoppedTag() {
  return (
    <span
      style={{
        fontSize: "var(--text-meta)",
        color: "var(--color-muted)",
        border: "1px solid var(--color-border)",
        borderRadius: 999,
        padding: "1px 8px",
      }}
    >
      Stopped
    </span>
  );
}

/* ── Citation pill — which page the question was asked from ──────────── */
function PillGlyph({ ctx }: { ctx: ChatContext }) {
  const common = {
    width: 11,
    height: 11,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style: { flexShrink: 0 },
  };
  if (ctx?.startsWith("stock:")) {
    return <svg {...common}><polyline points="3 16 9 10 13 14 21 6" /></svg>;
  }
  if (ctx === "watchlist") {
    return <svg {...common}><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>;
  }
  if (ctx === "portfolio") {
    return <svg {...common}><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>;
  }
  // research
  return <svg {...common}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
}

function CitationPill({ ctx }: { ctx: ChatContext }) {
  const label = contextPill(ctx);
  if (!label) return null;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        marginTop: 7,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: "var(--text-meta)",
        fontWeight: 500,
        color: "var(--color-muted)",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      <PillGlyph ctx={ctx} />
      {label}
    </div>
  );
}

/* ── Prompt bubble — soft-tinted navy ───────────────────────────────── */
function PromptBubble({ message }: { message: ChatMessage }) {
  const timestamp = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className="prompt-lift"
      style={{
        marginLeft: "auto",
        maxWidth: "78%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
      }}
    >
      <div
        style={{
          background: "color-mix(in oklab, var(--color-accent) 8%, var(--color-bg))",
          color: "var(--color-accent-hover)",
          padding: "12px 18px",
          borderRadius: 18,
          borderBottomRightRadius: 6,
          fontSize: "var(--text-title)",
          lineHeight: 1.5,
          fontWeight: 500,
          letterSpacing: "-0.005em",
          border: "1px solid color-mix(in oklab, var(--color-accent) 14%, transparent)",
          boxShadow: "0 1px 2px color-mix(in oklab, var(--color-accent) 8%, transparent)",
        }}
      >
        {message.content}
      </div>
      <CitationPill ctx={message.context ?? null} />
      <div
        style={{
          fontSize: "var(--text-meta)",
          color: "var(--color-muted)",
          marginTop: 6,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {timestamp}
      </div>
    </div>
  );
}

/* ── Skeptic critique callout ───────────────────────────────────────── */
function SkepticCritique({ critique }: { critique: string }) {
  return (
    <div
      style={{
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-warn-border)",
        background: "var(--color-warn-bg)",
        padding: "14px 18px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <svg
          width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round"
          style={{ color: "var(--color-warn)", flexShrink: 0 }}
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span
          style={{
            fontSize: "var(--text-micro)",
            fontWeight: 700,
            color: "var(--color-warn-heading)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}
        >
          Second Opinion
        </span>
      </div>
      <Markdown style={{ color: "var(--color-warn-text)" }}>
        {critique}
      </Markdown>
    </div>
  );
}

/* ── Simple chat avatar ─────────────────────────────────────────────── */
function FinavaAvatar() {
  // Frost f4: bare accent mark — no solid plate behind the brand letter.
  return (
    <div
      className="flex-shrink-0 flex items-center justify-center text-[length:var(--text-title)] font-black"
      style={{
        width: 30, height: 30,
        borderRadius: "var(--radius-md)",
        background: "transparent",
        color: "var(--color-accent)",
        fontFamily: "var(--font-serif)",
        letterSpacing: "0.04em",
      }}
    >
      F
    </div>
  );
}

/* ── Main export ─────────────────────────────────────────────────────── */
function MessageInner({
  message,
  onSuggestion,
  onDiscoverDeeper,
  onRunFullAnalysis,
  runFullAnalysisLabel,
}: {
  message: ChatMessage;
  onSuggestion?: (text: string) => void;
  onDiscoverDeeper?: (query: string) => void;
  /** Re-ask this question with the full crew. Shown under fast answers that name a ticker. */
  onRunFullAnalysis?: (message: ChatMessage) => void;
  /** e.g. "~2 min · 4 analysts", when the planned depth is known. */
  runFullAnalysisLabel?: string | null;
}) {
  const { level } = useExperienceLevel();
  const glossary = shouldShowGlossary(level);

  if (message.role === "user") {
    return <PromptBubble message={message} />;
  }

  // Discovery mode: the structured result rides in `attachment` (older messages
  // kept it as JSON in `content`).
  if (message.mode === "discover") {
    const dc: DiscoverMessageContent | null = message.attachment ?? parseDiscoverContent(message.content);
    if (dc) {
      return (
        <DiscoverResult
          content={dc}
          message={message}
          onSuggestion={onSuggestion}
          onDiscoverDeeper={onDiscoverDeeper}
        />
      );
    }
    return (
      <div style={{ display: "flex", gap: 14 }}>
        <FinavaAvatar />
        <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
          <Markdown>{message.content}</Markdown>
          {message.stopped && <StoppedTag />}
        </div>
      </div>
    );
  }

  const isAgentMode = message.mode === "agent" || message.mode === "deep_research";
  const hasTrace = !!message.agentTrace?.length;

  /* Simple / fast lane: avatar + answer card (or flat markdown when the reply
     is not written to the contract — a brevity answer, or a legacy message). */
  if (!isAgentMode) {
    const timestamp = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const receipt = (
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <span style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)", fontVariantNumeric: "tabular-nums" }}>
          {timestamp}
        </span>
        <ResponseReceipt durationMs={message.durationMs} />
        {message.stopped && <StoppedTag />}
      </div>
    );
    const wantsFullAnalysis = onRunFullAnalysis && !message.stopped && mentionsTicker(message.content);

    return (
      <div style={{ display: "flex", gap: 14 }}>
        <FinavaAvatar />
        <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
          {isContractShaped(message.content) ? (
            <AnswerCard
              markdown={message.content}
              messageId={message.id}
              glossary={glossary}
              footer={receipt}
              onRunFullAnalysis={wantsFullAnalysis ? () => onRunFullAnalysis!(message) : undefined}
              runFullAnalysisLabel={runFullAnalysisLabel}
            />
          ) : (
            <>
              <Markdown glossary={glossary}>{message.content}</Markdown>
              {receipt}
            </>
          )}
          {message.followups && message.followups.length > 0 && onSuggestion && (
            <div style={{ marginTop: 14 }}>
              <div className="eyebrow-label" style={{ color: "var(--color-muted)", marginBottom: 8 }}>
                Follow up with
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {message.followups.map((q) => (
                  <button
                    key={q}
                    onClick={() => onSuggestion(q)}
                    className="followup-chip"
                    style={{ padding: "7px 13px", borderRadius: 999, fontSize: "var(--text-sm)", fontWeight: 500, fontFamily: "inherit", cursor: "pointer", transition: "all 140ms" }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* Agent / deep research: ribbon → verdict → optional critique */
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {hasTrace && <AgentRibbon steps={message.agentTrace!} />}
      <VerdictBlock message={message} glossary={glossary} />
      {message.critique && <SkepticCritique critique={message.critique} />}
      {message.followups && message.followups.length > 0 && onSuggestion && (
        <div style={{ paddingTop: 2 }}>
          <div
            className="eyebrow-label"
            style={{
              color: "var(--color-muted)",
              marginBottom: 10,
            }}
          >
            Follow up with
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {message.followups.map((q) => (
              <button
                key={q}
                onClick={() => onSuggestion(q)}
                className="followup-chip"
                style={{
                  padding: "8px 14px",
                  borderRadius: 999,
                  fontSize: "var(--text-sm)",
                  fontWeight: 500,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  transition: "all 140ms",
                }}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Does this answer name a ticker? The full-crew button only makes sense then. */
function mentionsTicker(content: string): boolean {
  return /(?:^|[\s($])[A-Z]{2,5}(?=[\s.,:;)?!]|$)/m.test(content.replace(/```[\s\S]*?```/g, ""));
}

export default function Message(props: {
  message: ChatMessage;
  onSuggestion?: (text: string) => void;
  onDiscoverDeeper?: (query: string) => void;
  onRunFullAnalysis?: (message: ChatMessage) => void;
  runFullAnalysisLabel?: string | null;
}) {
  return (
    <MessageErrorBoundary>
      <MessageInner {...props} />
    </MessageErrorBoundary>
  );
}
