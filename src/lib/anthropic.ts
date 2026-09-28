import Anthropic from "@anthropic-ai/sdk";
import { tournamentFetch } from "./tournament/modelTransport";
import { observeAnthropic } from "@/lib/observability";

export const MODEL = "claude-sonnet-4-6";
export const HAIKU = "claude-haiku-4-5";

// Store the singleton on globalThis so it survives Turbopack HMR module
// re-evaluations. Module-level `let _client` resets on every hot reload,
// which is what causes "ANTHROPIC_API_KEY is not set" on follow-up requests
// after any file edit. globalThis persists for the lifetime of the Node.js
// process regardless of how many times individual modules are re-evaluated.
const g = globalThis as typeof globalThis & { __anthropicClient?: Anthropic };

function getClient(): Anthropic {
  if (!g.__anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the dev server."
      );
    }
    // Wrapped for tracing at construction so every call-site — the CEO loop, the
    // chat SSE stream, discovery — is observed without touching any of them.
    // The wrapper is a pass-through until Langfuse is configured AND registered.
    g.__anthropicClient = observeAnthropic(new Anthropic({ apiKey, fetch: tournamentFetch }));
  }
  return g.__anthropicClient;
}

// Proxy so all existing `anthropic.messages.create(...)` call-sites keep working
// without any changes — the proxy forwards every property access to the lazily
// created client.
export const anthropic = new Proxy({} as Anthropic, {
  get(_target, prop: string | symbol) {
    const client = getClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});
