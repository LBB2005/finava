import { generate } from "@/lib/llm";
import { getRecommendationTrends, getPriceTarget, getQuote } from "@/lib/finnhub";
import { getSkillsPrompt } from "@/agents/skills";
import { perplexitySearch } from "@/lib/perplexity";
import { fenceExternal, EXTERNAL_DATA_RULE } from "@/lib/externalContent";

interface AnalystInput {
  tickers: string[];
}

interface RecTrend {
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
  period?: string;
}

interface PriceTarget {
  targetHigh?: number;
  targetLow?: number;
  targetMean?: number;
  targetMedian?: number;
  numberOfAnalysts?: number;
  lastUpdated?: string;
}

export async function runAnalystAgent(input: unknown): Promise<string> {
  const { tickers } = input as AnalystInput;

  const results = await Promise.allSettled(
    tickers.map(async (ticker) => {
      const [recRes, ptRes, quoteRes] = await Promise.allSettled([
        getRecommendationTrends(ticker),
        getPriceTarget(ticker),
        getQuote(ticker),
      ]);

      const rec: RecTrend | null =
        recRes.status === "fulfilled"
          ? (recRes.value as RecTrend[] | undefined)?.[0] ?? null
          : null;
      const pt: PriceTarget | null =
        ptRes.status === "fulfilled" ? (ptRes.value as PriceTarget | null) : null;
      const currentPrice =
        quoteRes.status === "fulfilled" ? quoteRes.value?.price ?? null : null;

      // Computed here, not by the model (W4-1): the consensus score and the upside.
      const counts = [rec?.strongBuy, rec?.buy, rec?.hold, rec?.sell, rec?.strongSell].map((n) => n ?? 0);
      const totalAnalysts = counts.reduce((a, b) => a + b, 0);
      const consensusScore = totalAnalysts
        ? Math.round(((counts[0] * 2 + counts[1] - counts[3] - counts[4] * 2) / totalAnalysts) * 100) / 100
        : null;
      const upsidePct =
        typeof pt?.targetMean === "number" && pt.targetMean > 0 && typeof currentPrice === "number" && currentPrice > 0
          ? Math.round((pt.targetMean / currentPrice - 1) * 1000) / 10
          : null;

      return {
        ticker,
        currentPrice,
        totalAnalysts,
        consensusScore,
        upsidePct,
        // Finnhub recommendation trend (most recent period)
        strongBuy: rec?.strongBuy ?? null,
        buy: rec?.buy ?? null,
        hold: rec?.hold ?? null,
        sell: rec?.sell ?? null,
        strongSell: rec?.strongSell ?? null,
        period: rec?.period ?? null,
        // Finnhub price target
        targetHigh: pt?.targetHigh ?? null,
        targetLow: pt?.targetLow ?? null,
        targetMean: pt?.targetMean ?? null,
        targetMedian: pt?.targetMedian ?? null,
        numberOfAnalysts: pt?.numberOfAnalysts ?? null,
        lastUpdated: pt?.lastUpdated ?? null,
      };
    })
  );

  const data = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));

  // Finnhub's /stock/price-target is premium-gated on our plan (returns 403), so
  // targetMean/High/Low come back null and the table would show "N/A" for every
  // target. When NO ticker has a structured price target, fall back to a single
  // Perplexity web search for consensus targets. It's web-sourced (less precise
  // than a feed), so we fence it as external data and label it as such.
  const hasStructuredTargets = data.some((d) => typeof d.targetMean === "number" && d.targetMean > 0);
  let webTargets = "";
  if (!hasStructuredTargets && process.env.PERPLEXITY_API_KEY) {
    webTargets = await perplexitySearch(
      `For each of these tickers — ${tickers.join(", ")} — give the current Wall Street consensus analyst price target: the average (mean) 12-month price target, the low and high target in the range, and the number of analysts. Respond as a compact list, one line per ticker: "TICKER: avg $X, range $low–$high, N analysts". If a figure is unknown, write "unknown" rather than guessing.`
    ).catch(() => "");
  }

  const text = await generate({
    agent: "analyst",
    system: [getSkillsPrompt("analyst"), webTargets ? EXTERNAL_DATA_RULE : ""].filter(Boolean).join("\n\n"),
    maxTokens: 2000,
    prompt: `You are a financial analyst summarizing Wall Street consensus for the following tickers.

Raw analyst data (structured feed — recommendation counts are reliable; targetMean/High/Low may be null because the price-target feed is unavailable on our plan):
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
${webTargets ? `
Price targets were unavailable from the structured feed, so the block below is web-sourced consensus. Use it ONLY to fill the Avg Target / Range columns. Treat numbers as approximate and append " (web)" to any target value you take from it. Upside % stays "N/A" for a web-sourced target — do not calculate it.

${fenceExternal("perplexity consensus price targets", webTargets)}
` : ""}

Every derived number is already computed in the data above — quote it; never do arithmetic yourself. For each ticker, present:
1. **Consensus Rating**: map \`consensusScore\` (−2 to +2; weights strongBuy +2, buy +1, hold 0, sell −1, strongSell −2) to Strong Buy (≥1.5) / Buy (≥0.5) / Hold (> −0.5) / Sell (> −1.5) / Strong Sell.
2. **Analyst Count**: \`totalAnalysts\`.
3. **Avg Price Target**: Use targetMean if present; otherwise use the web-sourced average above (append " (web)").
4. **Target Range**: Low – High (from the feed, or the web-sourced range).
5. **Upside %**: \`upsidePct\` as given ("N/A" when null). Flag if > 30% as potentially aggressive.
6. **Rating Distribution**: brief "10 Buy / 5 Hold / 2 Sell" summary.

**Output format:**
1. A markdown table: | Ticker | Rating | Analysts | Avg Target | Range | Upside % |
2. For each ticker with > 20% divergence between targetHigh and targetLow: add a ⚠️ note explaining the wide spread.
3. A 2-3 sentence synthesized takeaway: what does Wall Street think overall about this basket of stocks?

Use "N/A" for missing data. If only one ticker is requested, skip the synthesis and give a 3-sentence single-stock analyst summary instead.`,
  });

  return text || "Analyst consensus data unavailable.";
}
