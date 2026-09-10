"use client";
import { useEffect, useRef, useState } from "react";
import StreamingMarkdown, { useSmoothStream } from "./StreamingMarkdown";
import Message from "./Message";
import TypingIndicator from "./TypingIndicator";
import { LiveElapsed } from "./ResponseTiming";
import AgentDetailModal from "@/components/agent/AgentDetailModal";
import ModelBadge from "@/components/ui/ModelBadge";
import { AGENT_LABELS } from "@/types/chat";
import type { ChatMessage, ChatMode, AgentStep, Template } from "@/types/chat";
import { useChatStore } from "@/stores/chatStore";
import { useMarketPulse } from "@/hooks/useMarketPulse";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usMarketStatus } from "@/lib/marketHours";
import useSWR from "swr";
import { authFetcher } from "@/lib/authFetch";

/* ── Starter prompts with tags ──────────────────────────────────────────── */

// Shown before any holdings exist. Every one of these works on an empty
// account — the portfolio set below would answer "you have no positions".
const STARTER_SUGGESTIONS = [
  { tag: "ANALYZE", text: "Run Finava's analysis on AAPL" },
  { tag: "VERDICT", text: "Is NVDA a buy at today's price?" },
  { tag: "SCREEN", text: "Find quality compounders that aren't expensive" },
  { tag: "COMPARE", text: "Compare AMD and NVDA on fundamentals" },
  { tag: "VALUE", text: "Run a DCF on MSFT and show the assumptions" },
  { tag: "IDEAS", text: "What's moving in the market today, and why?" },
  { tag: "SECTOR", text: "Which sectors look cheapest right now?" },
  { tag: "LEARN", text: "Explain what the Finava score actually measures" },
];

// Shown once the user has a book — these all lean on real positions.
const PORTFOLIO_SUGGESTIONS = [
  { tag: "RISK",  text: "What are my biggest position risks right now?" },
  { tag: "VALUE", text: "Run a full DCF on my largest holding" },
  { tag: "TRIM",  text: "Which positions should I consider trimming?" },
  { tag: "MACRO", text: "How does today's macro environment affect my book?" },
  { tag: "DIVERSIFY", text: "Where is my portfolio over-concentrated?" },
  { tag: "EARNINGS", text: "Which of my holdings report earnings this week?" },
  { tag: "THESIS", text: "Is my thesis on my top position still intact?" },
  { tag: "HEDGE",  text: "How could I hedge my downside without selling?" },
  { tag: "SCREEN", text: "Find quality stocks I don't already own" },
  { tag: "DIVIDEND", text: "What's my blended dividend yield and growth?" },
  { tag: "TAX",    text: "Any tax-loss harvesting opportunities right now?" },
  { tag: "SECTOR", text: "How is my sector exposure tilted vs the S&P 500?" },
  { tag: "MOMENTUM", text: "Which holdings have the strongest momentum?" },
  { tag: "VALUATION", text: "Which of my positions look most overvalued?" },
  { tag: "CASH",   text: "How should I deploy my idle cash?" },
  { tag: "REBALANCE", text: "Suggest a rebalance back to my targets" },
];

/* ── Tiny helpers ───────────────────────────────────────────────────────── */
function FinavaAvatar() {
  // Frost f4: bare accent mark — no solid plate behind the brand letter.
  return (
    <div
      className="w-[30px] h-[30px] rounded-[var(--radius-md)] flex items-center justify-center flex-shrink-0 text-[length:var(--text-title)] font-black"
      style={{ background: "transparent", color: "var(--color-accent)", fontFamily: "var(--font-serif)", letterSpacing: "0.04em" }}
    >
      L
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block rounded-full border-2 border-[var(--color-accent)] border-t-transparent flex-shrink-0"
      style={{ width: 12, height: 12, animation: "spin 0.9s linear infinite" }}
    />
  );
}

