import { z } from "zod";
import { PageContextSchema } from "@/lib/pageContext";
import { DocIdSchema, TranscriptTurnSchema, withinTranscriptBudget } from "@/lib/schemas/chat";

/** A generous ceiling on a Discover continuation's serialized size; the fields
 *  themselves are clamped by sanitizeSynthesizeRequest / sanitizeWaveRequest. */
const MAX_WAVE_JSON_CHARS = 1_000_000;

/**
 * Body schema for `POST /api/agent` (SSE multi-agent crew).
 *
 * The route is expensive (up to 300s, fans out across sub-agents and external
 * providers), so the body is bounded to stop cost-amplification via oversized
 * inputs: `userPrompt`/`portfolioContext` are length-capped and the array fields
 * are count-capped. `wave` carries the discovery continuation payload; its
 * fields are clamped by src/lib/discoverRequests.ts before anything runs, and
 * here it is only bounded in total size.
 */
export const AgentRequestSchema = z.object({
  userPrompt: z.string().max(20_000).optional(),
  portfolioContext: z.string().max(50_000).optional(),
  deepResearch: z.boolean().optional(),
  conversationHistory: z
    .array(TranscriptTurnSchema)
    .max(100)
    .refine(withinTranscriptBudget, { message: "conversation too long" })
    .optional(),
  holdings: z
    .array(z.object({ ticker: z.string().max(32), shares: z.number().finite() }).loose())
    .max(500)
    .optional(),
  discover: z.boolean().optional(),
  tier: z.enum(["quick", "deep"]).optional(),
  wave: z
    .record(z.string(), z.unknown())
    .refine((w) => JSON.stringify(w).length <= MAX_WAVE_JSON_CHARS, { message: "discovery payload too large" })
    .optional(),
  /** Optional response-template id whose instructions/format shape the answer. */
  templateId: DocIdSchema.optional(),
  /** Snapshot of the stock/research page the message was composed on, so the
   *  crew scopes its work to that ticker. */
  pageContext: PageContextSchema.optional(),
  /** Conversation this run belongs to. Keys the gathered sub-agent outputs so a
   *  follow-up can be answered from them instead of re-running the crew. */
  conversationId: DocIdSchema.optional(),
});

export type AgentRequestBody = z.infer<typeof AgentRequestSchema>;
