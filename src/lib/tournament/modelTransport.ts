import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ReservationStore } from "../live/budgetReservation";
export class TournamentBudgetError extends Error {
  constructor() {
    super("skipped_budget: request reservation exceeds daily cap");
  }
}
type Scope = {
  store: ReservationStore;
  cap: number;
  denied: boolean;
  calls: number;
  cost: number;
  unknown: number;
};
const scope = new AsyncLocalStorage<Scope>();
// Verified 2026-09-28 against https://openrouter.ai/api/v1/models and
// https://platform.claude.com/docs/en/about-claude/pricing .
// Conservative admission rates per million tokens, including up to 2x long
// context pricing. Unknown models/routes are refused, never given a cheap default.
const RATES: Record<string, [number, number]> = {
  "anthropic/claude-sonnet-4.6": [6, 30],
  "claude-sonnet-4-6": [6, 30],
  "anthropic/claude-haiku-4.5": [2, 10],
  "claude-haiku-4-5": [2, 10],
  "openai/gpt-5.5": [10, 60],
  "google/gemini-2.5-flash": [0.6, 5],
  "google/gemini-2.5-flash-lite": [0.2, 0.8],
  "x-ai/grok-4.3": [2.5, 5],
};
export function requestBound(
  body: Record<string, unknown>,
  host: string,
): number {
  if (host === "api.typesafe.ai") {
    // Configure the current direct input rate. https://docs.typesafe.ai/models
    // lists $0.042/M with free output (verified 2026-09-28); allow contract overrides.
    const rate = Number(process.env.TOURNAMENT_JEV_INPUT_USD_PER_MILLION);
    if (!Number.isFinite(rate) || rate <= 0)
      throw new Error("Direct Jev rate card is not configured");
    const questions = Object.keys((body.questions ?? {}) as object).length;
    if (!questions || body.model !== "jev-latest")
      throw new Error("Unpriced Jev model");
    return (
      ((Buffer.byteLength(JSON.stringify(body)) + 8192) * questions * rate) /
      1e6
    );
  }
  if (!["openrouter.ai", "api.anthropic.com"].includes(host))
    throw new Error("Tournament model route is not priced");
  const rate = RATES[String(body.model)];
  const max = Number(body.max_tokens ?? body.max_completion_tokens);
  const tools = body.tools as { type?: string; name?: string }[] | undefined;
  if (
    !rate ||
    !Number.isInteger(max) ||
    max <= 0 ||
    tools?.some((t) => t.type || !t.name?.startsWith("run_"))
  )
    throw new Error("Unbounded or unpriced model request");
  // UTF-8 bytes bound text tokens; padding covers message framing. This mode
  // sends text only, with no server-side tools, images or recursive token use.
  return (
    ((Buffer.byteLength(JSON.stringify(body)) + 8192) * rate[0] * 2.2 +
      max * rate[1]) /
    1e6
  );
}
export const tournamentFetch: typeof fetch = async (input, init) => {
  const state = scope.getStore();
  if (!state) return globalThis.fetch(input, init);
  if (state.denied) throw new TournamentBudgetError();
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (typeof init?.body !== "string")
    throw new Error("Tournament requires a bounded text JSON request");
  const body = JSON.parse(init.body) as Record<string, unknown>;
  const bound = requestBound(body, url.hostname),
    id = randomUUID();
  if (!(await state.store.reserve(id, bound, state.cap))) {
    state.denied = true;
    throw new TournamentBudgetError();
  }
  state.calls++;
  state.unknown++;
  const response = await globalThis.fetch(input, init);
  // Do not buffer SSE to inspect usage: the caller's idle guard must receive
  // live events. Streaming invoice dollars remain unknown; retain the bound.
  if (body.stream === true || response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    await state.store.measure(id, null);
    return response;
  }
  // Only a provider-reported dollar cost is measured. Token/rate arithmetic is
  // an estimate, not an invoice, and is not silently labelled measured USD.
  let cost: number | null = null;
  try {
    const data = await response.clone().json();
    if (
      response.ok &&
      typeof data.usage?.cost === "number" &&
      Number.isFinite(data.usage.cost) &&
      data.usage.cost >= 0
    )
      cost = data.usage.cost;
  } catch {
    /* reservation retained */
  }
  await state.store.measure(id, cost);
  if (cost !== null) {
    state.unknown--;
    state.cost += cost;
  }
  if (cost !== null && cost > bound) {
    state.denied = true;
    throw new Error(
      "Provider exceeded pricing bound; stop and review rate card",
    );
  }
  return response;
};
export async function withTournamentBudget<T>(
  store: ReservationStore,
  cap: number,
  work: () => Promise<T>,
) {
  const state: Scope = {
    store,
    cap,
    denied: false,
    calls: 0,
    cost: 0,
    unknown: 0,
  };
  return scope.run(state, async () => {
    try {
      const value = await work();
      return {
        value,
        costUsd: state.unknown ? null : state.cost,
        calls: state.calls,
        denied: state.denied,
      };
    } catch (error) {
      if (state.denied) throw new TournamentBudgetError();
      throw error;
    }
  });
}
