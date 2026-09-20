import { generate } from "@/lib/llm";
import { getMarketSnapshot, getMarketNews } from "@/lib/finnhub";
import { getSkillsPrompt } from "@/agents/skills";
import { perplexitySearch } from "@/lib/perplexity";
import { fenceExternal, EXTERNAL_DATA_RULE } from "@/lib/externalContent";

export async function runMacroAgent(input: unknown): Promise<string> {
  const { sectors = [] } = input as { sectors?: string[] };

  let marketData = "Market data unavailable.";
  let newsData = "News unavailable.";
  let perplexityContext = "";

  if (process.env.FINNHUB_API_KEY) {
    try {
      const [snapshots, news] = await Promise.all([
        getMarketSnapshot(),
        getMarketNews("general"),
      ]);

      marketData = JSON.stringify(
        snapshots.map((s) => ({
          ticker: s.ticker,
          price: s.price,
          change: `${s.change > 0 ? "+" : ""}${s.changePct.toFixed(2)}%`,
        })),
        null,
        2
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      newsData = (news ?? []).slice(0, 8).map((n: any) => n.headline).join("\n");
    } catch { /* skip */ }
  }

  // Perplexity for deep macro research
  if (process.env.PERPLEXITY_API_KEY) {
    const sectorNote = sectors.length ? ` with focus on ${sectors.join(", ")} sectors` : "";
    try {
      perplexityContext = await perplexitySearch(
        `Current macroeconomic environment analysis${sectorNote}: Fed policy, inflation trends, interest rates, GDP outlook, sector rotation, and key risks for equity investors right now.`
      );
    } catch { /* skip */ }
  }

  const text = await generate({
    agent: "macro",
    system: [getSkillsPrompt("macro"), EXTERNAL_DATA_RULE].join("\n\n"),
    maxTokens: 10000,
    reasoning: 8000,
    prompt: `Analyze the current macro and market environment.${sectors.length ? ` Portfolio sectors: ${sectors.join(", ")}.` : ""}

Market snapshot (SPY, QQQ, IWM, sector ETFs):
${marketData}

Recent market headlines:
${newsData ? fenceExternal("finnhub market headlines", newsData) : "(none)"}

${perplexityContext ? `Deep macro research (Perplexity):\n${fenceExternal("perplexity macro research", perplexityContext)}` : ""}

Provide:
1. Overall market regime (risk-on/off, bull/bear)
2. Sector rotation analysis — leaders vs laggards
3. Key macro themes (Fed, rates, inflation, earnings cycle)
4. Implications for portfolio positioning
5. Near-term risks to watch

Be analytical and reference specific data points.`,
  });

  return text || "Macro analysis unavailable.";
}
