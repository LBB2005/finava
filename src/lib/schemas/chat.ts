import { z } from "zod";
import { PageContextSchema } from "@/lib/pageContext";
import { DOC_ID_RE } from "@/lib/docId";

/** A client-supplied document id (conversation, template): no "/" or "..". */
export const DocIdSchema = z.string().regex(DOC_ID_RE);

/**
 * Size caps shared by the chat-lane schemas. The client sends `buildHistory()`
 * output (a ~16K-token transcript budget) plus the new message, so these sit
 * well above real use while bounding what one request can put in front of a
 * model. `portfolioContext` lands in the CACHED system prompt, so it was also
 * a way to park a huge prompt at cache-write prices; it matches /api/agent's cap.
 */
export const MAX_TURN_CHARS = 100_000;
export const MAX_TRANSCRIPT_CHARS = 250_000;
export const MAX_PORTFOLIO_CONTEXT_CHARS = 50_000;

/**
 * One transcript turn: plain text only. The API used to accept arbitrary
 * content-block arrays, which let a client smuggle its own `cache_control`
 * breakpoints, or image/document blocks pointing at URLs, into the model call.
 * The app never sends anything but strings.
 */
export const TranscriptTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(MAX_TURN_CHARS),
});

/** Refinement: the whole transcript fits the character budget. */
export function withinTranscriptBudget(turns: { content: string }[] | undefined): boolean {
  return (turns ?? []).reduce((n, t) => n + t.content.length, 0) <= MAX_TRANSCRIPT_CHARS;
}

/**
 * Body schema for `POST /api/chat` (SSE).
 *
 * `messages` is the text transcript (see TranscriptTurnSchema); `portfolioContext`
 * is an optional string injected into the system prompt.
 */
export const ChatRequestSchema = z.object({
  messages: z
    .array(TranscriptTurnSchema)
    .min(1, "messages must contain at least one message")
    .max(100)
    .refine(withinTranscriptBudget, { message: "conversation too long" }),
  portfolioContext: z.string().max(MAX_PORTFOLIO_CONTEXT_CHARS).optional(),
  /** Optional response-template id whose instructions/format shape the answer. */
  templateId: DocIdSchema.optional(),
  /** Snapshot of the stock/research page the message was composed on, so the
   *  model scopes its answer to that ticker and resolves vague references. */
  pageContext: PageContextSchema.optional(),
  /** The conversation this turn belongs to, so the fast lane can reuse the
   *  previous turn's fetched data for a reformat follow-up (see turnData). */
  conversationId: DocIdSchema.optional(),
});

export type ChatRequestBody = z.infer<typeof ChatRequestSchema>;

/**
 * Body schema for `POST /api/classify` — the Auto-mode intent router.
 *
 * `userPrompt` is the message to classify (already combined with any clarifying
 * answer client-side). `history` is a short trailing slice of prior turns for
 * follow-up context; `portfolioContext` lets the router know holdings exist
 * (e.g. "review my portfolio" → agent).
 */
export const ClassifyRequestSchema = z.object({
  userPrompt: z.string().min(1).max(4000),
  history: z
    .array(TranscriptTurnSchema)
    .max(20)
    .refine(withinTranscriptBudget, { message: "history too long" })
    .optional(),
  portfolioContext: z.string().max(MAX_PORTFOLIO_CONTEXT_CHARS).optional(),
  /** Page the message was composed on. Lets the router resolve vague references
   *  ("is this a buy?") to the viewed ticker instead of asking "which stock?". */
  pageContext: PageContextSchema.optional(),
  /** False on the turn right after a clarifying question, so we never ask twice. */
  allowClarify: z.boolean().optional(),
});

export type ClassifyRequestBody = z.infer<typeof ClassifyRequestSchema>;
