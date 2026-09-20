/**
 * Per-agent LLM routing via OpenRouter.
 *
 * One OpenAI-compatible gateway (OpenRouter) fronts every model. Each routable
 * call-site ("agent") is mapped to the cheapest model that does its job, with a
 * single kill-switch — `LLM_ROUTING`:
 *   - "on"  (default): per-agent routing (Gemini Flash / Flash-Lite for narration,
 *                       Sonnet 4.6 where the user reads output, Haiku where it was).
 *   - "off": every agent falls back to the Sonnet/Haiku it used before this refactor,
 *            with its original thinking budget and max_tokens — i.e. behaves exactly
 *            as the app did pre-routing. Flip this env var to A/B or roll back instantly.
 *
 * If OpenRouter itself is unavailable (billing, auth, 429/5xx, timeout), the call
 * is retried directly against the vendor — see "Direct providers" below.
 *
 * Only the model + thinking/token budgets change. Prompts, content, and return
 * types are untouched. The CEO orchestration loop and the chat SSE stream stay on
 * the Anthropic SDK directly (they stream and/or use tools, which the string-return
 * `generate()` below intentionally does not), and Perplexity calls are untouched.
 */
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { recordUsage } from "@/lib/usage";
import { observeAnthropic, observeLlmClient, traceIdentity } from "@/lib/observability";
import { recordProviderFailure, recordProviderSuccess } from "@/lib/providerHealth";

// ── Routing flag ────────────────────────────────────────────────────────────
// Default "on". Any value other than "off" (incl. unset) enables routing.
export const LLM_ROUTING_ON = (process.env.LLM_ROUTING ?? "on") !== "off";

// ── Model slugs (confirmed live on openrouter.ai/models) ─────────────────────
// NOTE: badges show these brand-level (Claude / GPT / Gemini / Grok), so the
// Gemini *version* (2.5 today; bump to 3.x when it GAs on OpenRouter) doesn't
// change the user-facing story.
const SONNET = "anthropic/claude-sonnet-4.6";
const HAIKU = "anthropic/claude-haiku-4.5";
const GPT5 = "openai/gpt-5.5"; // best math → the numeric agents
const GROK = "x-ai/grok-4.3"; // live-X social → sentiment
const GEMINI_FLASH = "google/gemini-2.5-flash";
const GEMINI_FLASH_LITE = "google/gemini-2.5-flash-lite";

// ── Routable call-sites ──────────────────────────────────────────────────────
export type AgentKey =
  // Tier C — user-facing quality, stays on Sonnet 4.6
  | "ceo" // CEO synthesis (stays on Anthropic SDK — streaming + tools; key kept for completeness)
  | "chat" // chat route main stream (stays on Anthropic SDK — SSE; key kept for completeness)
  | "aiTake"
  | "finavaSynthesis"
  | "supplyChain" // Money Map — extract suppliers/customers from 10-K text
  | "briefingSynthesis"
  | "portfolioStatement"
  | "risk"
  | "dcf"
  | "compareVerdict" // Research · Compare lens — head-to-head verdict
  | "themesGenerate" // Research · Themes lens — AI-generated baskets
  | "scoutSelect" // Chat · Discovery scout — fit-rank the 503-name universe to a shortlist
  // Tier B — judgment over data → GPT-5.5 (the numbers) / Gemini (summarize)
  | "graham"
  | "comparables"
  | "competitor"
  | "analyst"
  | "macro"
  | "screenRead" // Research · Screen lens — basket commentary
  | "screenSuggest" // Research · Screen lens — suggested screens
  // Tier A — narrate pre-computed/fetched data → Gemini Flash-Lite (news → Flash, sentiment → Grok)
  | "technical"
  | "earnings"
  | "insider"
  | "options"
  | "fundamentals"
  | "news"
  | "sentiment"
  | "signalsNarrate" // Research · Signals lens — narrate cross-sectional events
  // Already-Haiku call-sites
  | "skeptic"
  | "chatFollowups"
  | "screenParse" // Research · Screen lens — NL query → filter
  | "chatRouter" // Chat · Auto mode — classify intent (simple/agent/discover) + clarify gate
  | "titleConversation" // Sidebar — clean 3–6 word auto-title for a chat
  | "structuredExtract"; // Finava Live — second pass turning a crew report into schema-valid JSON

