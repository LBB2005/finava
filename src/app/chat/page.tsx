import { Suspense } from "react";
import ChatContainer from "@/components/chat/ChatContainer";
import ConversationUrlSync from "./ConversationUrlSync";

export default function ChatPage() {
  return (
    <>
      {/* useSearchParams needs a Suspense boundary so the page can still prerender. */}
      <Suspense fallback={null}>
        <ConversationUrlSync />
      </Suspense>
      <ChatContainer />
    </>
  );
}
