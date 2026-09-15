"use client";
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

  const onSuggestion = (text: string) =>
    enqueueSend({ convId: conversationId, text, mode, context: null, kind: "send" });
  const onDiscoverDeeper = (query: string) =>
    enqueueSend({ convId: conversationId, text: query, mode, context: null, kind: "deepen" });

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
      />
    </div>
  );
}
