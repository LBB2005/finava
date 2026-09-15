// Model display registry — presentation only.
//
// Maps the OpenRouter model slugs used in `src/lib/llm.ts` to the user-facing
// *brand* (Claude / GPT / Gemini / Grok / Perplexity) we badge on the stock page
// and in the chat crew. Badges are brand-level on purpose: the Gemini *version*
// (2.5 today) can change without touching the story or this file.
//
// IMPORTANT: this module must stay free of any `@/lib/llm` import so it is safe
// to pull into client components. The server passes the resolved slug (or a
// precomputed brand list) down via SSE; the client only needs the maps here.

export type Brand = "claude" | "openai" | "gemini" | "grok" | "perplexity";

export interface BrandMeta {
  /** Full label, e.g. "GPT-5.5" */
  label: string;
  /** Compact label for tight badges, e.g. "GPT" */
  short: string;
  /** Brand accent (used for the glyph + pill tint). */
  accent: string;
}

export const BRAND_META: Record<Brand, BrandMeta> = {
  claude: { label: "Claude", short: "Claude", accent: "#d97757" },
  openai: { label: "GPT-5.5", short: "GPT", accent: "#10a37f" },
  gemini: { label: "Gemini", short: "Gemini", accent: "#4285f4" },
  grok: { label: "Grok", short: "Grok", accent: "#1a1a1a" },
  perplexity: { label: "Perplexity", short: "Perplexity", accent: "#20808d" },
};

/**
 * What a run actually did, as reported by the code that ran it. Absent fields
 * mean "unknown" and earn no claim.
 */
export interface RunMeta {
  /** Real X posts the Grok x_search tool returned (0 = degraded / no posts). */
  xSearchPosts?: number;
  /** Web sources a live-search model cited. */
  webSources?: number;
}

/**
 * Role line for a brand's tooltip, derived from run metadata rather than a
 * static map: a badge must describe what ran, not what the model is capable of.
 * Returns null when there is nothing true to say (e.g. Grok answered from a
 * plain completion, so no X search happened).
 */
export function brandRole(brand: Brand, run?: RunMeta): string | null {
  switch (brand) {
    case "grok":
      return run?.xSearchPosts != null && run.xSearchPosts > 0 ? "X search" : null;
    case "perplexity":
      return run?.webSources != null && run.webSources > 0 ? "Live web" : null;
    default:
      return null;
  }
}

/** Resolve an OpenRouter model slug to its display brand. */
export function slugToBrand(slug: string): Brand {
  if (slug.startsWith("openai/")) return "openai";
  if (slug.startsWith("x-ai/")) return "grok";
  if (slug.startsWith("google/")) return "gemini";
  if (slug.startsWith("perplexity/")) return "perplexity";
  // anthropic/* and the routing-OFF Sonnet/Haiku fallback both read as Claude.
  return "claude";
}

// Presentation-only pipeline overrides, keyed by AgentKey value. Most agents are
// single-model; a few are genuine multi-model pipelines we want to show honestly.
// `news`: Perplexity sources the live web → Gemini summarizes it with the
// Finnhub headline feed. `hype` calls Perplexity directly (not via generate()).
const AGENT_BADGE: Record<string, Brand[]> = {
  news: ["perplexity", "gemini"],
  hype: ["perplexity"],
};

/**
 * The ordered brand list to badge for an agent. Pass the agent's resolved model
 * slug (from `AGENT_MODELS` on the server) as a fallback for the common
 * single-model case; pipeline agents ignore it in favour of the override above.
 */
export function badgeBrands(agentKey: string, slug?: string): Brand[] {
  if (AGENT_BADGE[agentKey]) return AGENT_BADGE[agentKey];
  return slug ? [slugToBrand(slug)] : [];
}

/** De-duped, display-ordered brand roster for a "powered by" strip. */
export function rosterFromBrands(brands: Brand[]): Brand[] {
  const order: Brand[] = ["claude", "openai", "gemini", "grok", "perplexity"];
  const present = new Set(brands);
  return order.filter((b) => present.has(b));
}
