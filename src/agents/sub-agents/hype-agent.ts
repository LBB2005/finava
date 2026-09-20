/**
 * Hype Score Agent
 * Uses Perplexity's sonar-pro model (real-time web search) to measure
 * AI/narrative momentum and retail hype for a ticker across Reddit, X/Twitter,
 * news, and YouTube. Returns a 0–10 hype score with evidence.
 */

import { getSkillsPrompt } from "@/agents/skills";
import { perplexityAsOfFilters } from "@/lib/asOfScope";
import { recordUsage } from "@/lib/usage";
import { PERPLEXITY_FLAT_CREDITS } from "@/lib/perplexity";
import { fenceExternal } from "@/lib/externalContent";

const PERPLEXITY_API = "https://api.perplexity.ai/chat/completions";

export async function runHypeAgent(input: unknown): Promise<string> {
  const { ticker, companyName } = input as { ticker: string; companyName?: string };
  const apiKey = process.env.PERPLEXITY_API_KEY;

  if (!apiKey) {
    return `HYPE SCORE: N/A\n\nPerplexity API key not configured. Add PERPLEXITY_API_KEY to .env.local to enable hype scoring.`;
  }

  const nameLabel = companyName ? `${ticker} (${companyName})` : ticker;

  const systemPrompt = [
    getSkillsPrompt("hype"),
    "Your job is to search the web for real-time discussion and hype around stocks, then produce a structured analysis.",
    "Be specific — cite actual post titles, headlines, and communities you found. Do not fabricate evidence.",
  ].filter(Boolean).join("\n\n");

  const userPrompt = `Search Reddit, X/Twitter, financial news sites, YouTube, and any other public sources for discussion about ${nameLabel} in the last 7 days.

Evaluate:
1. Volume of discussion (how much are people talking about it?)
2. Tone and excitement level (bullish/bearish/neutral, and how intense?)
3. Narrative strength — is there a compelling story (AI, earnings beat, product launch, short squeeze, etc.)?
4. Any viral posts, trending threads, or major influencer coverage?
5. Meme stock / retail frenzy signals vs. institutional narrative?

Then output your analysis in this EXACT format:

HYPE SCORE: [0.0–10.0]/10
(0 = no one talking about it, 10 = full viral frenzy)

NARRATIVE DRIVERS:
• [Key theme/catalyst 1 with evidence]
• [Key theme/catalyst 2 with evidence]
• [Key theme/catalyst 3 with evidence]
• [Add more if relevant]

SENTIMENT BREAKDOWN:
Reddit: [bullish/bearish/neutral] — [brief description of what you found]
X/Twitter: [bullish/bearish/neutral] — [brief description]
News: [bullish/bearish/neutral] — [brief description]
YouTube/Other: [bullish/bearish/neutral] — [brief description]

KEY RISK: [One sentence — is the hype justified or ahead of fundamentals?]

NOTABLE QUOTES/POSTS:
"[Verbatim or paraphrased quote from actual post/headline]" — [source]
"[Another quote]" — [source]`;

  try {
    const res = await fetch(PERPLEXITY_API, {
      method: "POST",
      signal: AbortSignal.timeout(45_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1200,
        // Clipped to the run's as-of when one is scoped; unrestricted otherwise.
        ...perplexityAsOfFilters(),
        temperature: 0.2,
        search_recency_filter: "week",
        return_citations: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Perplexity ${res.status}: ${errText}`);
    }

    const data = await res.json();
    // A direct Perplexity call, so it meters itself (it was missed entirely).
    void recordUsage({
      agent: "hype",
      model: "perplexity/sonar-pro",
      flatCredits: PERPLEXITY_FLAT_CREDITS["sonar-pro"] ?? 100,
    });
    const content = data.choices?.[0]?.message?.content ?? "";

    // Append citations if returned
    const citations: string[] = data.citations ?? [];
    const citationBlock =
      citations.length > 0
        ? `\n\nSOURCES:\n${citations.slice(0, 5).map((c, i) => `[${i + 1}] ${c}`).join("\n")}`
        : "";

    // Social posts and web pages quoted verbatim, handed straight to the crew lead:
    // fenced so injected instructions in them read as data, never as orders.
    return fenceExternal("perplexity social/news hype research", content + citationBlock);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[hype-agent] error:", msg);
    return `HYPE SCORE: N/A\n\nError fetching hype data: ${msg}\n\nThis agent requires PERPLEXITY_API_KEY and network access to Perplexity's API.`;
  }
}