// Per-agent model when routing is ON.
const ROUTED_MODELS: Record<AgentKey, string> = {
  ceo: SONNET,
  chat: SONNET,
  aiTake: SONNET,
  finavaSynthesis: SONNET,
  supplyChain: SONNET, // reading-comprehension extraction over 10-K prose
  briefingSynthesis: SONNET,
  portfolioStatement: SONNET,
  risk: SONNET,
  dcf: GPT5, // valuation math — best-in-class on AIME/HMMT
  compareVerdict: SONNET,
  themesGenerate: SONNET,
  scoutSelect: SONNET,
  // GPT-5.5 — the numbers: estimates/multiples/screens are figures
  graham: GPT5,
  comparables: GPT5,
  analyst: GPT5,
  competitor: SONNET, // qualitative moat reasoning + writing
  macro: GEMINI_FLASH,
  screenRead: GEMINI_FLASH_LITE,
  screenSuggest: GEMINI_FLASH_LITE,
  technical: GEMINI_FLASH_LITE,
  earnings: GEMINI_FLASH_LITE,
  insider: GEMINI_FLASH_LITE,
  options: GEMINI_FLASH_LITE,
  fundamentals: GEMINI_FLASH_LITE,
  news: GEMINI_FLASH, // long-context summarization of supplied articles
  sentiment: GROK, // live social (X)
  signalsNarrate: GEMINI_FLASH_LITE,
  skeptic: HAIKU,
  chatFollowups: HAIKU,
  screenParse: HAIKU,
  chatRouter: HAIKU, // fast, cheap intent router for Auto mode
  titleConversation: GEMINI_FLASH_LITE, // tiny narration job — cheapest model
  // Reading-comprehension extraction over crew prose, same job as supplyChain.
  // Not a cheap tier: it has to hold a closed enum vocabulary and emit exact
  // literals, and a mangled metric name costs a whole decision.
  structuredExtract: SONNET,
};

// Per-agent model when routing is OFF — the model each call-site used before this
// refactor. Everything was Sonnet except the four Haiku call-sites.
const HAIKU_AGENTS = new Set<AgentKey>([
  "skeptic",
  "chatFollowups",
  "screenParse",
  "chatRouter",
  "titleConversation",
]);
const FALLBACK_MODELS: Record<AgentKey, string> = Object.fromEntries(
  (Object.keys(ROUTED_MODELS) as AgentKey[]).map((k) => [
    k,
    HAIKU_AGENTS.has(k) ? HAIKU : SONNET,
  ])
) as Record<AgentKey, string>;

/**
 * Model slug per agent. Resolves to the routed model when LLM_ROUTING is on, or
 * to the original Sonnet/Haiku the agent used today when it's off.
 */
export const AGENT_MODELS: Record<AgentKey, string> = LLM_ROUTING_ON
  ? ROUTED_MODELS
  : FALLBACK_MODELS;

