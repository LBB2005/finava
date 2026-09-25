"use client";
import { useCallback } from "react";
import { useChatStore } from "@/stores/chatStore";
import ChatHeader from "./ChatHeader";
import MessageList from "./MessageList";
import type { ChatMessage, AgentStep } from "@/types/chat";

// Stable empty references so selectors don't return fresh objects each render.
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_STEPS: AgentStep[] = [];

// The computed portfolio table (weights, cost basis, P&L) lives in a pure module
// so it is unit-tested; re-exported here because ChatEngine imports it from this file.
export { buildPortfolioContext } from "@/lib/portfolioContext";

/**
 * Presentational chat view. The streaming engine lives in <ChatEngine /> (mounted
 * in the app shell); this component just renders the VIEWED conversation's slice
 * + messages and routes user actions into the engine's send queue.
 */
export default function ChatContainer() {
  const mode = useChatStore((s) => s.mode);
  const conversationId = useChatStore((s) => s.conversationId);
  const enqueueSend = useChatStore((s) => s.enqueueSend);

  const messages = useChatStore((s) => (s.conversationId ? s.messagesByConv[s.conversationId] : undefined)) ?? EMPTY_MESSAGES;
  const isStreaming = useChatStore((s) => (s.conversationId ? s.streamsByConv[s.conversationId]?.isStreaming : false)) ?? false;
  const streamStartedAt = useChatStore((s) => (s.conversationId ? s.streamsByConv[s.conversationId]?.streamStartedAt : null)) ?? null;
  const streamingContent = useChatStore((s) => (s.conversationId ? s.streamsByConv[s.conversationId]?.streamingContent : "")) ?? "";
  const agentSteps = useChatStore((s) => (s.conversationId ? s.streamsByConv[s.conversationId]?.agentSteps : undefined)) ?? EMPTY_STEPS;
  const ceoThinking = useChatStore((s) => (s.conversationId ? s.streamsByConv[s.conversationId]?.ceoThinking : "")) ?? "";
  const crewProgress = useChatStore((s) => (s.conversationId ? s.streamsByConv[s.conversationId]?.crewProgress : null)) ?? null;

  // Stable callbacks: messages are memoised, and a fresh function on every
  // streamed chunk would re-render the whole transcript anyway.
  const onSuggestion = useCallback(
    (text: string) => enqueueSend({ convId: conversationId, text, mode, context: null, kind: "send" }),
    [enqueueSend, conversationId, mode]
  );
  const onDiscoverDeeper = useCallback(
    (query: string) => enqueueSend({ convId: conversationId, text: query, mode, context: null, kind: "deepen" }),
    [enqueueSend, conversationId, mode]
  );
  // "Run full analysis" under a fast answer: re-ask the question that answer was
  // about, this time with the crew. The engine falls back to the conversation's
  // last question if we can't find the turn this answer replied to.
  const onRunFullAnalysis = useCallback(
    (message: ChatMessage) => {
      const idx = messages.findIndex((m) => m.id === message.id);
      const question = [...messages.slice(0, idx < 0 ? messages.length : idx)]
        .reverse()
        .find((m) => m.role === "user")?.content ?? "";
      enqueueSend({ convId: conversationId, text: question, mode, context: null, kind: "full_analysis" });
    },
    [enqueueSend, conversationId, mode, messages]
  );

  // The crew announces its own ETA and says when it is against its budget; both
  // belong on screen rather than behind a spinner.
  const budgetWarning =
    crewProgress?.budgetRemainingSeconds != null
      ? { message: "Time budget reached — writing the report from what finished.", kind: "time" as const }
      : null;

  return (
    <div className="flex flex-col h-full">
      <ChatHeader mode={mode} />

      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        streamStartedAt={streamStartedAt}
        streamingContent={streamingContent}
        mode={mode}
        onSuggestion={onSuggestion}
        onDiscoverDeeper={onDiscoverDeeper}
        agentSteps={agentSteps}
        ceoThinking={ceoThinking}
        crewPlanSeconds={crewProgress?.etaSeconds}
        budgetWarning={budgetWarning}
        onRunFullAnalysis={onRunFullAnalysis}
      />
    </div>
  );
}
