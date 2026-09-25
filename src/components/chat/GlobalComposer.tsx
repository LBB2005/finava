"use client";
import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useChatStore } from "@/stores/chatStore";
import { useWatchlists } from "@/hooks/useWatchlists";
import { useWatchlistStore } from "@/stores/watchlistStore";
import { contextFromPath } from "@/lib/chatContext";
import ChatInput from "./ChatInput";
import ClarifyPanel from "./ClarifyPanel";
import { stopConversationStream } from "./ChatEngine";
import { pendingClarifyOf, replyContent, type ClarifyReply } from "@/lib/chat/clarify";

// One persistent composer for the whole app. Lives in the app shell, outside the
// route-keyed <main>, so it never unmounts as you move between pages. On /chat it
// feeds the live conversation via pendingMessage; elsewhere it primes the page
// context and routes to /chat so the new chat is tagged where it started.
export default function GlobalComposer() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { mode, setMode, setPendingMessage, setPendingContext, setPendingPageContext } = useChatStore();
  const { watchlists } = useWatchlists();
  const { activeId } = useWatchlistStore();

  const isChat = pathname.startsWith("/chat");
  const conversationId = useChatStore((s) => s.conversationId);
  // Disabled only while the VIEWED conversation is streaming — a new chat (no
  // conversationId) is always sendable, so you can start a second chat while the
  // first is still generating.
  const viewedStreaming = useChatStore((s) =>
    s.conversationId ? (s.streamsByConv[s.conversationId]?.isStreaming ?? false) : false
  );
  // Pull focus to the composer when landing on a blank chat (e.g. after "New
  // chat"), so the user can start typing immediately.
  const focusOnFreshChat = isChat && conversationId === null && !viewedStreaming;

  // Finava asked before answering: the questions take the composer's place
  // until they're answered or skipped.
  const viewedMessages = useChatStore((s) => (s.conversationId ? s.messagesByConv[s.conversationId] : undefined));
  const pendingClarify = useMemo(
    () => (isChat && !viewedStreaming && viewedMessages ? pendingClarifyOf(viewedMessages) : null),
    [isChat, viewedStreaming, viewedMessages]
  );

  function handleClarify(reply: ClarifyReply) {
    if (!pendingClarify || !conversationId) return;
    useChatStore.getState().enqueueSend({
      convId: conversationId,
      text: replyContent(reply),
      // Answer through the lane that asked (Auto or Discover), whatever the pill says.
      mode: pendingClarify.mode,
      context: null,
      kind: "send",
      clarifyReply: reply,
    });
  }

  function handleSend(text: string) {
    const val = text.trim();
    if (!val) return;
    let msg = val;
    if (pathname.startsWith("/watchlist")) {
      const active = watchlists.find((w) => w.id === activeId) ?? watchlists[0];
      msg = `Re: my ${active?.name ?? "watchlist"} watchlist — ${val}`;
    }
    setPendingContext(contextFromPath(pathname));
    // Capture the viewed page's snapshot NOW, while the page is still mounted —
    // routing to /chat unmounts it and clears activePageContext. When off-page
    // (activePageContext null) don't clobber a context a launcher may have primed;
    // a plain follow-up simply falls back to what the conversation remembers.
    const active = useChatStore.getState().activePageContext;
    if (active) setPendingPageContext(active);
    setPendingMessage(msg);
    if (!isChat) router.push("/chat");
  }

  return (
    <div className="absolute left-0 right-0 z-30 pointer-events-none" style={{ bottom: 6 }}>
      {pendingClarify ? (
        <ClarifyPanel key={pendingClarify.messageId} questions={pendingClarify.questions} onSubmit={handleClarify} />
      ) : (
        <ChatInput
          floating
          onSend={handleSend}
          disabled={isChat && viewedStreaming}
          streaming={isChat && viewedStreaming}
          onStop={() => { if (conversationId) stopConversationStream(conversationId); }}
          mode={mode}
          onModeChange={setMode}
          autoFocus={focusOnFreshChat}
        />
      )}
    </div>
  );
}