// ── Tier classification for the ON-routing token/thinking overrides ──────────
// Tier A: narrate pre-fetched data on a non-reasoning model — drop thinking, cap output.
const TIER_A = new Set<AgentKey>([
  "technical",
  "earnings",
  "insider",
  "options",
  "fundamentals",
  "news",
  "sentiment",
  "signalsNarrate",
  "chatRouter",
  "titleConversation",
]);
const TIER_A_MAX_TOKENS = 1200;
// Judgment agents on a non-Anthropic model (GPT-5.5 / Gemini) — drop the
// Anthropic-style thinking budget; the base model's reasoning is enough for
// narrating supplied figures/data. (competitor moved back to Sonnet, so it
// keeps its call-site budget and is intentionally NOT in this set.)
const TIER_B_NO_THINKING = new Set<AgentKey>([
  "graham",
  "comparables",
  "analyst",
  "macro",
  "screenRead",
  "screenSuggest",
]);
// DCF runs on GPT-5.5 (best math) with a bounded reasoning budget — the one
// numeric agent we let think, since it's the valuation showcase.
//
// These are the CONTENT budget and the reasoning budget SEPARATELY. They are not
// added up here because the sum is computed in resolveCall, which is also where
// the invariant is enforced — see MIN_CONTENT_TOKENS.
const DCF_CONTENT_TOKENS = 2500;
const DCF_REASONING_MAX_TOKENS = 1500;

/**
 * Headroom a reasoning model must be left for its actual answer.
 *
 * OpenRouter counts reasoning tokens against `max_tokens`. A reasoning model
 * given a budget it can spend entirely on thinking will do exactly that and
 * return an EMPTY completion with finish_reason "length" — a silent failure that
 * looks like a model outage rather than a misconfiguration, costs full price for
 * zero output, and then burns the fallback call too.
 *
 * Observed, not theorised: gpt-5.5 with max_tokens 2500 / reasoning 1500 spent
 * all 2500 tokens reasoning and returned 0 characters, at $0.075 a call.
 */
const MIN_CONTENT_TOKENS = 1000;

function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/");
}

// ── OpenRouter client (OpenAI-compatible), kept on globalThis to survive HMR ──
const g = globalThis as typeof globalThis & { __openrouterClient?: OpenAI };

function getClient(): OpenAI {
  if (!g.__openrouterClient) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Add it to .env.local and restart the dev server."
      );
    }
    g.__openrouterClient = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      // The SDK default request timeout is 10 minutes — far past every route's
      // maxDuration (60–300s) and the CEO's per-agent 60–120s caps. Bound it so
      // a hung upstream fails fast enough for callers to surface a clean error.
      timeout: 60_000,
      maxRetries: 1,
      defaultHeaders: {
        // Headers OpenRouter uses for attribution/rankings.
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "https://finava.app",
        "X-Title": process.env.NEXT_PUBLIC_APP_NAME ?? "Finava",
      },
    });
  }
  return g.__openrouterClient;
}

// OpenRouter accepts OpenAI content parts plus a `file` part for PDFs. The OpenAI
// SDK doesn't type `file`, so we describe the parts we actually send loosely.
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface GenerateOptions {
  agent: AgentKey;
  /** System prompt (mapped straight across from the original call). */
  system?: string;
  /** User message text. Ignored when `content` is provided. */
  prompt?: string;
  /** Multimodal user content (e.g. statement image/PDF). Overrides `prompt`. */
  content?: LlmContentPart[];
  /** The max output tokens the original call used. */
  maxTokens: number;
  /**
   * The original thinking/extended-reasoning budget (Anthropic `budget_tokens`),
   * if the original call used one. Passed through as OpenRouter `reasoning.max_tokens`.
   */
  reasoning?: number;
  /** Request Anthropic prompt-cache passthrough on the system prompt. */
  cache?: boolean;
  /**
   * Whether to meter this call against the user's credit allowance. Defaults to
   * `true`. Set `false` for system-cost calls the user shouldn't pay for (e.g.
   * auto-generating a conversation title).
   */
  meter?: boolean;
}

/**
 * Resolve the effective model + token/thinking budgets for an agent, applying the
 * ON-routing overrides. When routing is off, the call's original budgets are used
 * verbatim against the Sonnet/Haiku fallback model.
 */
