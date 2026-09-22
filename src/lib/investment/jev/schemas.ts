// Jev (TypeSafe) request and response contracts.
//
// Verified against https://docs.typesafe.ai/api on 2026-09-22:
//
//   POST https://api.typesafe.ai/v1/systemone
//   Authorization: Bearer <key>
//   { state, model, questions }
//   → { model, answers, usage: { input_tokens, output_tokens } }
//
// Three primitives, and the differences matter:
//
//   noul    a single 0–1 value. NO confidence field.
//   choice  a selected option + a probability per option + confidence.
//   score   a probability-weighted value + legend + probabilities + confidence,
//           over an ARRAY of 2–10 described levels. Not an 0–10 scale.
//
// `confidence` summarises how concentrated the answer distribution is. It is NOT
// observed accuracy, and it is not a probability that any real-world event will
// happen. Nothing in this file may be read as a forecast of investment outcomes.
//
// Validation here is deliberately strict: a malformed or partial response must
// fail at this boundary rather than flow into the return arithmetic, where a
// missing probability would become a confident-looking rating.

import { z } from "zod";

/** The default model. Resolves server-side to a dated version, e.g. jev-1.13.0. */
export const DEFAULT_JEV_MODEL = "jev-latest";

// ── Requests ─────────────────────────────────────────────────────────────────

export const NoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string().min(1),
  criteria: z.object({ true: z.string().min(1), false: z.string().min(1) }).optional(),
});

export const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().min(1),
  /** Up to 255 named options. Include an unknown/insufficient option in rubrics. */
  criteria: z.record(z.string().min(1), z.string().min(1)),
});

export const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string().min(1),
  /** 2–10 described levels, in order. */
  criteria: z.array(z.string().min(1)).min(2).max(10),
});

export const JevQuestionSchema = z.discriminatedUnion("type", [
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);
export type JevQuestion = z.infer<typeof JevQuestionSchema>;

export const JevRequestSchema = z.object({
  /** The evidence the questions are asked against. */
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  model: z.string().min(1),
  questions: z.record(z.string().min(1), JevQuestionSchema),
});
export type JevRequest = z.infer<typeof JevRequestSchema>;

// ── Responses ────────────────────────────────────────────────────────────────

const Probability = z.number().min(0).max(1);

/** Probabilities must form a distribution — a partial one would silently mislead. */
const ProbabilityMap = z
  .record(z.string(), Probability)
  .refine((m) => Object.keys(m).length > 0, { message: "probabilities map is empty" })
  .refine(
    (m) => Math.abs(Object.values(m).reduce((a, b) => a + b, 0) - 1) <= 1e-4,
    { message: "probabilities must sum to 1" }
  );

export const NoulAnswerSchema = z.object({ noul: Probability });

export const ChoiceAnswerSchema = z.object({
  choice: z.string().min(1),
  probabilities: ProbabilityMap,
  confidence: Probability,
});

export const ScoreAnswerSchema = z.object({
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: ProbabilityMap,
  confidence: Probability,
});

/**
 * An answer of any primitive. Unioned rather than discriminated, because the
 * response carries no `type` field — the shape itself identifies the primitive.
 */
export const JevAnswerSchema = z.union([ChoiceAnswerSchema, ScoreAnswerSchema, NoulAnswerSchema]);
export type JevAnswer = z.infer<typeof JevAnswerSchema>;
export type JevNoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type JevChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type JevScoreAnswer = z.infer<typeof ScoreAnswerSchema>;

export const JevUsageSchema = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
});

export const JevResponseSchema = z.object({
  /** The RESOLVED model, e.g. "jev-1.13.0". Recorded, never assumed from input. */
  model: z.string().min(1),
  answers: z.record(z.string().min(1), JevAnswerSchema),
  usage: JevUsageSchema,
});
export type JevResponse = z.infer<typeof JevResponseSchema>;

/** Narrowing helpers — the response shape is what identifies the primitive. */
export function isChoiceAnswer(a: JevAnswer): a is JevChoiceAnswer {
  return "choice" in a;
}
export function isScoreAnswer(a: JevAnswer): a is JevScoreAnswer {
  return "score" in a;
}
export function isNoulAnswer(a: JevAnswer): a is JevNoulAnswer {
  return "noul" in a;
}
