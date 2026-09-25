import type { AgentStep, ChatMessage, ChatMode } from "@/types/chat";
import type { ChatContext } from "@/lib/chatContext";
import { discoverToMarkdown, parseDiscoverContent } from "./discoverText";
import { cleanClarify, cleanClarifyReply } from "./clarify";

/** A message as the conversations API returns it (Firestore doc, serialized). */
export interface StoredMessage {
  id: string;
  role: string;
  content: string;
  mode?: string | null;
  createdAt: string;
  agentTrace?: string | null;
  durationMs?: number | null;
  context?: string | null;
  followups?: string[] | null;
  critique?: string | null;
  attachment?: string | null;
  stopped?: boolean | null;
  /** Stored natively (not as a JSON string); re-cleaned on the way in. */
  clarify?: unknown;
  clarifyReply?: unknown;
}

function parseJson<T>(raw: string | null | undefined): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

/** Rebuild a store message from its stored form, so a reload shows what the live run showed. */
export function fromStoredMessage(m: StoredMessage): ChatMessage {
  const mode = (m.mode as ChatMode) || "agent";
  let content = m.content;
  let attachment = m.attachment ? parseDiscoverContent(m.attachment) ?? undefined : undefined;
  // Older Discover messages stored the JSON payload in `content`. Read them as
  // text for history and keep the payload for the card. No data migration.
  if (mode === "discover" && !attachment) {
    const legacy = parseDiscoverContent(content);
    if (legacy) { attachment = legacy; content = discoverToMarkdown(legacy); }
  }
  return {
    id: m.id,
    role: m.role as "user" | "assistant",
    content,
    mode,
    createdAt: m.createdAt,
    agentTrace: parseJson<AgentStep[]>(m.agentTrace),
    durationMs: typeof m.durationMs === "number" ? m.durationMs : undefined,
    context: (m.context as ChatContext) ?? undefined,
    followups: Array.isArray(m.followups) && m.followups.length ? m.followups : undefined,
    critique: m.critique || undefined,
    attachment,
    stopped: m.stopped === true ? true : undefined,
    clarify: cleanClarify(m.clarify) ?? undefined,
    clarifyReply: cleanClarifyReply(m.clarifyReply),
  };
}

/** The POST body for /api/conversations/[id]/messages. */
export function toStoredMessage(m: ChatMessage) {
  return {
    role: m.role,
    content: m.content,
    mode: m.mode,
    agentTrace: m.agentTrace,
    durationMs: m.durationMs,
    context: m.context ?? undefined,
    critique: m.critique,
    followups: m.followups,
    attachment: m.attachment ? JSON.stringify(m.attachment) : undefined,
    stopped: m.stopped,
    clarify: m.clarify,
    clarifyReply: m.clarifyReply,
  };
}
