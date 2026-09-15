import type { AgentEvent } from "@/types/chat";

/**
 * Fold one `final_response` event into the report text so far. The CEO streams
 * the report as deltas, so the default is to append. An event flagged
 * `replace: true` carries the whole report and resets what came before.
 */
export function applyFinalResponse(acc: string, event: { content: string; replace?: boolean }): string {
  return event.replace ? event.content : acc + event.content;
}

/** Read an SSE body and hand each `data:` payload to `onData`, in order. */
export async function readSseData(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    if (line.startsWith("data: ")) onData(line.slice(6));
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) handle(l);
  }
  if (buf) handle(buf);
}

/**
 * Consume an /api/agent SSE stream. Every event goes to `onEvent`; the return
 * value is the full report built from the `final_response` events.
 */
export async function collectAgentStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: AgentEvent) => void
): Promise<string> {
  let final = "";
  await readSseData(body, (data) => {
    let event: AgentEvent;
    try { event = JSON.parse(data) as AgentEvent; } catch { return; }
    onEvent(event);
    if (event.type === "final_response") final = applyFinalResponse(final, event);
  });
  return final;
}

/** Consume an /api/chat SSE stream; returns the concatenated answer text. */
export async function collectChatStream(
  body: ReadableStream<Uint8Array>,
  handlers: { onText: (t: string) => void; onFollowups: (q: string[]) => void }
): Promise<string> {
  let full = "";
  await readSseData(body, (data) => {
    if (data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.text) { handlers.onText(parsed.text); full += parsed.text; }
      if (parsed.followups) handlers.onFollowups(parsed.followups);
    } catch { /* ignore */ }
  });
  return full;
}
