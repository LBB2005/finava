import { z } from "zod";
import { PageContextSchema } from "@/lib/pageContext";
import { isSafeDocId } from "@/lib/docId";

const OptionalTrimmedString = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    z.string().max(max).optional()
  );

export const CreateConversationSchema = z.object({
  id: OptionalTrimmedString(128).refine((id) => id === undefined || isSafeDocId(id), {
    message: "invalid conversation id",
  }),
  title: OptionalTrimmedString(200).nullable().optional(),
  context: z.string().max(50_000).nullable().optional(),
  /** Page snapshot (ticker + data) the chat was started from, persisted so
   *  follow-ups survive a reload with their scope intact. */
  pageContext: PageContextSchema.nullable().optional(),
});

export type CreateConversationBody = z.infer<typeof CreateConversationSchema>;

export const UpdateConversationSchema = z
  .object({
    title: OptionalTrimmedString(200),
    archived: z.boolean().optional(),
  })
  .refine((body) => body.title !== undefined || body.archived !== undefined, {
    message: "At least one field must be provided",
  });

export type UpdateConversationBody = z.infer<typeof UpdateConversationSchema>;

export const AddMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    // Empty only for a run stopped before any text arrived.
    content: z.string().max(100_000),
    mode: z.string().max(40).default("simple"),
    agentTrace: z.unknown().optional(),
    durationMs: z.number().nonnegative().optional(),
    context: z.string().max(50_000).nullable().optional(),
    followups: z.array(z.string().max(500)).max(10).optional(),
    critique: z.string().max(20_000).optional(),
    /** Discover result payload (JSON string) the card renders; `content` is its text form. */
    attachment: z.string().max(500_000).optional(),
    stopped: z.boolean().optional(),
  })
  .refine((m) => m.content.length > 0 || m.stopped === true, {
    message: "content must not be empty",
    path: ["content"],
  });

export type AddMessageBody = z.infer<typeof AddMessageSchema>;
