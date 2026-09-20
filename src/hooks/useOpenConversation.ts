"use client";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { useChatStore } from "@/stores/chatStore";
import { authFetch } from "@/lib/authFetch";
import type { Conversation } from "@/components/layout/ConversationList";
import { fromStoredMessage } from "@/lib/chat/storedMessage";
import { chatHref } from "@/lib/chat/conversationUrl";

function toStoreMessages(messages: Conversation["messages"]) {
  return messages.map(fromStoredMessage);
}

/** Load a stored conversation into the chat store and (by default) open /chat.
 *  Shared by ConversationList and ChatContextButton so the store-reconciliation
 *  logic lives in exactly one place.
 *
 *  The conversations list API only carries a short message preview, so the
 *  preview is shown immediately and the full transcript is fetched in the
 *  background and swapped in once it lands. */
export function useOpenConversation() {
  const router = useRouter();
  const { setMessages, setConversationId, setPageContextForConv } = useChatStore();

  return function openConversation(conv: Conversation, opts?: { navigate?: boolean }) {
    // Each conversation keeps its own slice + messages keyed by id, so viewing
    // one is just pointing conversationId at it — no streaming state to juggle.
    // Don't clobber a list/preview over messages a live stream is building.
    const state = useChatStore.getState();
    const slice = state.streamsByConv[conv.id];
    if (!slice?.isStreaming) {
      setMessages(conv.id, toStoreMessages(conv.messages));
    }
    // Rehydrate the page context so a follow-up typed on /chat keeps the ticker+
    // data scope even across a reload (in-memory pageContextByConv is gone then).
    if (conv.pageContext) setPageContextForConv(conv.id, conv.pageContext);
    setConversationId(conv.id);

    void (async () => {
      try {
        const res = await authFetch(`/api/conversations/${conv.id}`);
        if (!res.ok) return;
        const full: Conversation = await res.json();
        // Only swap in the full transcript if this conversation isn't mid-stream
        // (a stream owns its own message list and commits on completion).
        if (!useChatStore.getState().streamsByConv[conv.id]?.isStreaming) {
          setMessages(conv.id, toStoreMessages(full.messages ?? []));
        }

        // Backfill an auto-title for older chats that predate auto-titling: no
        // title yet but a complete user↔assistant exchange exists. Fire-and-forget,
        // then revalidate the recents list so the clean title appears.
        const msgs = full.messages ?? [];
        const hasTitle = typeof full.title === "string" && full.title.trim().length > 0;
        const hasExchange =
          msgs.some((m) => m.role === "user") && msgs.some((m) => m.role === "assistant");
        if (!hasTitle && hasExchange) {
          authFetch(`/api/conversations/${conv.id}/title`, { method: "POST" })
            .then(() => mutate("/api/conversations"))
            .catch(() => { /* best-effort; raw-prompt fallback stays */ });
        }
      } catch { /* preview already shown; background refresh is best-effort */ }
    })();

    // Already on /chat, ConversationUrlSync writes ?c= itself; pushing here too
    // would leave a duplicate history entry.
    if (opts?.navigate !== false && window.location.pathname !== "/chat") router.push(chatHref(conv.id));
  };
}

/** View a conversation known only by id (reload, back/forward, a shared /chat?c= link).
 *  Resolves false when it doesn't exist or can't be loaded. */
export async function openConversationById(id: string): Promise<boolean> {
  const { setMessages, setConversationId, setPageContextForConv } = useChatStore.getState();
  setConversationId(id);
  try {
    const res = await authFetch(`/api/conversations/${encodeURIComponent(id)}`);
    if (!res.ok) return false;
    const full: Conversation = await res.json();
    if (!useChatStore.getState().streamsByConv[id]?.isStreaming) {
      setMessages(id, toStoreMessages(full.messages ?? []));
    }
    if (full.pageContext) setPageContextForConv(id, full.pageContext);
    return true;
  } catch {
    return false;
  }
}
