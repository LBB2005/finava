"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSmoothStream } from "@/hooks/useSmoothStream";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import Message from "./Message";
import TypingIndicator from "./TypingIndicator";
import type { ChatMessage, ChatMode, AgentStep, Template } from "@/types/chat";
import { useChatStore } from "@/stores/chatStore";
import { useMarketPulse } from "@/hooks/useMarketPulse";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usMarketStatus } from "@/lib/marketHours";
import useSWR from "swr";
import { authFetcher } from "@/lib/authFetch";
import CrewProgress from "./answer/CrewProgress";
import ExperienceQuestion from "./answer/ExperienceQuestion";
import { useExperienceLevel } from "@/hooks/useExperienceLevel";
import { crewStatusNote, crewSummary, type BudgetWarning } from "@/lib/chat/crewProgress";
import { buildLiveMessage, committedDuringStream, handoffKeys } from "@/lib/chat/liveMessage";

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
  // First run only: one question, then never again.
  const { answered, loading: levelLoading, mutate: refreshLevel } = useExperienceLevel();
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

        {!levelLoading && !answered && <ExperienceQuestion onAnswered={refreshLevel} />}

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
  /** From W2-2's `crew_plan` event — the run's own time estimate, when sent. */
  crewPlanSeconds?: number;
  /** From W2-2's `budget_warning` event. */
  budgetWarning?: BudgetWarning | null;
  /** Re-run a fast answer with the full crew (wired by W2-2). */
  onRunFullAnalysis?: (message: ChatMessage) => void;
  runFullAnalysisLabel?: string | null;
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
  crewPlanSeconds,
  budgetWarning,
  onRunFullAnalysis,
  runFullAnalysisLabel,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const conversationId = useChatStore((s) => s.conversationId);
  const hasTranscript = messages.length > 0 || isStreaming;
  const { following, unseen, follow } = useStickToBottom(scrollerRef, contentRef, {
    resetKey: conversationId,
    enabled: hasTranscript,
  });

  // Sending a message means "show me the answer": follow again.
  const lastUserId = useMemo(() => [...messages].reverse().find((m) => m.role === "user")?.id, [messages]);
  useEffect(() => {
    if (lastUserId) follow();
  }, [lastUserId, follow]);

  // In Auto mode the live mode stays "auto" while a routed agent run streams, so
  // surface the crew panel whenever the router has actually deployed agents.
  const showAgentActivity =
    (mode === "agent" || mode === "deep_research" || (mode === "auto" && agentSteps.length > 0)) &&
    isStreaming && !streamingContent;
  const crewDone = crewSummary(agentSteps).done;

  // Smoothly paced reveal of the streaming text (decoupled from SSE bursts).
  const revealed = useSmoothStream(streamingContent, isStreaming);

  // The streaming answer renders through Message, as the message it will become,
  // and hands its key to that message when it is committed: the end of the
  // stream updates the element in place instead of swapping it.
  const [aliases] = useState(() => new Map<string, string>());
  const liveKey = isStreaming && streamStartedAt != null ? `live:${streamStartedAt}` : null;
  const keys = handoffKeys(messages, { liveKey, liveContent: streamingContent, streamStartedAt, aliases });
  const committed = committedDuringStream(messages, streamStartedAt, streamingContent);
  const showLive = isStreaming && !!streamingContent && !committed;
  // Text that streams on after a commit in the same run needs a slot of its own.
  const liveSlot = liveKey && keys.includes(liveKey) ? `${liveKey}:more` : liveKey;
  const liveMessage = useMemo(
    () => buildLiveMessage({ content: revealed, uiMode: mode, steps: agentSteps, startedAt: streamStartedAt }),
    [revealed, mode, agentSteps, streamStartedAt]
  );

  /* Empty state */
  if (!messages.length && !isStreaming) {
    return <EmptyState onSuggestion={onSuggestion} />;
  }

  const items = messages.map((msg, i) => (
    <Message
      key={keys[i]}
      message={msg}
      onSuggestion={onSuggestion}
      onDiscoverDeeper={onDiscoverDeeper}
      onRunFullAnalysis={onRunFullAnalysis}
      runFullAnalysisLabel={runFullAnalysisLabel}
    />
  ));
  if (showLive && liveSlot) items.push(<Message key={liveSlot} message={liveMessage} streaming />);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto print-transcript" style={{ scrollbarGutter: "stable both-edges" }}>
        <div ref={contentRef} className="mx-auto max-w-[720px] px-4 pt-8 pb-[var(--content-pad-bottom)] flex flex-col gap-7">
          {items}

          {/* Crew progress — chips per analyst plus an ETA that re-estimates from
              the pace, so nobody waits behind a spinner with no number. Its note
              is one status line, never the CEO's draft report. */}
          {showAgentActivity && agentSteps.length > 0 && (
            <CrewProgress
              steps={agentSteps}
              startedAt={streamStartedAt}
              plannedSeconds={crewPlanSeconds}
              budgetWarning={budgetWarning}
              note={crewStatusNote(ceoThinking, { done: crewDone })}
            />
          )}
          {/* Before any analyst reports there is nothing to count — say what is
              actually happening, not "Assembling your research crew". */}
          {showAgentActivity && agentSteps.length === 0 && (
            <TypingIndicator
              label={crewStatusNote(ceoThinking, { done: false }) || "Planning which analysts to run"}
              startedAt={streamStartedAt}
            />
          )}

          {/* Fast/Quick lane waiting — Calm Orb thinking indicator */}
          {(mode === "simple" || mode === "fast") && isStreaming && !streamingContent && (
            <TypingIndicator label="Thinking it through" startedAt={streamStartedAt} />
          )}

          {/* Auto mode waiting — router deciding, or a routed simple/discover run
              before its first token (the agent panel handles the agent case above). */}
          {mode === "auto" && isStreaming && !streamingContent && agentSteps.length === 0 && (
            <TypingIndicator
              label={crewStatusNote(ceoThinking, { done: false }) || "Thinking it through"}
              startedAt={streamStartedAt}
            />
          )}

          {/* Discover mode waiting — teal "scanning the market" state */}
          {mode === "discover" && isStreaming && !streamingContent && (
            <TypingIndicator
              label={crewStatusNote(ceoThinking, { done: false }) || "Scanning the S&P 500…"}
              startedAt={streamStartedAt}
              accent="var(--color-discover)"
              scanning
            />
          )}
        </div>
      </div>

      {/* The reader scrolled up while the answer kept coming: say so, don't drag them back. */}
      {!following && (isStreaming || unseen) && <JumpToLatest onClick={follow} />}
    </div>
  );
}

function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="std-focus fade-in fade-in-still followup-chip"
      style={{
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        // Just above the floating composer, which the transcript pads for.
        bottom: "calc(var(--content-pad-bottom) - 12px)",
        zIndex: 10,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: "var(--text-meta)",
        fontWeight: 600,
        fontFamily: "inherit",
        cursor: "pointer",
        boxShadow: "var(--shadow-pop)",
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" />
        <polyline points="19 12 12 19 5 12" />
      </svg>
      Jump to latest
    </button>
  );
}
