import { Suspense } from "react";
import { notFound } from "next/navigation";
import ReplayBench from "./ReplayBench";

/**
 * Chat replay bench: replays a recorded SSE turn through the real chat client
 * (ChatEngine → stream reader → store → MessageList) at the recorded pace, and
 * measures jank, scroll jumps and layout shift. Dev only, like the dev-auth bypass.
 *
 *   /dev/chat-replay?fixture=recorded-agent-verdict-then-escalate-3&speed=1&reader=trackpad&autostart=1
 */
export default function ChatReplayPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    // useSearchParams needs a Suspense boundary so the page can still prerender.
    <Suspense fallback={null}>
      <ReplayBench />
    </Suspense>
  );
}
