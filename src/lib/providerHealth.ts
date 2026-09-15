/**
 * Provider health — "is an AI or data provider failing right now?"
 *
 * Exists because failures used to be invisible: on 13 Sep 2026 the OpenRouter
 * balance hit zero and Auto silently became plain chat for everyone, with no log
 * and nothing on screen. Every provider call-site now reports here, `/api/health`
 * reads it, and the degraded banner polls that.
 *
 * Two layers, same shape as rateLimit.ts:
 *   - In-memory (always): per-instance last-failure / last-success timestamps.
 *   - Shared (when Upstash is configured): a short-TTL Redis key per failing
 *     provider, so the instance that serves /api/health sees a failure another
 *     warm instance hit. Written only on failure and on recovery — never on the
 *     healthy hot path — so a normal LLM call costs no extra round-trip.
 *
 * A provider is "failing" when it failed within FAILURE_WINDOW_MS and has not
 * succeeded since. Health is a banner signal, not a circuit breaker: nothing
 * here stops a call from being attempted.
 */
import { Redis } from "@upstash/redis";

export type LlmProviderId = "openrouter" | "anthropic" | "openai" | "google" | "xai";
export type DataProviderId = "perplexity" | "finnhub";
/** "router" = the Auto-mode classifier fell back to its default route. */
export type ProviderId = LlmProviderId | DataProviderId | "router";

export type LlmStatus = "ok" | "degraded" | "down";
export type DataStatus = "ok" | "degraded";

export interface HealthSnapshot {
  llm: LlmStatus;
  data: Record<DataProviderId, DataStatus>;
}

export const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const SHARED_TTL_SEC = FAILURE_WINDOW_MS / 1000;
const DATA_PROVIDERS: DataProviderId[] = ["perplexity", "finnhub"];
const ALL_PROVIDERS: ProviderId[] = [
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "xai",
  "router",
  ...DATA_PROVIDERS,
];

// ── In-memory state (globalThis so HMR re-evaluation doesn't reset it) ─────────
interface Marks {
  lastFailure?: number;
  lastSuccess?: number;
}
const g = globalThis as typeof globalThis & {
  __providerHealth?: Map<ProviderId, Marks>;
  __providerHealthStore?: SharedHealthStore | null;
};
function marks(): Map<ProviderId, Marks> {
  if (!g.__providerHealth) g.__providerHealth = new Map();
  return g.__providerHealth;
}

// ── Shared store ───────────────────────────────────────────────────────────────
export interface SharedHealthStore {
  markFailure(p: ProviderId): Promise<void>;
  clearFailure(p: ProviderId): Promise<void>;
  failing(): Promise<Set<ProviderId>>;
}

const KEY = (p: ProviderId) => `health:fail:${p}`;

function redisStore(redis: Redis): SharedHealthStore {
  return {
    async markFailure(p) {
      await redis.set(KEY(p), Date.now(), { ex: SHARED_TTL_SEC });
    },
    async clearFailure(p) {
      await redis.del(KEY(p));
    },
    async failing() {
      const values = await redis.mget<(number | null)[]>(...ALL_PROVIDERS.map(KEY));
      return new Set(ALL_PROVIDERS.filter((_, i) => values[i] != null));
    },
  };
}

function sharedStore(): SharedHealthStore | null {
  if (g.__providerHealthStore !== undefined) return g.__providerHealthStore;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  g.__providerHealthStore = null;
  if (url && token) {
    try {
      g.__providerHealthStore = redisStore(new Redis({ url, token }));
    } catch (e) {
      console.warn("[providerHealth] Upstash init failed, in-memory only:", e);
    }
  }
  return g.__providerHealthStore;
}

function fireAndForget(p: Promise<void>): void {
  p.catch((e) => console.warn("[providerHealth] shared store write failed:", e));
}

// ── Recording ──────────────────────────────────────────────────────────────────
export function recordProviderFailure(p: ProviderId, now = Date.now()): void {
  const m = marks().get(p) ?? {};
  m.lastFailure = now;
  marks().set(p, m);
  const store = sharedStore();
  if (store) fireAndForget(store.markFailure(p));
}

export function recordProviderSuccess(p: ProviderId, now = Date.now()): void {
  const m = marks().get(p);
  // Healthy and already known-healthy: no write at all (hot path).
  if (!m?.lastFailure || (m.lastSuccess ?? 0) >= m.lastFailure) {
    if (m) m.lastSuccess = now;
    return;
  }
  m.lastSuccess = now;
  const store = sharedStore();
  if (store) fireAndForget(store.clearFailure(p));
}

// ── Reading ────────────────────────────────────────────────────────────────────
function locallyFailing(p: ProviderId, now: number): boolean {
  const m = marks().get(p);
  if (!m?.lastFailure) return false;
  if (now - m.lastFailure > FAILURE_WINDOW_MS) return false;
  return (m.lastSuccess ?? 0) < m.lastFailure;
}

function statusFrom(isFailing: (p: ProviderId) => boolean): HealthSnapshot {
  let llm: LlmStatus = "ok";
  if (isFailing("openrouter")) {
    // The direct Anthropic fallback is the floor: if it's failing too, answers stop.
    llm = isFailing("anthropic") ? "down" : "degraded";
  } else if (isFailing("router")) {
    llm = "degraded";
  }
  const data = Object.fromEntries(
    DATA_PROVIDERS.map((p) => [p, isFailing(p) ? "degraded" : "ok"])
  ) as Record<DataProviderId, DataStatus>;
  return { llm, data };
}

/** Synchronous, this-instance-only view of the LLM status. */
export function llmStatus(now = Date.now()): LlmStatus {
  return statusFrom((p) => locallyFailing(p, now)).llm;
}

/** Local state merged with the shared store (when configured). Never throws. */
export async function getHealthSnapshot(now = Date.now()): Promise<HealthSnapshot> {
  let remote = new Set<ProviderId>();
  const store = sharedStore();
  if (store) {
    try {
      remote = await store.failing();
    } catch (e) {
      console.warn("[providerHealth] shared store read failed, local only:", e);
    }
  }
  return statusFrom((p) => remote.has(p) || locallyFailing(p, now));
}

// ── Test seams ─────────────────────────────────────────────────────────────────
export function resetProviderHealthForTest(): void {
  g.__providerHealth = new Map();
}

/** Install a stub shared store (or `null` for in-memory only). */
export function setSharedHealthStoreForTest(store: SharedHealthStore | null): void {
  g.__providerHealthStore = store;
}