function resolveCall(opts: GenerateOptions): {
  model: string;
  maxTokens: number;
  reasoning?: number;
} {
  const model = AGENT_MODELS[opts.agent];
  let maxTokens = opts.maxTokens;
  let reasoning = opts.reasoning;

  if (LLM_ROUTING_ON) {
    if (TIER_A.has(opts.agent)) {
      maxTokens = Math.min(maxTokens, TIER_A_MAX_TOKENS);
      reasoning = undefined; // non-reasoning narration model
    } else if (opts.agent === "dcf") {
      maxTokens = DCF_CONTENT_TOKENS + DCF_REASONING_MAX_TOKENS;
      reasoning = DCF_REASONING_MAX_TOKENS;
    } else if (TIER_B_NO_THINKING.has(opts.agent)) {
      reasoning = undefined; // judgment on GPT/Gemini, no Anthropic thinking budget
    }
  }

  // Whatever the tier logic decided, a reasoning call must still be able to
  // answer. Applied to every agent, not just dcf: the failure is a property of
  // reasoning models and the token accounting, so any agent that later gains a
  // reasoning budget inherits the protection rather than rediscovering the bug.
  if (reasoning !== undefined && maxTokens - reasoning < MIN_CONTENT_TOKENS) {
    maxTokens = reasoning + MIN_CONTENT_TOKENS;
  }

  return { model, maxTokens, reasoning };
}

// ── Direct providers (bypass OpenRouter) ─────────────────────────────────────
//
// OpenRouter is one account in front of every model, so its balance or an outage
// at the gateway takes every agent down at once — which is exactly what happened
// on 13 Sep 2026. When the gateway itself is the problem, retry the call against
// the vendor directly with the keys we already hold. Anthropic is the floor (the
// app can't run without ANTHROPIC_API_KEY); the others are used only when their
// key is configured, and only for the agent's own model family, so a Grok agent
// stays on Grok rather than silently changing voice.

export type AnsweredVia = "openrouter" | "direct";

export interface GenerateResult {
  text: string;
  /** OpenRouter-style slug of the model that ACTUALLY answered (for badges/metering). */
  model: string;
  via: AnsweredVia;
}

type DirectProvider = "anthropic" | "openai" | "google" | "xai";

interface OpenAiCompatibleVendor {
  provider: Exclude<DirectProvider, "anthropic">;
  envKey: string;
  baseURL: string;
  /** OpenAI's reasoning models reject `max_tokens`; the compat endpoints accept it. */
  tokenParam: "max_tokens" | "max_completion_tokens";
}

const OPENAI_COMPATIBLE_VENDORS: Record<string, OpenAiCompatibleVendor> = {
  "openai/": {
    provider: "openai",
    envKey: "OPENAI_API_KEY",
    baseURL: "https://api.openai.com/v1",
    tokenParam: "max_completion_tokens",
  },
  "google/": {
    provider: "google",
    envKey: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    tokenParam: "max_tokens",
  },
  "x-ai/": {
    provider: "xai",
    envKey: "XAI_API_KEY",
    baseURL: "https://api.x.ai/v1",
    tokenParam: "max_tokens",
  },
};

// OpenRouter slug → Anthropic API id. Anything non-Anthropic lands on Sonnet,
// the same model the gateway fallback already uses.
const ANTHROPIC_DIRECT_IDS: Record<string, string> = {
  [SONNET]: "claude-sonnet-4-6",
  [HAIKU]: "claude-haiku-4-5",
};

interface DirectAttempt {
  provider: DirectProvider;
  /** Slug recorded as the answering model. */
  slug: string;
  run: () => Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
}

const clients = globalThis as typeof globalThis & {
  __directOpenAiClients?: Map<string, OpenAI>;
  __directAnthropicClient?: Anthropic;
};

function directOpenAiClient(vendor: OpenAiCompatibleVendor, apiKey: string): OpenAI {
  if (!clients.__directOpenAiClients) clients.__directOpenAiClients = new Map();
  let c = clients.__directOpenAiClients.get(vendor.provider);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL: vendor.baseURL, timeout: 60_000, maxRetries: 0 });
    clients.__directOpenAiClients.set(vendor.provider, c);
  }
  return c;
}

