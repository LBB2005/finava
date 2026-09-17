/**
 * Turns one live turn (a `Turn` plus the requests it made) into the metrics the
 * readout reports. Shared by `eval:live` and `eval:panel`.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fromStoredMessage, toStoredMessage, type StoredMessage } from "@/lib/chat/storedMessage";
import type { ChatMessage } from "@/types/chat";
import type { Conversation, Lane, Turn } from "./conversation";
import { appJson, type HttpOptions, type Tapped } from "./http";
import { answerFromWire, collapseCheck, contractShape, numberCheckFrom, type CollapseCheck, type ContractShape, type NumberCheck } from "./metrics";
import { FIXTURE_DIR } from "./replay";

export interface TurnMetrics {
  prompt: string;
  lane: Lane | null;
  /** Router decision, when Auto asked /api/classify. */
  routed: string | null;
  ttftMs: number | null;
  totalMs: number;
  collapse: CollapseCheck | null;
  contract: ContractShape | null;
  numberCheck: NumberCheck | null;
  httpStatus: number | null;
  error: string | null;
  answerChars: number;
}

/** The request that produced the answer (not the router, not persistence). */
export function laneRequest(requests: Tapped[]): Tapped | undefined {
  return [...requests].reverse().find((r) => r.url === "/api/chat" || r.url === "/api/agent");
}

/** What the committed message says the stream was. Discover keeps its framing on the attachment. */
function savedAnswer(msg: ChatMessage): string {
  const a = msg.attachment;
  if (msg.mode === "discover" && a) return a.kind === "final" ? a.report : a.kind === "shortlist" ? a.framing ?? "" : "";
  return msg.content;
}

export function measureTurn(turn: Turn, requests: Tapped[], startedAt: number, reloaded: ChatMessage | null, error: string | null): TurnMetrics {
  const lane = laneRequest(requests);
  const router = requests.find((r) => r.url === "/api/classify");
  const streamed = lane ? answerFromWire(lane.payloads) : "";
  const msg = turn.assistant;
  const isDiscover = turn.lane === "discover";
  const saved = msg ? savedAnswer(msg) : "";
  const reloadedText = reloaded ? savedAnswer(reloaded) : null;
  return {
    prompt: turn.text,
    lane: turn.lane,
    routed: router ? ((router.payloads[0] as { intent?: string } | undefined)?.intent ?? null) : null,
    ttftMs: lane?.firstTextAt != null ? lane.firstTextAt - startedAt : turn.lane === "clarify" && router?.endedAt ? router.endedAt - startedAt : null,
    totalMs: Math.max(0, ...requests.map((r) => (r.endedAt ?? Date.now()) - startedAt)),
    collapse:
      msg && lane && !turn.stopped
        ? collapseCheck({
            streamed,
            // Discover renders its card from the attachment, not the streamed text.
            rendered: isDiscover ? saved : turn.rendered,
            saved,
            reloaded: reloadedText,
          })
        : null,
    contract: msg && !isDiscover && turn.lane !== "clarify" ? contractShape(msg.content) : null,
    numberCheck: lane ? numberCheckFrom(lane.payloads) : null,
    httpStatus: lane?.status ?? router?.status ?? null,
    error: error ?? lane?.error ?? null,
    answerChars: msg?.content.length ?? 0,
  };
}

/**
 * Save the turn through the real conversations API and read it back, the way a
 * reload does. Returns the reloaded last assistant message.
 */
export async function persistAndReload(http: HttpOptions, conv: Conversation, created: boolean, newMessages: ChatMessage[]): Promise<ChatMessage | null> {
  if (!created) await appJson(http, "/api/conversations", { method: "POST", body: JSON.stringify({ id: conv.id, title: `eval ${conv.id}`, context: null }) });
  for (const m of newMessages) {
    await appJson(http, `/api/conversations/${conv.id}/messages`, { method: "POST", body: JSON.stringify(toStoredMessage(m)) });
  }
  const doc = await appJson<{ messages: StoredMessage[] }>(http, `/api/conversations/${conv.id}`);
  const last = [...doc.messages].reverse().find((m) => m.role === "assistant");
  return last ? fromStoredMessage(last) : null;
}

export async function deleteConversation(http: HttpOptions, id: string) {
  await appJson(http, `/api/conversations/${id}`, { method: "DELETE" }).catch(() => {});
}

/** `--record`: keep a real stream as a smoke fixture. The expected answer is rebuilt from the wire. */
export function recordFixture(name: string, req: Tapped) {
  const route = req.url === "/api/chat" ? "chat" : "agent";
  const file = `recorded-${route}-${name}`;
  const bytes = Buffer.concat(req.bytes.map((b) => Buffer.from(b)));
  writeFileSync(path.join(FIXTURE_DIR, `${file}.sse`), bytes);
  writeFileSync(path.join(FIXTURE_DIR, `${file}.expected.md`), answerFromWire(req.payloads));
  return file;
}
