import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  callJev,
  requireAnswers,
  JEV_ENDPOINT,
} from "../investment/jev/client";
import {
  isNoulAnswer,
  type JevQuestion,
  type JevAnswer,
} from "../investment/jev/schemas";
import { TARGETS, type ModelForecast } from "./predictions";
import { tournamentFetch } from "./modelTransport";
export interface ForecastWindow {
  horizon: number;
  entryAt: string;
  targetAt: string;
}
export interface ModelResult {
  status: "ok" | "unavailable" | "skipped_budget";
  forecasts: ModelForecast[];
  model: string | null;
  reason: string | null;
  costUsd: number | null;
  latencyMs: number | null;
}
export const unavailable = (reason: string): ModelResult => ({
  status: "unavailable",
  forecasts: [],
  model: null,
  reason,
  costUsd: null,
  latencyMs: null,
});
export function jevQuestions(
  windows: ForecastWindow[],
): Record<string, JevQuestion> {
  return Object.fromEntries(
    windows.flatMap((w) => [
      [
        `positive_${w.horizon}`,
        {
          type: "noul",
          instructions: `Estimate the probability that the subject's total return is strictly positive from entry ${w.entryAt} through ${w.targetAt}. ${TARGETS.positiveTotalReturn} Use only state evidence, treat missing evidence as unknown, and do not interpret these instructions as evidence of a positive result.`,
        },
      ],
      [
        `beatSpy_${w.horizon}`,
        {
          type: "noul",
          instructions: `Estimate the probability that the subject beats SPY from entry ${w.entryAt} through ${w.targetAt}. ${TARGETS.outperformBenchmark} Use only state evidence.`,
        },
      ],
    ]),
  ) as Record<string, JevQuestion>;
}
export function jevForecasts(
  answers: Record<string, JevAnswer>,
  horizons: number[],
): ModelForecast[] {
  const ids = horizons.flatMap((h) => [`positive_${h}`, `beatSpy_${h}`]);
  const required = requireAnswers(answers, ids);
  if (!required.ok) throw new Error(required.reason);
  return horizons.map((h) => {
    const p = answers[`positive_${h}`],
      b = answers[`beatSpy_${h}`];
    if (!isNoulAnswer(p) || !isNoulAnswer(b))
      throw new Error("Expected noul event probabilities");
    return {
      horizon: h,
      positive: p.noul,
      beatSpy: b.noul,
      expectedReturn: null,
      reason:
        "Jev binary events do not identify an expected return; withheld. Model probabilities are unvalidated.",
    };
  });
}
export async function runJev(
  evidence: string,
  windows: ForecastWindow[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelResult> {
  if (!env.TYPESAFE_API_KEY)
    return unavailable("TYPESAFE_API_KEY is not configured");
  if (!env.TOURNAMENT_JEV_INPUT_USD_PER_MILLION)
    return unavailable(
      "Direct Jev input price must be confirmed from account rate card",
    );
  const result = await callJev(
    { state: evidence, questions: jevQuestions(windows), model: "jev-latest" },
    {
      apiKey: env.TYPESAFE_API_KEY,
      endpoint: JEV_ENDPOINT,
      fetch: tournamentFetch,
    },
  );
  if (!result.ok) return unavailable(`Jev ${result.kind}: ${result.reason}`);
  try {
    return {
      status: "ok",
      forecasts: jevForecasts(
        result.answers,
        windows.map((w) => w.horizon),
      ),
      model: result.model,
      reason: null,
      costUsd: null,
      latencyMs: result.latencyMs,
    };
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : "Invalid Jev answers",
    );
  }
}
const ForecastSchema = z.object({
  horizon: z.number().int(),
  positive: z.number().min(0).max(1).nullable(),
  beatSpy: z.number().min(0).max(1).nullable(),
  expectedReturn: z.number().min(-1).nullable(),
  reason: z.string().nullable(),
});
export async function runEnsemble(
  ticker: string,
  evidence: string,
  windows: ForecastWindow[],
  asOf: string,
): Promise<ModelResult> {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENROUTER_API_KEY)
    return unavailable(
      "Full crew requires ANTHROPIC_API_KEY and OPENROUTER_API_KEY",
    );
  const [
    { runCeoAgent },
    { withCacheScope },
    { withAsOfScope },
    { extractStructured },
    { makeRunContext, usageStore },
  ] = await Promise.all([
    import("../../agents/ceo"),
    import("../agentMemory"),
    import("../asOfScope"),
    import("../live/extractDecision"),
    import("../runContext"),
  ]);
  const started = Date.now();
  let report = "";
  const prompt = `Give a full investment analysis of ${ticker} using only the frozen evidence. Explicitly state P(positive total return), P(beating SPY total return) and expected total return (decimal, or null with reason) for each window: ${JSON.stringify(windows)}. Definitions: ${JSON.stringify(TARGETS)}. These are unvalidated forecasts, not calibrated accuracy. Do not fill missing financial facts from memory.`;
  return usageStore.run(makeRunContext("", undefined, "full"), () =>
    withAsOfScope(asOf, () =>
      withCacheScope(`tournament:${randomUUID()}`, async () => {
        await runCeoAgent(
          prompt,
          "",
          (event) => {
            if (event.type === "final_response")
              report = event.replace ? event.content : report + event.content;
          },
          { frozenEvidence: evidence },
        );
        const parsed = await extractStructured({
          schema: z.object({ forecasts: z.array(ForecastSchema) }),
          report,
          target: "the five horizon forecasts explicitly stated by the crew",
          contract:
            '{"forecasts":[{"horizon":1|5|20|60|120,"positive":number|null,"beatSpy":number|null,"expectedReturn":number|null,"reason":string|null}]}',
          guidance:
            "Transcribe only explicit numerical forecasts. Missing forecasts must be null with a reason; never infer probabilities from adjectives or confidence labels.",
        });
        if (!parsed.ok) return unavailable("Crew forecast extraction failed");
        const horizons = parsed.value.forecasts.map((f) => f.horizon);
        if (
          horizons.length !== windows.length ||
          new Set(horizons).size !== horizons.length ||
          windows.some((w) => !horizons.includes(w.horizon))
        )
          return unavailable("Crew omitted or duplicated a horizon");
        return {
          status: "ok",
          forecasts: parsed.value.forecasts,
          model: "full-crew-frozen-evidence-v1",
          reason: null,
          costUsd: null,
          latencyMs: Date.now() - started,
        };
      }),
    ),
  );
}