function directAnthropicClient(apiKey: string): Anthropic {
  if (!clients.__directAnthropicClient) {
    clients.__directAnthropicClient = observeAnthropic(
      new Anthropic({ apiKey, timeout: 60_000, maxRetries: 0 })
    );
  }
  return clients.__directAnthropicClient;
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = url.match(/^data:([^;,]+);base64,([\s\S]*)$/);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

/** OpenRouter/OpenAI content parts → Anthropic Messages content blocks. */
function toAnthropicContent(parts: LlmContentPart[]): unknown[] {
  return parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image_url") {
      const d = parseDataUrl(p.image_url.url);
      return d
        ? { type: "image", source: { type: "base64", media_type: d.mediaType, data: d.data } }
        : { type: "image", source: { type: "url", url: p.image_url.url } };
    }
    const d = parseDataUrl(p.file.file_data);
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: d?.mediaType ?? "application/pdf",
        data: d?.data ?? p.file.file_data,
      },
    };
  });
}

function directAttempts(
  opts: GenerateOptions,
  primary: string,
  maxTokens: number,
  hasFile: boolean
): DirectAttempt[] {
  const attempts: DirectAttempt[] = [];
  const parts = opts.content ?? [{ type: "text" as const, text: opts.prompt ?? "" }];

  const vendorPrefix = Object.keys(OPENAI_COMPATIBLE_VENDORS).find((k) => primary.startsWith(k));
  const vendor = vendorPrefix ? OPENAI_COMPATIBLE_VENDORS[vendorPrefix] : undefined;
  const vendorKey = vendor ? process.env[vendor.envKey] : undefined;
  if (vendor && vendorKey && !hasFile) {
    attempts.push({
      provider: vendor.provider,
      slug: primary,
      run: async () => {
        const messages: unknown[] = [];
        if (opts.system) messages.push({ role: "system", content: opts.system });
        messages.push({ role: "user", content: parts });
        const r = await directOpenAiClient(vendor, vendorKey).chat.completions.create({
          model: primary.slice(vendorPrefix!.length),
          messages,
          [vendor.tokenParam]: maxTokens,
        } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
        const content = r.choices?.[0]?.message?.content;
        return {
          text: typeof content === "string" ? content : "",
          inputTokens: r.usage?.prompt_tokens,
          outputTokens: r.usage?.completion_tokens,
        };
      },
    });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const slug = ANTHROPIC_DIRECT_IDS[primary] ? primary : SONNET;
    attempts.push({
      provider: "anthropic",
      slug,
      run: async () => {
        // No extended thinking on the fallback: its budget rules differ from
        // OpenRouter's reasoning field, and a degraded answer beats no answer.
        const r = await directAnthropicClient(anthropicKey).messages.create({
          model: ANTHROPIC_DIRECT_IDS[slug],
          max_tokens: maxTokens,
          ...(opts.system
            ? {
                system: opts.cache
                  ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }]
                  : opts.system,
              }
            : {}),
          messages: [{ role: "user", content: toAnthropicContent(parts) }],
        } as unknown as Anthropic.MessageCreateParamsNonStreaming);
        const text = (r.content ?? [])
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("");
        // Fold cache reads/writes into input at the full rate (the OpenRouter path's
        // convention): Anthropic reports them outside input_tokens, and leaving
        // them out would meter a cached system prompt as free.
        const u = r.usage;
        const inputTokens =
          (u?.input_tokens ?? 0) +
          (u?.cache_read_input_tokens ?? 0) +
          (u?.cache_creation_input_tokens ?? 0);
        return { text, inputTokens, outputTokens: u?.output_tokens };
      },
    });
  }
  return attempts;
}

/**
 * Whether a gateway failure means "the provider is unavailable" (so going direct
 * can help) rather than "this request is wrong" (so it can't). A 4xx that isn't
 * auth/billing/rate-limit is our bug and would fail identically everywhere.
 * Errors with no HTTP status — timeouts, connection resets, a missing key — are
 * outages.
 */
