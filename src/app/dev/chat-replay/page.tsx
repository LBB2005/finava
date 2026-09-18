import { Suspense } from "react";
import { notFound } from "next/navigation";

/**
 * Chat replay bench: replays a recorded SSE turn through the real chat client
 * (ChatEngine → stream reader → store → MessageList) at the recorded pace, and
 * measures jank, scroll jumps and layout shift. Dev only, like the dev-auth bypass.
 *
 *   /dev/chat-replay?fixture=recorded-agent-verdict-then-escalate-3&speed=1&reader=trackpad&autostart=1
 */
export default async function ChatReplayPage() {
  // The import sits inside a branch the production build knows is dead, so the
  // bench's code isn't bundled into production at all. Production gets Next's
  // not-found page (noindex; HTTP 200 because the app streams, as /stock/<bad> does).
  if (process.env.NODE_ENV !== "production") {
    const { default: ReplayBench } = await import("./ReplayBench");
    return (
      // useSearchParams needs a Suspense boundary.
      <Suspense fallback={null}>
        <ReplayBench />
      </Suspense>
    );
  }
  notFound();
}
