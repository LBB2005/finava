import { z } from "zod";

/**
 * Boot-time environment validation.
 *
 * Two schemas, deliberately split:
 *  - CLIENT: only `NEXT_PUBLIC_*` vars. Safe to validate anywhere (browser +
 *    server) because Next inlines these into the client bundle. Accessed via
 *    STATIC `process.env.NEXT_PUBLIC_X` so the inlining actually happens —
 *    dynamic `process.env[key]` is NOT statically replaced and breaks on the client.
 *  - SERVER: everything else. Must ONLY be imported from server modules; server
 *    secrets are stripped to `undefined` in the client bundle, so validating the
 *    server schema on the client would spuriously throw.
 *
 * Only Firebase credentials are REQUIRED — without them the app cannot read/write
 * any data or authenticate a single request, so a misconfigured server should
 * fail fast at startup (see src/instrumentation.ts) rather than 500 on every
 * request. Every other var is optional: the feature that needs it degrades
 * gracefully (route-level 503 guards, `stripeConfigured()`, `plaidConfigured()`,
 * lazy provider clients) instead of bricking the whole server.
 */

// ── Client (NEXT_PUBLIC_*) ──────────────────────────────────────────────────
const clientSchema = z.object({
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().min(1),
  NEXT_PUBLIC_APP_NAME: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().optional(),
});

// STATIC access so the values are inlined into the client bundle at build.
const clientRaw = {
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
};

// ── Server ──────────────────────────────────────────────────────────────────
const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // REQUIRED — the app cannot function without Firebase Admin credentials.
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_PRIVATE_KEY: z.string().min(1),

  // AI providers (optional — routing/features degrade if absent).
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  XAI_MODEL: z.string().optional(),
  LLM_LOG: z.string().optional(),
  LLM_ROUTING: z.string().optional(),

  // LLM tracing (optional — `langfuseConfigured()` gates it; both keys required
  // together, so a half-set pair traces nothing rather than dropping spans
  // silently). Prompt/completion bodies — which can carry a user's holdings —
  // are NOT exported unless LANGFUSE_CAPTURE_IO=on; metadata always is.
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().optional(),
  LANGFUSE_CAPTURE_IO: z.string().optional(),

  // Market data (optional — routes 503 when their key is missing).
  POLYGON_API_KEY: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),
  ALPACA_API_KEY: z.string().optional(),
  ALPACA_API_SECRET: z.string().optional(),
  ALPACA_BASE_URL: z.string().optional(),
  ALPACA_DATA_FEED: z.string().optional(),
  STOCKTWITS_ACCESS_TOKEN: z.string().optional(),
  REDDIT_ENABLED: z.string().optional(),
  REDDIT_USER_AGENT: z.string().optional(),

  // Plaid (optional — `plaidConfigured()` gates use). PLAID_TOKEN_KEY encrypts
  // access tokens at rest (Milestone 2 / W3); optional until that lands.
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_ENV: z.string().optional(),
  PLAID_TOKEN_KEY: z.string().optional(),

  // Billing (optional — `stripeConfigured()` gates use).
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ANALYST_MONTHLY: z.string().optional(),
  STRIPE_PRICE_ANALYST_ANNUAL: z.string().optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
  STRIPE_PRICE_PRO_ANNUAL: z.string().optional(),
  STRIPE_PRICE_QUANT_MONTHLY: z.string().optional(),
  STRIPE_PRICE_QUANT_ANNUAL: z.string().optional(),

  // Rate limiting (optional — falls back to in-memory limiter when absent).
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Email (optional — waitlist/weekly send is skipped when absent).
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_REPLY_TO: z.string().optional(),
  COMPANY_POSTAL_ADDRESS: z.string().optional(),

  // Access control + scheduled-job secrets (optional; safe defaults in code).
  ADMIN_UIDS: z.string().optional(),
  BETA_ADMIN_ONLY: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  MARKOV_INGEST_SECRET: z.string().optional(),

  // Finava Live (all optional — every /api/live/* route 503s when
  // LIVE_HARNESS_SECRET is absent, the same shape as stripeConfigured()).
  // LIVE_HARNESS_SECRET is deliberately NOT CRON_SECRET: it lives in a public
  // repo's Actions settings and authorizes a system that places orders, so its
  // blast radius must not overlap the cron routes'.
  LIVE_HARNESS_SECRET: z.string().optional(),
  LIVE_HARNESS_UID: z.string().optional(),
  LIVE_TRADING_ENABLED: z.string().optional(),
  LIVE_DAILY_CREDIT_CAP: z.string().optional(),
  LIVE_AGENT_VERSION: z.string().optional(),
  LIVE_AGENT_COMMIT: z.string().optional(),
  LIVE_LOG_REPO: z.string().optional(),

  // Investment research (all optional — the feature is off unless
  // INVESTMENT_RESEARCH_ENABLED is exactly "true", and Jev degrades to a
  // labelled fixed prior when TYPESAFE_API_KEY is absent, so a missing key
  // costs scenario probabilities rather than the whole feature).
  INVESTMENT_RESEARCH_ENABLED: z.string().optional(),
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL: z.string().optional(),

  // Local tooling paths (optional).
  MARKOV_SKILL_PATH: z.string().optional(),
  UV_PATH: z.string().optional(),
  BOT_STATUS_PATH: z.string().optional(),
});

