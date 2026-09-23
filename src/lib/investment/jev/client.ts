// The Jev transport. Server-only.
//
// One adapter, so Jev is replaceable: everything above this file sees
// `JevResult`, never a fetch or a vendor field name. If the contract shifts or
// the vendor is swapped, this is the only file that changes.
//
// The load-bearing property is the failure mode. A failed, timed-out, refused or
// malformed call returns `{ ok: false }` — it NEVER returns a plausible default.
// An equal-probability triple substituted for an unavailable distribution would
// be indistinguishable from a real answer in the UI, and would carry a rating.
// The caller leaves the report partial with null weights instead.
//
// Retries are bounded and deliberate: once, and only for conditions where a
// retry can help. A 401 is not transient (the key is wrong, and retrying spends
// another request to learn the same thing); a 400 means we built a bad request.

import { z } from "zod";
import { JevResponseSchema, type JevQuestion, type JevResponse } from "./schemas";

/** TypeSafe's own API. Requires a TypeSafe console key (waitlisted). */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * Vercel AI Gateway's TypeSafe-COMPATIBLE endpoint.
 *
 * Verified by probe on 2026-09-22: it rejects Gateway's own `boolean` question
 * type with "expected one of 'noul', 'choice', 'score'" — TypeSafe's native
 * vocabulary. So it speaks the same request and response shapes as the direct
 * API, and switching routes is a base-URL change with no schema work.
 *
 * Note this is NOT Gateway's `/v1/evaluate`, which uses a different dialect
 * (`boolean` instead of `noul`, camelCase usage) and, more importantly, omits
 * `confidence` on choice and score answers — which POLICY_V1's
 * minScenarioConfidence gate depends on. Preferring the compatible endpoint
 * keeps that gate working.
 */
export const JEV_GATEWAY_ENDPOINT = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

export type JevRoute = "typesafe_direct" | "vercel_gateway";

export interface JevTransport {
  route: JevRoute;
  endpoint: string;
  apiKey: string;
}

/**
 * Pick a route from whichever credential is present.
 *
 * A direct TypeSafe key wins when both exist, because it is the more specific
 * configuration — someone holding both has opted into the direct account. Set
 * TYPESAFE_BASE_URL to override the host without touching code.
 */
export function resolveJevTransport(
  env: NodeJS.ProcessEnv = process.env
): JevTransport | null {
  const override = env.TYPESAFE_BASE_URL?.replace(/\/+$/, "");

  if (env.TYPESAFE_API_KEY) {
    return {
      route: "typesafe_direct",
      endpoint: override ? `${override}/v1/systemone` : JEV_ENDPOINT,
      apiKey: env.TYPESAFE_API_KEY,
    };
  }
  if (env.AI_GATEWAY_API_KEY) {
    return {
      route: "vercel_gateway",
      endpoint: override ? `${override}/v1/systemone` : JEV_GATEWAY_ENDPOINT,
      apiKey: env.AI_GATEWAY_API_KEY,
    };
  }
  return null;
}

/** Per-attempt timeout. Two attempts must still fit inside a research stage. */
export const JEV_TIMEOUT_MS = 20_000;

/** Retried once; everything else fails immediately. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export type JevFailureKind =
  | "not_configured"
  | "auth"
  | "invalid_request"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network"
  | "malformed_response";

export type JevResult =
  | {
      ok: true;
      /** The RESOLVED model the vendor used, e.g. "jev-1.13.0". */
      model: string;
      answers: JevResponse["answers"];
      usage: JevResponse["usage"];
      latencyMs: number;
      attempts: number;
    }
  | {
      ok: false;
      kind: JevFailureKind;
      reason: string;
      /** Present when the vendor answered with a status code. */
      status?: number;
      attempts: number;
    };

export interface JevCallOptions {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
  model?: string;
  /** Cancels in flight — checked before each attempt so a cancelled run stops. */
  signal?: AbortSignal;
  /** Overall deadline. Caps any honoured Retry-After. */
  deadlineMs?: number;
}

export interface JevDeps {
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
  /** Overrides route resolution. Tests pass this; production resolves from env. */
  endpoint?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Injected so tests need no real timers. */
  sleep?: (ms: number) => Promise<void>;
}

/** Whether Jev is usable by EITHER route, matching plaidConfigured()/stripeConfigured(). */
export function jevConfigured(): boolean {
  return resolveJevTransport() !== null;
}

/**
 * Whether the investment research feature is on.
 *
 * Reads `=== "true"` so a typo or a missing variable during a deploy disables
 * the feature rather than enabling it — the same fail-safe direction as
 * `executionMode()` in live/version.ts, which cannot return a trading mode by
 * accident.
 */
export function investmentResearchEnabled(): boolean {
  return process.env.INVESTMENT_RESEARCH_ENABLED === "true";
}

function fail(kind: JevFailureKind, reason: string, attempts: number, status?: number): JevResult {
  return { ok: false, kind, reason, attempts, ...(status != null ? { status } : {}) };
}

