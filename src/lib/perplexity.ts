import { recordUsage } from "@/lib/usage";
import { perplexityAsOfFilters } from "@/lib/asOfScope";

const BASE = "https://api.perplexity.ai";
const KEY = process.env.PERPLEXITY_API_KEY;

// Perplexity doesn't return token counts, so we meter a flat estimated cost per
// call (1 credit = $0.001). sonar-pro is the pricier model. TUNE to live rates.
export const PERPLEXITY_FLAT_CREDITS: Record<string, number> = {
  "sonar-pro": 150, // ≈ $0.15
  sonar: 80, // ≈ $0.08
};

export async function perplexitySearch(
  prompt: string,
  model: "sonar-pro" | "sonar" = "sonar-pro"
): Promise<string> {
  if (!KEY) return "Perplexity API key not configured.";

  // Clip the search to what was publishable by the run's as-of. Enforced by
  // Perplexity server-side rather than asked for in the prompt: a model told to
  // ignore recent results will still read them, and "please pretend it is June"
  // is not a control. Absent a scope (every ordinary chat) these stay undefined
  // and the search is unrestricted.
  //
  // Both filters matter. `search_before_date_filter` bounds publication;
  // `last_updated_before_filter` bounds revision, without which a page published
  // in June but rewritten in September still carries September's facts.
  const dateFilters = perplexityAsOfFilters();

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a financial research assistant. Provide concise, accurate, up-to-date financial analysis with specific data points and sources where available.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 2000,
      ...dateFilters,
    }),
  });

  if (!res.ok) throw new Error(`Perplexity ${res.status}`);
  const data = await res.json();
  // Meter the call against the ambient user's usage (no-op outside a user context).
  void recordUsage({
    agent: "perplexity",
    model: `perplexity/${model}`,
    flatCredits: PERPLEXITY_FLAT_CREDITS[model] ?? 100,
  });
  return data.choices?.[0]?.message?.content ?? "No response";
}
