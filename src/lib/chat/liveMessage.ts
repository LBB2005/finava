import type { AgentStep, ChatMessage, ChatMode } from "@/types/chat";

/**
 * The streaming answer, rendered as the message it is about to become.
 *
 * The live answer used to be its own block (an avatar and StreamingMarkdown),
 * swapped for the committed `Message` when the stream ended: a different layout
 * for crew answers, a new footer, the avatar flipping from "L" to "F". Now the
 * list renders the stream through `Message` itself, with a stand-in message,
 * and hands its React key to the committed message, so the end of the stream
 * changes the text's props rather than the element.
 */

export const LIVE_ID = "streaming";

/** The mode the committed message will have, from what the UI knows mid-stream. */
export function liveAnswerMode(uiMode: ChatMode, crewSteps: number): ChatMode {
  if (uiMode === "deep_research") return "deep_research";
  if (uiMode === "agent" || (uiMode === "auto" && crewSteps > 0)) return "agent";
  if (uiMode === "auto") return "fast";
  return uiMode;
}

export function buildLiveMessage(a: {
  content: string;
  uiMode: ChatMode;
  steps: AgentStep[];
  startedAt: number | null;
}): ChatMessage {
  return {
    id: LIVE_ID,
    role: "assistant",
    content: a.content,
    mode: liveAnswerMode(a.uiMode, a.steps.length),
    createdAt: new Date(a.startedAt ?? Date.now()).toISOString(),
    agentTrace: a.steps.length ? a.steps : undefined,
  };
}

/**
 * `m` is the message this stream just committed: an answer newer than the
 * stream, holding the streamed text. (A deep Discover run commits a shortlist
 * and then streams a synthesis; that shortlist is not the live answer.)
 */
function committedHere(m: ChatMessage | undefined, streamStartedAt: number | null, liveContent: string): m is ChatMessage {
  return (
    !!m &&
    m.role === "assistant" &&
    streamStartedAt != null &&
    Date.parse(m.createdAt) >= streamStartedAt &&
    m.content === liveContent
  );
}

/**
 * The engine adds the finished message before it clears the stream (it awaits
 * the save in between), so for a moment both exist. Show the message, not both.
 */
export function committedDuringStream(messages: ChatMessage[], streamStartedAt: number | null, liveContent: string): boolean {
  return committedHere(messages[messages.length - 1], streamStartedAt, liveContent);
}

/**
 * React keys for the list. The message committed at the end of a stream takes
 * the live slot's key (and keeps it), so React updates that element in place:
 * nothing remounts, no fade replays, and the answer doesn't move.
 * `aliases` (message id → key) is the caller's to keep for the list's lifetime.
 */
export function handoffKeys(
  messages: ChatMessage[],
  o: { liveKey: string | null; liveContent: string; streamStartedAt: number | null; aliases: Map<string, string> }
): string[] {
  const last = messages[messages.length - 1];
  if (o.liveKey && committedHere(last, o.streamStartedAt, o.liveContent) && !o.aliases.has(last.id)) {
    const taken = [...o.aliases.values()].includes(o.liveKey);
    if (!taken) o.aliases.set(last.id, o.liveKey);
  }
  return messages.map((m) => o.aliases.get(m.id) ?? m.id);
}