/** Honour Retry-After, but never past the caller's deadline. */
function retryDelayMs(header: string | null, remainingMs: number): number {
  const seconds = Number(header);
  const requested = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500;
  return Math.max(0, Math.min(requested, remainingMs));
}

/**
 * Call Jev once, with one bounded retry on transient failures.
 *
 * Never throws for a provider condition: every outcome is a JevResult, so a
 * caller cannot accidentally treat a vendor outage as a program error — or, worse,
 * catch it and continue with a default distribution.
 */
export async function callJev(opts: JevCallOptions, deps: JevDeps = {}): Promise<JevResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const transport = resolveJevTransport(env);
  const apiKey = deps.apiKey ?? transport?.apiKey;
  const endpoint = deps.endpoint ?? transport?.endpoint ?? JEV_ENDPOINT;
  const model = opts.model ?? deps.model ?? env.TYPESAFE_MODEL ?? "jev-latest";
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  if (!apiKey) {
    return fail(
      "not_configured",
      "neither TYPESAFE_API_KEY nor AI_GATEWAY_API_KEY is set",
      0
    );
  }

  const started = now();
  const deadlineAt = started + (opts.deadlineMs ?? JEV_TIMEOUT_MS * 2);
  const body = JSON.stringify({ state: opts.state, model, questions: opts.questions });

  let attempts = 0;
  let last: JevResult = fail("network", "no attempt was made", 0);

  for (let attempt = 0; attempt < 2; attempt++) {
    // Cancellation is checked before spending a request, not only after.
    if (opts.signal?.aborted) {
      return fail("network", "cancelled before the request was sent", attempts);
    }

    attempts++;
    const perAttemptBudget = Math.min(JEV_TIMEOUT_MS, Math.max(0, deadlineAt - now()));
    if (perAttemptBudget <= 0) {
      return fail("timeout", "deadline elapsed before the request could be sent", attempts);
    }

    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), perAttemptBudget);
    const onAbort = () => timer.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: timer.signal,
      });

      if (!res.ok) {
        // 401/403 and 4xx request errors are terminal: retrying spends another
        // request to be told the same thing.
        if (res.status === 401 || res.status === 403) {
          return fail("auth", `Jev rejected the credentials (${res.status})`, attempts, res.status);
        }
        if (res.status >= 400 && res.status < 500 && !RETRYABLE_STATUSES.has(res.status)) {
          return fail("invalid_request", `Jev rejected the request (${res.status})`, attempts, res.status);
        }

        const kind: JevFailureKind = res.status === 429 ? "rate_limited" : "server_error";
        last = fail(kind, `Jev returned ${res.status}`, attempts, res.status);

        if (attempt === 0) {
          const wait = retryDelayMs(res.headers?.get?.("retry-after") ?? null, deadlineAt - now());
          if (wait > 0 || deadlineAt > now()) {
            await sleep(wait);
            continue;
          }
        }
        return last;
      }

      const json: unknown = await res.json();
      const parsed = JevResponseSchema.safeParse(json);
      if (!parsed.success) {
        // A shape we do not recognise is NOT retried: it would fail identically,
        // and a partially-valid response must never be salvaged into an answer.
        return fail(
          "malformed_response",
          `Jev response failed validation: ${z.prettifyError(parsed.error)}`,
          attempts
        );
      }

      return {
        ok: true,
        model: parsed.data.model,
        answers: parsed.data.answers,
        usage: parsed.data.usage,
        latencyMs: now() - started,
        attempts,
      };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted && opts.signal?.aborted) {
        return fail("network", "cancelled while the request was in flight", attempts);
      }
      last = aborted
        ? fail("timeout", `Jev did not respond within ${perAttemptBudget}ms`, attempts)
        : fail("network", err instanceof Error ? err.message : String(err), attempts);

      if (attempt === 0 && deadlineAt > now()) {
        await sleep(0);
        continue;
      }
      return last;
    } finally {
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  return last;
}

/**
 * Require exactly the answers we asked for, no more and no fewer.
 *
 * A response missing an answer, or carrying one we did not ask about, means the
 * request and response are not about the same thing — so nothing in it can be
 * trusted positionally. Extra keys are rejected rather than ignored, because the
 * likeliest cause is a question-set version mismatch.
 */
export function requireAnswers(
  answers: JevResponse["answers"],
  expectedIds: readonly string[]
): { ok: true } | { ok: false; reason: string } {
  const got = new Set(Object.keys(answers));
  const missing = expectedIds.filter((id) => !got.has(id));
  const unexpected = [...got].filter((id) => !expectedIds.includes(id));

  if (missing.length > 0) {
    return { ok: false, reason: `Jev omitted answers: ${missing.join(", ")}` };
  }
  if (unexpected.length > 0) {
    return { ok: false, reason: `Jev returned unrequested answers: ${unexpected.join(", ")}` };
  }
  return { ok: true };
}