function isOutage(err: unknown): boolean {
  const status = err instanceof OpenAI.APIError ? err.status : undefined;
  if (!status) return true;
  if (status >= 500) return true;
  return [401, 402, 403, 408, 429].includes(status);
}

/** Account-level failures: every model on the gateway will fail the same way. */
function isGatewayAccountFailure(err: unknown): boolean {
  const status = err instanceof OpenAI.APIError ? err.status : undefined;
  if (status === 401 || status === 402 || status === 403) return true;
  return err instanceof Error && /OPENROUTER_API_KEY is not set/.test(err.message);
}

/**
 * Single entry point for every routable, non-streaming LLM call. Normalizes to
 * OpenAI chat format, routes via OpenRouter, and returns the assistant text as a
 * plain string. Throws (with the agent name + status) on failure so each caller's
 * existing per-agent try/catch + timeout still isolates it.
 */
export async function generate(opts: GenerateOptions): Promise<string> {
  return (await generateWithMeta(opts)).text;
}

/**
 * `generate()` plus the model that actually answered. Use this where the answer
 * is attributed to a model on screen, so a fallback never wears the primary's badge.
 */
export async function generateWithMeta(opts: GenerateOptions): Promise<GenerateResult> {
  const { agent, system, cache } = opts;
  const { model, maxTokens, reasoning } = resolveCall(opts);
  const start = Date.now();

  // PDF/file input is only validated against Anthropic's native document support
  // (the statement route runs on Sonnet). If an agent that sends a `file` part is
  // ever re-tiered to a non-Anthropic model, fail loudly here rather than silently
  // shipping an unparsed PDF to a model that can't read it.
  if (opts.content?.some((p) => p.type === "file") && !isAnthropicModel(model)) {
    throw new Error(
      `[llm:${agent}] file/PDF input requires an Anthropic model (native document support); ` +
        `resolved model is ${model}. Re-tier this agent to Sonnet/Haiku or attach an OpenRouter file-parser plugin.`
    );
  }

  const messages: unknown[] = [];
  if (system) {
    // For Anthropic models with caching requested, render the system prompt as a
    // cache_control content block so repeated calls read it from cache (~90% off
    // input). Other models / no-cache use a plain string.
    if (cache && isAnthropicModel(model)) {
      messages.push({
        role: "system",
        content: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
      });
    } else {
      messages.push({ role: "system", content: system });
    }
  }
  messages.push({
    role: "user",
    content: opts.content ?? [{ type: "text", text: opts.prompt ?? "" }],
  });

  // Build the request body. `reasoning` and content `file` parts are OpenRouter
  // extensions the OpenAI SDK doesn't type, so assemble loosely and cast.
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
  };
  if (reasoning != null) body.reasoning = { max_tokens: reasoning };

  // Ordered model fallback: if the resolved (possibly non-Anthropic) model errors
  // or returns an empty completion, retry once on a broadly-capable Anthropic
  // model via the same OpenRouter gateway. That covers a single vendor being down
  // behind the gateway; the direct-provider pass below covers the gateway itself.
  // File/PDF calls are NOT re-routed (the guard above pins them to the primary
  // Anthropic model).
  const FALLBACK_MODEL = SONNET;
  const hasFile = opts.content?.some((p) => p.type === "file") ?? false;
  const candidates =
    model === FALLBACK_MODEL || hasFile ? [model] : [model, FALLBACK_MODEL];

  let lastError: Error | null = null;
  let gatewayOutage = false;
  // Read once: the run context cannot change mid-call, and every attempt in the
  // loop below belongs to the same user and the same crew run.
  const identity = traceIdentity();

  const meterAndLog = (answered: string, inputTokens?: number, outputTokens?: number) => {
    // Meter every attempt that returned — an empty completion still burned tokens.
    // (userId comes from the route's run context; fire-and-forget; skipped when
    // meter:false for system-cost calls the user shouldn't pay for.)
    if (opts.meter !== false) {
      void recordUsage({ agent, model: answered, inputTokens, outputTokens });
    }
    if (process.env.LLM_LOG === "on") {
      console.log(
        `[llm] ${JSON.stringify({
          agent,
          model: answered,
          inputTokens: inputTokens ?? null,
          outputTokens: outputTokens ?? null,
          ms: Date.now() - start,
        })}`
      );
    }
  };

  for (const candidate of candidates) {
    let response;
    try {
      // Traced per attempt, not per call: when the primary model fails and the
      // Anthropic fallback answers, that shows in Langfuse as two generations
      // under one agent — which is the only way to see how often failover fires.
      const client = observeLlmClient(getClient(), {
        agent,
        userId: identity.userId,
        sessionId: identity.sessionId,
        tags: [candidate === model ? "primary" : "fallback", LLM_ROUTING_ON ? "routing-on" : "routing-off"],
        metadata: { routedModel: model, attemptedModel: candidate, maxTokens, reasoning },
      });
      response = await client.chat.completions.create(
        { ...body, model: candidate } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
      );
    } catch (err) {
      const status =
        err instanceof OpenAI.APIError && err.status ? ` (status ${err.status})` : "";
      const msg = err instanceof Error ? err.message : "Unknown error";
      lastError = new Error(`[llm:${agent}] ${candidate} request failed${status}: ${msg}`);
      if (isOutage(err)) {
        gatewayOutage = true;
        recordProviderFailure("openrouter");
        console.warn(`[llm:${agent}] OpenRouter ${candidate} failed${status}: ${msg}`);
      }
      if (isGatewayAccountFailure(err)) break; // every gateway model fails the same way
      continue; // fall back to the next candidate
    }

    const rawContent = response.choices?.[0]?.message?.content;
    const attemptText = typeof rawContent === "string" ? rawContent : "";
    const u = response.usage;
    meterAndLog(candidate, u?.prompt_tokens, u?.completion_tokens);
    recordProviderSuccess("openrouter");

    if (attemptText.trim()) {
      return { text: attemptText, model: candidate, via: "openrouter" };
    }

    // Empty/blank completion is a failure, not a valid result (a bare "" would
    // poison the CEO tool_result loop). Retry on the fallback; if this was the
    // last candidate, the error is surfaced below.
    const finish = response.choices?.[0]?.finish_reason ?? "unknown";
    lastError = new Error(
      `[llm:${agent}] ${candidate} returned empty content (finish_reason: ${finish}). ` +
        `Likely truncated (raise max_tokens) or content-filtered.`
    );
  }

  // The gateway is unavailable — go direct. Not attempted for model-level
  // failures (a 400, an empty completion): those would fail the same way direct.
  if (gatewayOutage) {
    for (const attempt of directAttempts(opts, model, maxTokens, hasFile)) {
      try {
        const r = await attempt.run();
        meterAndLog(attempt.slug, r.inputTokens, r.outputTokens);
        recordProviderSuccess(attempt.provider);
        if (r.text.trim()) {
          console.warn(`[llm:${agent}] answered by ${attempt.slug} direct (OpenRouter unavailable)`);
          return { text: r.text, model: attempt.slug, via: "direct" };
        }
        lastError = new Error(`[llm:${agent}] ${attempt.slug} (direct) returned empty content`);
      } catch (err) {
        recordProviderFailure(attempt.provider);
        const msg = err instanceof Error ? err.message : "Unknown error";
        lastError = new Error(`[llm:${agent}] ${attempt.slug} (direct) request failed: ${msg}`);
      }
    }
  }

  if (candidates.length > 1 || gatewayOutage) {
    console.warn(`[llm:${agent}] every model attempt failed`);
  }
  // Surface the last failure so each caller's try/catch + the CEO's is_error
  // tool_result path handle it exactly as before.
  throw lastError ?? new Error(`[llm:${agent}] request failed: no response`);
}