const serverRaw = {
  NODE_ENV: process.env.NODE_ENV,
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  XAI_MODEL: process.env.XAI_MODEL,
  LLM_LOG: process.env.LLM_LOG,
  LLM_ROUTING: process.env.LLM_ROUTING,
  POLYGON_API_KEY: process.env.POLYGON_API_KEY,
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  ALPACA_API_KEY: process.env.ALPACA_API_KEY,
  ALPACA_API_SECRET: process.env.ALPACA_API_SECRET,
  ALPACA_BASE_URL: process.env.ALPACA_BASE_URL,
  ALPACA_DATA_FEED: process.env.ALPACA_DATA_FEED,
  STOCKTWITS_ACCESS_TOKEN: process.env.STOCKTWITS_ACCESS_TOKEN,
  REDDIT_ENABLED: process.env.REDDIT_ENABLED,
  REDDIT_USER_AGENT: process.env.REDDIT_USER_AGENT,
  PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
  PLAID_SECRET: process.env.PLAID_SECRET,
  PLAID_ENV: process.env.PLAID_ENV,
  PLAID_TOKEN_KEY: process.env.PLAID_TOKEN_KEY,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_PRICE_ANALYST_MONTHLY: process.env.STRIPE_PRICE_ANALYST_MONTHLY,
  STRIPE_PRICE_ANALYST_ANNUAL: process.env.STRIPE_PRICE_ANALYST_ANNUAL,
  STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY,
  STRIPE_PRICE_PRO_ANNUAL: process.env.STRIPE_PRICE_PRO_ANNUAL,
  STRIPE_PRICE_QUANT_MONTHLY: process.env.STRIPE_PRICE_QUANT_MONTHLY,
  STRIPE_PRICE_QUANT_ANNUAL: process.env.STRIPE_PRICE_QUANT_ANNUAL,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO,
  COMPANY_POSTAL_ADDRESS: process.env.COMPANY_POSTAL_ADDRESS,
  ADMIN_UIDS: process.env.ADMIN_UIDS,
  BETA_ADMIN_ONLY: process.env.BETA_ADMIN_ONLY,
  CRON_SECRET: process.env.CRON_SECRET,
  MARKOV_INGEST_SECRET: process.env.MARKOV_INGEST_SECRET,
  LIVE_HARNESS_SECRET: process.env.LIVE_HARNESS_SECRET,
  LIVE_HARNESS_UID: process.env.LIVE_HARNESS_UID,
  LIVE_TRADING_ENABLED: process.env.LIVE_TRADING_ENABLED,
  LIVE_DAILY_CREDIT_CAP: process.env.LIVE_DAILY_CREDIT_CAP,
  LIVE_AGENT_VERSION: process.env.LIVE_AGENT_VERSION,
  LIVE_AGENT_COMMIT: process.env.LIVE_AGENT_COMMIT,
  LIVE_LOG_REPO: process.env.LIVE_LOG_REPO,
  INVESTMENT_RESEARCH_ENABLED: process.env.INVESTMENT_RESEARCH_ENABLED,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  TYPESAFE_MODEL: process.env.TYPESAFE_MODEL,
  MARKOV_SKILL_PATH: process.env.MARKOV_SKILL_PATH,
  UV_PATH: process.env.UV_PATH,
  BOT_STATUS_PATH: process.env.BOT_STATUS_PATH,
};

export type ClientEnv = z.infer<typeof clientSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

let clientCache: ClientEnv | null = null;
let serverCache: ServerEnv | null = null;

/** Validated client env. Safe to call from the browser or the server. */
export function getClientEnv(): ClientEnv {
  if (clientCache) return clientCache;
  const parsed = clientSchema.safeParse(clientRaw);
  if (!parsed.success) {
    throw new Error(
      `Invalid client environment (NEXT_PUBLIC_*):\n${formatIssues(parsed.error)}\n` +
        `Set these in .env.local (local) or the Vercel project settings.`
    );
  }
  clientCache = parsed.data;
  return clientCache;
}

/** Validated server env. Import ONLY from server modules — never a client component. */
export function getServerEnv(): ServerEnv {
  if (serverCache) return serverCache;
  const parsed = serverSchema.safeParse(serverRaw);
  if (!parsed.success) {
    throw new Error(
      `Invalid server environment:\n${formatIssues(parsed.error)}\n` +
        `Set these in .env / .env.local (local) or the Vercel project settings.`
    );
  }
  serverCache = parsed.data;
  return serverCache;
}

/**
 * Validate both schemas. Called once from src/instrumentation.ts `register()` at
 * server startup so a misconfigured deployment fails fast with a single, clear
 * aggregated error instead of throwing cryptically on the first request.
 */
export function validateEnv(): void {
  getClientEnv();
  getServerEnv();
}
