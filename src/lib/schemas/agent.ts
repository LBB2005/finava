import { z } from "zod";
import { PageContextSchema } from "@/lib/pageContext";

/**
 * Body schema for `POST /api/agent` (SSE multi-agent crew).
 *
 * The route is expensive (up to 300s, fans out across sub-agents and external
 * providers), so the body is bounded to stop cost-amplification via oversized
 * inputs: `userPrompt`/`portfolioContext` are length-capped and the array fields
 * are count-capped. `wave` carries the discovery continuation payload, whose
 * internal shape (`WaveRequest | SynthesizeRequest`) is validated downstream, so
 * it is accepted here as a permissive object — only its presence gates control
 * flow.
 */
export const AgentRequestSchema = z.object({
  userPrompt: z.string().max(20_000).optional(),
  portfolioContext: z.string().max(50_000).optional(),
  deepResearch: z.boolean().optional(),
  conversationHistory: z.array(z.unknown()).max(100).optional(),
  holdings: z.array(z.unknown()).max(500).optional(),
  discover: z.boolean().optional(),
  tier: z.enum(["quick", "deep"]).optional(),
  wave: z.record(z.string(), z.unknown()).optional(),
  /** Optional response-template id whose instructions/format shape the answer. */
  templateId: z.string().max(200).optional(),
  /** Snapshot of the stock/research page the message was composed on, so the
   *  crew scopes its work to that ticker. */
  pageContext: PageContextSchema.optional(),
  /** Conversation this run belongs to. Keys the gathered sub-agent outputs so a
   *  follow-up can be answered from them instead of re-running the crew. */
  conversationId: z.string().max(200).optional(),
});

export type AgentRequestBody = z.infer<typeof AgentRequestSchema>;
