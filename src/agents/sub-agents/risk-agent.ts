import { generate } from "@/lib/llm";
import { getCandles, getSnapshots } from "@/lib/finnhub";
import { getSkillsPrompt } from "@/agents/skills";
import { positionShocks } from "@/lib/facts/precomputed";

export async function runRiskAgent(
  input: unknown,
  holdings: { ticker: string; shares: number }[] = []
): Promise<string> {
  const { tickers, focus } = input as { tickers: string[]; focus?: string };

  const toTs = Math.floor(Date.now() / 1000);
  const fromTs = toTs - 252 * 24 * 60 * 60;

  let riskData = "";
  // Computed-in-code portfolio block: real position weights + weighted beta, so
  // the LLM never extrapolates a single holding's beta onto the whole portfolio.
  let portfolioBlock = "";
  const betaByTicker = new Map<string, number>();

  if (process.env.FINNHUB_API_KEY && tickers.length > 0) {
    try {
      const [snapshots, spyCandles] = await Promise.all([
        getSnapshots(tickers),
        getCandles("SPY", "D", fromTs, toTs),
      ]);

      const spyCloses: number[] = spyCandles?.c ?? [];
      const spyReturns = spyCloses.slice(1).map((c, i) => (c - spyCloses[i]) / spyCloses[i]);
      const spyMean = spyReturns.reduce((a, b) => a + b, 0) / spyReturns.length;
      const spyVar = spyReturns.reduce((a, b) => a + (b - spyMean) ** 2, 0) / spyReturns.length;

      const tickerMetrics: Record<string, object> = {};

      await Promise.allSettled(
        tickers.map(async (ticker) => {
          try {
            const candles = await getCandles(ticker, "D", fromTs, toTs);
            const closes: number[] = candles?.c ?? [];
            const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
            const vol = (Math.sqrt(variance * 252) * 100).toFixed(1);

            const minLen = Math.min(returns.length, spyReturns.length);
            const cov = returns.slice(-minLen).reduce((a, x, i) =>
              a + (x - mean) * (spyReturns[i + spyReturns.length - minLen] - spyMean), 0
            );
            const betaNum = spyVar > 0 ? cov / (minLen * spyVar) : NaN;
            if (Number.isFinite(betaNum)) betaByTicker.set(ticker, betaNum);
            const beta = Number.isFinite(betaNum) ? betaNum.toFixed(2) : "N/A";

            const snap = snapshots.find((s) => s.ticker === ticker);
            tickerMetrics[ticker] = {
              annualizedVolatility: `${vol}%`,
              beta,
              currentPrice: snap?.price ?? "N/A",
              dailyChange: snap ? `${snap.changePct.toFixed(2)}%` : "N/A",
            };
          } catch {
            tickerMetrics[ticker] = { error: "Could not compute" };
          }
        })
      );

      riskData = JSON.stringify(tickerMetrics, null, 2);

      // ── Position weights + weighted portfolio beta (deterministic) ──────────
      const priced = holdings
        .map((h) => {
          const snap = snapshots.find((s) => s.ticker === h.ticker);
          const price = typeof snap?.price === "number" ? snap.price : null;
          return price && h.shares > 0
            ? { ticker: h.ticker, value: price * h.shares, beta: betaByTicker.get(h.ticker) }
            : null;
        })
        .filter((x): x is { ticker: string; value: number; beta: number | undefined } => !!x);
      const total = priced.reduce((a, p) => a + p.value, 0);
      if (total > 0) {
        const rows = priced
          .map((p) => ({ ...p, weight: p.value / total }))
          .sort((a, b) => b.weight - a.weight);
        const covered = rows.filter((r) => typeof r.beta === "number");
        const coveredWeight = covered.reduce((a, r) => a + r.weight, 0);
        const portBeta = coveredWeight > 0
          ? covered.reduce((a, r) => a + r.weight * (r.beta as number), 0) / coveredWeight
          : null;
        const weightLines = rows
          .map((r) => `  - ${r.ticker}: ${(r.weight * 100).toFixed(1)}% of portfolio${typeof r.beta === "number" ? `, beta ${r.beta.toFixed(2)}` : ", beta N/A"}`)
          .join("\n");
        // Each position's dollar change if its price falls, computed here (W4-1).
        const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
        const shockLines = rows
          .map((r) => `  - ${r.ticker} ${usd(r.value)} → ${positionShocks(r.value).map((s) => `−${s.shockPct}%: ${usd(s.loss)}`).join(" · ")}`)
          .join("\n");
        const ddLine = portBeta !== null
          ? `- Estimated portfolio decline in a 30% market drop ≈ ${(portBeta * 30).toFixed(0)}% (= weighted beta × 30%; assumes betas hold and ignores correlation breakdown — a rough upper-bound anchor, not a point forecast)`
          : "- Weighted portfolio beta could not be computed — do not estimate a portfolio-level drawdown.";
        portfolioBlock = `

PORTFOLIO-LEVEL RISK — COMPUTED, AUTHORITATIVE (use these exact figures; do not derive your own):
- Priced portfolio value: $${total.toLocaleString("en-US", { maximumFractionDigits: 0 })}
- Position weights:
${weightLines}
- Position $ change if that stock falls 10/20/30%:
${shockLines}${portBeta !== null ? `\n- Weighted portfolio beta: ${portBeta.toFixed(2)} (Σ weightᵢ·betaᵢ over priced holdings${coveredWeight < 0.999 ? `, covering ${(coveredWeight * 100).toFixed(0)}% of value` : ""})` : ""}
${ddLine}

NON-NEGOTIABLE: Any "portfolio loss in an X% drawdown" claim MUST use the weighted portfolio beta above — NEVER apply a single holding's beta to the whole portfolio. Flag any position over 20% of portfolio value as HIGH concentration.`;
      }
    } catch {
      riskData = "Could not fetch market data.";
    }
  }

  if (!portfolioBlock) {
    portfolioBlock = `

PORTFOLIO-LEVEL RISK: Per-position weights were not available. Do NOT estimate a whole-portfolio drawdown from any single holding's beta — state that position sizes are required for portfolio-level loss math.`;
  }

  const focusNote = focus ? `\nFocus on: ${focus}` : "";

  const text = await generate({
    agent: "risk",
    system: getSkillsPrompt("risk"),
    maxTokens: 10000,
    reasoning: 8000,
    cache: true,
    prompt: `Analyze the risk profile of this portfolio (tickers: ${tickers.join(", ")}).${focusNote}

Risk metrics:
${riskData}${portfolioBlock}

Provide:
1. Overall portfolio risk assessment
2. Concentration risks and overweight positions (use the computed position weights above)
3. Beta analysis (market sensitivity)
4. Volatility comparison across holdings
5. A worst-case drawdown scenario that uses the weighted portfolio beta and the position dollar changes above — not any single holding's beta, and no dollar figure you worked out yourself
6. Specific risk concerns and position-sizing recommendations`,
  });

  return text || "Risk analysis unavailable.";
}
