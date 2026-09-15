"use client";
import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useChatStore } from "@/stores/chatStore";
import { openConversationById } from "@/hooks/useOpenConversation";
import { onStoreConversationChange, onUrlConversationChange } from "@/lib/chat/conversationUrl";

/**
 * Keeps `/chat?c=<id>` and the viewed conversation in step. The URL wins on
 * load and on back/forward; in-app changes (a new chat getting its id, "New
 * chat") write the URL through the History API, which Next's router observes.
 */
export default function ConversationUrlSync() {
  const urlId = useSearchParams().get("c");
  const storeId = useChatStore((s) => s.conversationId);
  const urlRef = useRef<string | null | undefined>(undefined);
  const storeRef = useRef<string | null | undefined>(undefined);

  // URL → store (first render, reload, back/forward).
  useEffect(() => {
    if (urlRef.current === urlId) return;
    const firstRun = urlRef.current === undefined;
    urlRef.current = urlId;
    const current = useChatStore.getState().conversationId;
    // Landing on a bare /chat with a chat already in view (sent from another
    // page, or opened from the sidebar): the store wins and the URL catches up.
    if (firstRun && urlId === null) return;
    const action = onUrlConversationChange(urlId, current);
    storeRef.current = action.kind === "open" ? action.id : action.kind === "clear" ? null : current;
    if (action.kind === "open") {
      void openConversationById(action.id).then((ok) => {
        // A dead link: fall back to a fresh chat rather than an empty thread.
        if (!ok && useChatStore.getState().conversationId === action.id) {
          useChatStore.getState().setConversationId(null);
        }
      });
    } else if (action.kind === "clear") {
      useChatStore.getState().setConversationId(null);
    }
  }, [urlId]);

  // Store → URL (new chat got its id, sidebar "New chat", opened elsewhere).
  // Reads live values: the URL effect above may have just moved the store.
  useEffect(() => {
    const liveId = useChatStore.getState().conversationId;
    if (storeRef.current === liveId) return;
    storeRef.current = liveId;
    const liveUrlId = new URLSearchParams(window.location.search).get("c");
    const action = onStoreConversationChange(liveId, liveUrlId);
    if (action.kind !== "write") return;
    urlRef.current = liveId;
    if (action.replace) window.history.replaceState(null, "", action.href);
    else window.history.pushState(null, "", action.href);
  }, [storeId]);

  return null;
}
