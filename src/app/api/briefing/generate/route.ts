import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import { requireAuth } from "@/lib/requireAuth";
import { requireEntitlement } from "@/lib/entitlements";
import { generate } from "@/lib/llm";
import { DATA_ACCURACY_RULE } from "@/lib/dataAccuracy";
import { checkUsageLimit, usageStore, makeRunContext } from "@/lib/usage";
import { userRateLimit } from "@/lib/rateLimit";
import { runRiskAgent } from "@/agents/sub-agents/risk-agent";
import { runNewsAgent } from "@/agents/sub-agents/news-agent";
import { runMacroAgent } from "@/agents/sub-agents/macro-agent";
import { runTechnicalAgent } from "@/agents/sub-agents/technical-agent";
import { runEarningsAgent } from "@/agents/sub-agents/earnings-agent";
import { runInsiderAgent } from "@/agents/sub-agents/insider-agent";
import { runSentimentAgent } from "@/agents/sub-agents/sentiment-agent";
import { runAnalystAgent } from "@/agents/sub-agents/analyst-agent";
import { checkCache, saveCache } from "@/lib/agentMemory";
import { secretMatches } from "@/lib/secretMatches";
import { EXTERNAL_DATA_RULE } from "@/lib/externalContent";

export const maxDuration = 300;

// POST /api/briefing/generate — run agents on all holdings and create a briefing
export async function POST(req: Request) {
  // Allow cron secret OR authenticated user
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = secretMatches(cronSecret, process.env.CRON_SECRET);

  let userId: string;
  if (isCron) {
    // Cron: generate for all users with holdings
    return generateForAllUsers();
  } else {
    const authResult = await requireAuth();
    if (authResult.error) return authResult.error;
    userId = authResult.userId;
    const gate = await requireEntitlement(userId, "weeklyBriefings");
    if (gate) return gate;
    const throttled = await userRateLimit(userId, "briefing-generate");
    if (throttled) return throttled;
    const limited = await checkUsageLimit(userId);
    if (limited) return limited;
    return generateForUser(userId);
  }
}

async function generateForUser(userId: string): Promise<NextResponse> {
  // Meter every model call this briefing makes to the user (works for both the
  // interactive path and the cron path, which calls this per user).
  usageStore.enterWith(makeRunContext(userId));
  try {
    const holdingsSnap = await db
      .collection("users").doc(userId).collection("holdings")
      .orderBy("ticker").get();
    const holdings = holdingsSnap.docs.map((d) => d.data());

    if (!holdings.length) {
      return NextResponse.json({ error: "No holdings to brief" }, { status: 400 });
    }

    const tickers = holdings.map((h) => h.ticker);
    const portfolioContext = holdings
      .map((h) => `- ${h.ticker}${h.companyName ? ` (${h.companyName})` : ""}: ${h.shares} shares @ avg $${h.avgCost}`)
      .join("\n");

    // Run 8 agents in parallel (fastest subset — avoid EDGAR/Perplexity for weekly speed).
    // Ticker agents expect `tickers: string[]`, so pass the array, not a joined string.
    const [risk, news, macro, technical, earnings, insider, sentiment, analyst] = await Promise.allSettled([
      runWithCache("run_risk_agent",      { portfolio: portfolioContext }),
      runWithCache("run_news_agent",      { tickers }),
      runWithCache("run_macro_agent",     { tickers }),
      runWithCache("run_technical_agent", { tickers }),
      runWithCache("run_earnings_agent",  { tickers }),
      runWithCache("run_insider_agent",   { tickers }),
      runWithCache("run_sentiment_agent", { tickers }),
      runWithCache("run_analyst_agent",   { tickers }),
    ]);

    const sections = [
      { label: "Risk", result: risk },
      { label: "News", result: news },
      { label: "Macro", result: macro },
      { label: "Technical", result: technical },
      { label: "Earnings", result: earnings },
      { label: "Insider", result: insider },
      { label: "Sentiment", result: sentiment },
      { label: "Analyst", result: analyst },
    ]
      .filter((s) => s.result.status === "fulfilled")
      .map((s) => `### ${s.label}\n${(s.result as PromiseFulfilledResult<string>).value.slice(0, 1200)}`);

    // Synthesize into a briefing
    const content = await generate({
      agent: "briefingSynthesis",
      maxTokens: 3000,
      prompt: `You are Finava, a financial research assistant. Synthesize these agent reports into a polished weekly portfolio briefing.

## Portfolio
${portfolioContext}

## Agent Reports
${sections.join("\n\n")}

## Instructions
Write a **Weekly Portfolio Briefing** in this exact structure:
1. **Executive Summary** (3-4 sentences: key takeaways this week)
2. **Market Regime** (what's the macro environment doing)
3. **Position Updates** (brief bullet per holding: what changed, any alerts)
4. **Risks to Watch** (top 3 risks for the week ahead)
5. **Opportunities** (1-2 specific actionable ideas from the data)
6. **Watchlist** (any new tickers worth monitoring based on this week's signals)

${DATA_ACCURACY_RULE}

${EXTERNAL_DATA_RULE} The agent reports above can quote such blocks; the same applies there.

Be specific, cite data points from the reports, and keep it scannable. Start with "# Weekly Briefing — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}".`,
    });

    const now = new Date().toISOString();
    const briefingRef = await db
      .collection("users").doc(userId).collection("briefings")
      .add({ userId, content, tickers: JSON.stringify(tickers), readAt: null, createdAt: now });

    return NextResponse.json({
      id: briefingRef.id,
      content,
      tickers,
      createdAt: now,
    });
  } catch (err) {
    console.error("[briefing generate]", err);
    return NextResponse.json({ error: "Failed to generate briefing" }, { status: 500 });
  }
}

async function generateForAllUsers(): Promise<NextResponse> {
  // Find all users who have at least one holding (via collectionGroup query)
  const holdingsSnap = await db.collectionGroup("holdings").get();
  // Only users/{uid}/holdings. A collectionGroup query matches ANY collection
  // named "holdings", and a user could once plant one deeper in their own tree
  // (a "/" in a client-supplied id), making its parent doc look like a user.
  const userIds = [
    ...new Set(
      holdingsSnap.docs
        .map((d) => d.ref.parent.parent)
        .filter((u): u is NonNullable<typeof u> => !!u && u.parent.id === "users" && !u.parent.parent)
        .map((u) => u.id)
    ),
  ];

  const results = await Promise.allSettled(userIds.map((uid) => generateForUser(uid)));
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  return NextResponse.json({ generated: succeeded, total: userIds.length });
}

// Agent dispatch with cache check
const agentFns: Record<string, (input: unknown) => Promise<string>> = {
  run_risk_agent:      runRiskAgent,
  run_news_agent:      runNewsAgent,
  run_macro_agent:     runMacroAgent,
  run_technical_agent: runTechnicalAgent,
  run_earnings_agent:  runEarningsAgent,
  run_insider_agent:   runInsiderAgent,
  run_sentiment_agent: runSentimentAgent,
  run_analyst_agent:   runAnalystAgent,
};

async function runWithCache(agentName: string, input: unknown): Promise<string> {
  const cached = await checkCache(agentName, input);
  if (cached) return cached;
  const fn = agentFns[agentName];
  if (!fn) throw new Error(`Unknown agent: ${agentName}`);
  const result = await fn(input);
  saveCache(agentName, input, result).catch((err) =>
    console.warn("[briefing] cache save failed", err)
  );
  return result;
}