/* ── Agent activity panel ("Research crew") ─────────────────────────────── */
function AgentActivityPanel({ steps, ceoThinking, startedAt }: { steps: AgentStep[]; ceoThinking?: string; startedAt?: number | null }) {
  const [detailStep, setDetailStep] = useState<AgentStep | null>(null);
  const complete  = steps.filter((s) => s.status === "complete").length;
  const running   = steps.filter((s) => s.status === "running").length;
  const total     = steps.length;
  const isCompiling = ceoThinking === "Compiling all reports…";

  // Before any agent reports in, show the same Calm Orb "thinking" beat as
  // Simple chat — a gentle breathing wait while the crew is being deployed.
  if (!total) {
    return <TypingIndicator label="Assembling your research crew" startedAt={startedAt} />;
  }

  return (
    <>
      {detailStep && (
        <AgentDetailModal step={detailStep} onClose={() => setDetailStep(null)} />
      )}

      {/* Mobile compact bar */}
      <div className="frost-card flex sm:hidden items-center gap-3 px-4 py-3 rounded-[var(--radius-xl)] fade-in">
        <span className="flex gap-1 flex-shrink-0">
          {[0, 1, 2].map((i) => (
            <span key={i} className="typing-dot inline-block w-[5px] h-[5px] rounded-full" style={{ background: "var(--color-accent)", animationDelay: `${i * 160}ms` }} />
          ))}
        </span>
        <span className="flex-1 text-[length:var(--text-sm)] text-[var(--color-text-secondary)]">
          {running > 0 ? `${running} agent${running > 1 ? "s" : ""} analyzing…` : `${complete} of ${total} complete`}
        </span>
        <div className="rounded-full overflow-hidden flex-shrink-0" style={{ width: 60, height: 3, background: "var(--color-surface-2)" }}>
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(complete / total) * 100}%`, background: "var(--color-accent)" }} />
        </div>
      </div>

      {/* Desktop full panel */}
      <div className="hidden sm:flex gap-[14px]">
      <FinavaAvatar />
      <div className="flex-1 min-w-0 pt-0">
        <div className="frost-card rounded-[var(--radius-xl)] overflow-hidden fade-in">
          {/* Header — translucent strip, bare accent crew mark (Frost f4) */}
          <div
            className="frost-strip frost-hairline flex items-center gap-3 px-[14px] py-[11px]"
            style={{ borderBottom: "1px solid" }}
          >
            <div
              className="w-[24px] h-[24px] flex items-center justify-center flex-shrink-0"
              style={{ color: "var(--color-accent)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div className="flex flex-col gap-[1px]">
              <span className="text-[length:var(--text-sm)] font-semibold text-[var(--color-text)]">Research crew</span>
              <span className="text-[length:var(--text-meta)] text-[var(--color-muted)]">
                {running > 0
                  ? `${running} analyzing · ${complete} complete`
                  : `${complete} of ${total} complete`}
              </span>
            </div>
            {/* Progress meter */}
            <div className="ml-auto flex items-center gap-[10px]">
              <LiveElapsed startedAt={startedAt ?? null} className="text-[length:var(--text-meta)] text-[var(--color-muted)]" />
              <span className="text-[length:var(--text-meta)] font-semibold text-[var(--color-text-secondary)] tabular-nums">
                {complete}/{total}
              </span>
              <div
                className="rounded-full overflow-hidden"
                style={{ width: 80, height: 4, background: "color-mix(in oklab, var(--color-text) 10%, transparent)" }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${(complete / total) * 100}%`,
                    background: "linear-gradient(90deg, color-mix(in oklab, var(--color-accent) 70%, var(--color-bg)), var(--color-accent))",
                  }}
                />
              </div>
            </div>
          </div>

          {/* Agent rows */}
          <div>
            {steps.map((step) => {
                const isSkeptic = step.agent === "skeptic_review";
                const label = isSkeptic ? "Skeptic Review" : (AGENT_LABELS[step.agent] ?? step.agent);
                const focus = AGENT_FOCUS[step.agent] ?? "";

                return (
                  <div
                    key={step.agent}
                    className="flex items-center gap-3 px-[14px] py-[9px] transition-colors duration-300"
                    style={{
                      borderBottom: "1px solid color-mix(in oklab, var(--color-text) 7%, transparent)",
                      borderTop: isSkeptic ? "1px solid color-mix(in oklab, var(--color-warn) 30%, transparent)" : undefined,
                      // Frost: the analyzing row lifts gently off the glass.
                      ...(step.status === "running"
                        ? {
                            background: "color-mix(in oklab, var(--color-bg) 60%, transparent)",
                            borderRadius: "var(--radius-md)",
                            boxShadow: "var(--shadow-card)",
                          }
                        : {}),
                    }}
                  >
                    {/* Status icon */}
                    <div className="flex justify-center" style={{ width: 16 }}>
                      {step.status === "complete" && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-bull)" strokeWidth="2.5" strokeLinecap="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                      {step.status === "running" && <Spinner />}
                      {step.status === "error" && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-bear)" strokeWidth="2.5" strokeLinecap="round">
                          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                      )}
                      {step.status === "pending" && (
                        <span
                          className="inline-block rounded-full"
                          style={{ width: 8, height: 8, border: "1.5px solid var(--color-border-strong)" }}
                        />
                      )}
                    </div>

                    {/* Name + focus */}
                    <div className="flex-1 min-w-0 flex items-baseline gap-2">
                      <span
                        className="text-[length:var(--text-sm)] font-semibold inline-flex items-center gap-1"
                        style={{ color: step.status === "pending" ? "var(--color-muted)" : "var(--color-text)" }}
                      >
                        {isSkeptic && (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
                            <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                          </svg>
                        )}
                        {label}
                      </span>
                      {focus && (
                        <span className="text-[length:var(--text-meta)] text-[var(--color-muted)] truncate">{focus}</span>
                      )}
                    </div>

                    {/* Model badge — lights up while this agent runs */}
                    {step.models && step.models.length > 0 && (
                      <ModelBadge
                        brands={step.models}
                        size={11}
                        showLabel
                        lit={step.status === "running"}
                        dim={step.status === "pending"}
                      />
                    )}

                    {/* Status badge / view full button */}
                    {(step.status === "complete" || step.status === "error") && step.result ? (
                      <button
                        onClick={() => setDetailStep(step)}
                        className="text-[length:var(--text-micro)] font-semibold uppercase tracking-[0.1em] flex-shrink-0 px-[7px] py-[3px] rounded-[var(--radius-xs)] transition-colors duration-100"
                        style={{ background: "var(--color-accent-light)", color: "var(--color-accent)", border: "none", cursor: "pointer", fontFamily: "inherit" }}
                      >
                        View
                      </button>
                    ) : (
                      <span
                        className="text-[length:var(--text-micro)] font-semibold uppercase tracking-[0.16em] flex-shrink-0"
                        style={{
                          color:
                            step.status === "complete" ? "var(--color-bull)"
                            : step.status === "running" ? "var(--color-accent)"
                            : step.status === "error" ? "var(--color-bear)"
                            : "var(--color-muted)",
                        }}
                      >
                        {step.status === "complete" ? "complete"
                          : step.status === "running" ? "analyzing"
                          : step.status === "error" ? "error"
                          : "queued"}
                      </span>
                    )}
                  </div>
                );
              })}
          </div>

          {/* Footer: compiling / synthesizing */}
          {(isCompiling || (total > 0 && running > 0)) && (
            <div
              className="frost-strip frost-hairline px-[14px] py-[10px] flex items-center gap-2"
              style={{ borderTop: "1px solid" }}
            >
              <span className="ticker-bars flex-shrink-0 text-[var(--color-accent)]" role="img" aria-label="Analyzing">
                <i></i><i></i><i></i><i></i>
              </span>
              <span className="text-[length:var(--text-meta)] italic text-[var(--color-text-secondary)] ml-1">
                {isCompiling ? "CEO is synthesizing findings…" : "Agents running in parallel…"}
              </span>
            </div>
          )}
        </div>
      </div>
      </div>
    </>
  );
}

