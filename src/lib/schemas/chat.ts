import { z } from "zod";
import { PageContextSchema } from "@/lib/pageContext";

/**
 * Body schema for `POST /api/chat` (SSE).
 *
 * `messages` is an Anthropic-style `MessageParam[]`: each entry has a `role`
 * ("user" | "assistant") and `content` that is either a plain string or an
 * array of content blocks. We keep the block array permissive (`unknown[]`) so
 * valid Anthropic payloads (text, image, tool_use, etc.) are not rejected, while
 * still catching empty or garbage bodies. `portfolioContext` is an optional
 * string injected into the system prompt.
 */
export const ChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string(), z.array(z.unknown())]),
      })
    )
    .min(1, "messages must contain at least one message"),
  portfolioContext: z.string().optional(),
  /** Optional response-template id whose instructions/format shape the answer. */
  templateId: z.string().max(200).optional(),
  /** Snapshot of the stock/research page the message was composed on, so the
   *  model scopes its answer to that ticker and resolves vague references. */
  pageContext: PageContextSchema.optional(),
  /** The conversation this turn belongs to, so the fast lane can reuse the
   *  previous turn's fetched data for a reformat follow-up (see turnData). */
  conversationId: z.string().max(200).optional(),
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
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })
    )
    .max(20)
    .optional(),
  portfolioContext: z.string().optional(),
  /** Page the message was composed on. Lets the router resolve vague references
   *  ("is this a buy?") to the viewed ticker instead of asking "which stock?". */
  pageContext: PageContextSchema.optional(),
  /** False on the turn right after a clarifying question, so we never ask twice. */
  allowClarify: z.boolean().optional(),
});

export type ClassifyRequestBody = z.infer<typeof ClassifyRequestSchema>;