/** One-line focus blurb shown next to each agent name */
const AGENT_FOCUS: Record<string, string> = {
  run_risk_agent:        "Beta, drawdown, correlation",
  run_news_agent:        "Last 72h material headlines",
  run_macro_agent:       "Rates, FX, growth backdrop",
  run_technical_agent:   "Trend, support, momentum",
  run_dcf_agent:         "Intrinsic value range",
  run_earnings_agent:    "EPS trends, upcoming catalysts",
  run_insider_agent:     "Form-4 activity & exec changes",
  run_sentiment_agent:   "Social, news flow, options skew",
  run_competitor_agent:  "Peer comparison",
  run_options_agent:     "Options flow, put/call ratio",
  run_comparables_agent: "Peer multiples & relative value",
  run_graham_agent:      "Benjamin Graham scorecard",
  run_analyst_agent:     "Wall Street price targets",
  run_hype_agent:        "Reddit, X, YouTube momentum",
  run_fundamentals_agent:"Revenue, margins, FCF trends",
  skeptic_review:        "Stress-test the thesis",
};

/* ── Market Pulse strip ──────────────────────────────────────────────────── */
function MarketPulse() {
  const { items, isLoading } = useMarketPulse();
  const market = usMarketStatus();

  return (
    <div
      className="rounded-[var(--radius-md)] px-[16px] py-[12px] mb-6"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-[10px]">
        <span className="eyebrow-label text-[var(--color-muted)]">
          Market Pulse
        </span>
        <span className="flex items-center gap-1.5 text-[length:var(--text-meta)] text-[var(--color-muted)]">
          <span
            className="status-dot inline-block w-[6px] h-[6px] rounded-full"
            style={{
              ["--status-dot-color" as string]: market.open ? "var(--color-bull)" : "var(--color-bear)",
            }}
          />
          {isLoading ? "Loading…" : market.label}
        </span>
      </div>

      {/* Ticker grid — 3 cols on mobile (two tidy rows), 6 across at md+ */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-x-[14px] gap-y-[14px]">
        {items.map((item) => {
          const up = item.chg >= 0;
          return (
            <div key={item.ticker} className="min-w-0">
              <p
                className="flex items-baseline gap-1 text-[length:var(--text-micro)] font-semibold uppercase tracking-[0.16em] mb-1 whitespace-nowrap"
                style={{ color: "var(--color-muted)" }}
              >
                {item.label}
                <span className="text-[length:var(--text-micro)] tracking-[0.08em] opacity-70">{item.ticker}</span>
              </p>
              <p
                className="text-[length:var(--text-title)] font-semibold leading-[1.1] tabular-nums"
                style={{ color: "var(--color-text)" }}
              >
                {isLoading ? (
                  <span className="skeleton inline-block h-[15px] w-16" />
                ) : (
                  item.value
                )}
              </p>
              {!isLoading && item.chg !== 0 && (
                <p
                  className="text-[length:var(--text-meta)] font-semibold mt-[2px] tabular-nums"
                  style={{ color: up ? "var(--color-bull)" : "var(--color-bear)" }}
                >
                  {up ? "+" : ""}{item.chg.toFixed(2)}%
                </p>
              )}
              {isLoading && (
                <span className="skeleton inline-block h-[11px] w-10 mt-1" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Empty state ─────────────────────────────────────────────────────────── */
function EmptyState({ onSuggestion }: { onSuggestion?: (text: string) => void }) {
  // User response templates (Settings → Templates) surface here — picking one
  // attaches it to the next message as a composer chip (shapes how Finava replies).
  const { data: templates } = useSWR<Template[]>("/api/playbooks", authFetcher);
  // The portfolio prompts all assume positions; on an empty account they would
  // just answer "you have none". Pick the set that can actually be answered.
  const { holdings } = usePortfolio();
  const hasBook = holdings.length > 0;
  const suggestions = hasBook ? PORTFOLIO_SUGGESTIONS : STARTER_SUGGESTIONS;
  const setActiveTemplate = useChatStore((s) => s.setActiveTemplate);
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable both-edges" }}>
      <div className="max-w-[720px] mx-auto px-4 pt-8 pb-[var(--content-pad-bottom)]">
        {/* Greeting headline */}
        <div className="mb-6">
          <p
            className="text-[length:var(--text-sm)] italic mb-1.5"
            style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}
          >
            {greeting}
          </p>
          <h2
            className="m-0 text-[length:var(--text-stat)] font-bold leading-[1.1] text-[var(--color-text)]"
            style={{ fontFamily: "var(--font-serif)", letterSpacing: "-0.015em" }}
          >
            What would you like<br />to research today?
          </h2>
          <p className="mt-2.5 text-[length:var(--text-sm)] text-[var(--color-muted)]">
            {hasBook
              ? "Fresh conversation — start typing below, or pick a prompt to begin."
              : "Ask about any stock, or pick a prompt below to see what Finava does."}
          </p>
        </div>

        <MarketPulse />

        {/* Templates — picking one rides on the next message as a chip */}
        {Array.isArray(templates) && templates.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-2.5">
              <span className="eyebrow-label text-[var(--color-muted)]">
                Templates
              </span>
              <span className="text-[length:var(--text-meta)] text-[var(--color-muted)]">Shape how Finava responds</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-[10px]">
              {templates.slice(0, 4).map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => setActiveTemplate({ id: tpl.id, title: tpl.title })}
                  className="followup-chip text-left px-[16px] py-[14px] rounded-[var(--radius-lg)] flex gap-[10px] items-start transition-all duration-120 group"
                  style={{ fontSize: "var(--text-sm)", lineHeight: 1.4 }}
                >
                  <span
                    className="flex-shrink-0 mt-[1px]"
                    style={{ color: "var(--color-accent)" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                    </svg>
                  </span>
                  <span className="flex-1 truncate">{tpl.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Suggestion tiles */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-2.5">
            <span className="eyebrow-label text-[var(--color-muted)]">
              Starter prompts
            </span>
            <span className="text-[length:var(--text-meta)] text-[var(--color-muted)]">
              {hasBook ? "Tailored to your book · scroll for more" : "Pick one to see how Finava works"}
            </span>
          </div>
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-[10px] overflow-y-auto pr-1"
            style={{
              maxHeight: "232px",
              scrollbarGutter: "stable",
              maskImage: "linear-gradient(to bottom, black calc(100% - 28px), transparent 100%)",
              WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 28px), transparent 100%)",
            }}
          >
            {suggestions.map((s) => (
              <button
                key={s.text}
                onClick={() => onSuggestion?.(s.text)}
                className="followup-chip text-left px-[16px] py-[14px] rounded-[var(--radius-lg)] flex gap-[10px] items-start transition-all duration-120 group"
                style={{
                  fontSize: "var(--text-sm)",
                  lineHeight: 1.4,
                }}
              >
                <span
                  className="flex-shrink-0 text-[length:var(--text-micro)] font-semibold uppercase tracking-[0.14em] px-[7px] py-[3px] rounded-[var(--radius-xs)] mt-[1px]"
                  style={{ background: "var(--color-accent-light)", color: "var(--color-accent)" }}
                >
                  {s.tag}
                </span>
                <span className="flex-1">{s.text}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Main MessageList ─────────────────────────────────────────────────────── */
interface Props {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamStartedAt?: number | null;
  streamingContent: string;
  mode: ChatMode;
  onSuggestion?: (text: string) => void;
  onDiscoverDeeper?: (query: string) => void;
  agentSteps?: AgentStep[];
  ceoThinking?: string;
}

export default function MessageList({
  messages,
  isStreaming,
  streamStartedAt = null,
  streamingContent,
  mode,
  onSuggestion,
  onDiscoverDeeper,
  agentSteps = [],
  ceoThinking,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // In Auto mode the live mode stays "auto" while a routed agent run streams, so
  // surface the crew panel whenever the router has actually deployed agents.
  const showAgentActivity =
    (mode === "agent" || mode === "deep_research" || (mode === "auto" && agentSteps.length > 0)) &&
    isStreaming && !streamingContent;
  const showStreaming = isStreaming && !!streamingContent;

  // Smoothly paced reveal of the streaming text (decoupled from SSE bursts).
  const revealed = useSmoothStream(streamingContent, isStreaming);

  useEffect(() => {
    const node = bottomRef.current;
    if (!node) return;
    // Only pin to the bottom if the user is already there — and during the
    // high-frequency streaming reveal use instant scroll, so smooth-scroll
    // animations don't stack and stutter on every frame.
    const scroller = node.closest(".overflow-y-auto");
    const nearBottom =
      !scroller ||
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (nearBottom) {
      node.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
    }
  }, [messages.length, revealed, agentSteps.length, ceoThinking, isStreaming]);

  /* Empty state */
  if (!messages.length && !isStreaming) {
    return <EmptyState onSuggestion={onSuggestion} />;
  }

  return (
    <div className="flex-1 overflow-y-auto print-transcript" style={{ scrollbarGutter: "stable both-edges" }}>
      <div className="mx-auto max-w-[720px] px-4 pt-8 pb-[var(--content-pad-bottom)] flex flex-col gap-7">
        {messages.map((msg) => (
          <Message key={msg.id} message={msg} onSuggestion={onSuggestion} onDiscoverDeeper={onDiscoverDeeper} />
        ))}

        {/* Agent activity panel */}
        {showAgentActivity && (
          <AgentActivityPanel steps={agentSteps} ceoThinking={ceoThinking} startedAt={streamStartedAt} />
        )}

        {/* Streaming response — Claude-style word-by-word fade + steady pacing */}
        {showStreaming && (
          <div className="flex gap-[14px]">
            <FinavaAvatar />
            <div className="flex-1 min-w-0 pt-1">
              <StreamingMarkdown content={revealed} />
            </div>
          </div>
        )}

        {/* Simple mode waiting — Calm Orb thinking indicator */}
        {mode === "simple" && isStreaming && !streamingContent && (
          <TypingIndicator label="Thinking it through" startedAt={streamStartedAt} />
        )}

        {/* Auto mode waiting — router deciding, or a routed simple/discover run
            before its first token (the agent panel handles the agent case above). */}
        {mode === "auto" && isStreaming && !streamingContent && agentSteps.length === 0 && (
          <TypingIndicator label={ceoThinking || "Thinking it through"} startedAt={streamStartedAt} />
        )}

        {/* Discover mode waiting — teal "scanning the market" state */}
        {mode === "discover" && isStreaming && !streamingContent && (
          <TypingIndicator
            label={ceoThinking || "Scanning the S&P 500…"}
            startedAt={streamStartedAt}
            accent="var(--color-discover)"
            scanning
          />
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
