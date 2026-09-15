import { NextResponse } from "next/server";
import { generate } from "@/lib/llm";
import { withAuthRaw } from "@/lib/withRoute";
import { ClassifyRequestSchema } from "@/lib/schemas/chat";
import { pageContextRouteHint } from "@/lib/pageContext";
import { checkUsageLimit, usageStore, makeRunContext } from "@/lib/usage";
import { userRateLimit } from "@/lib/rateLimit";
import { promptClockLine } from "@/lib/promptClock";

export const runtime = "nodejs";
export const maxDuration = 30;

type Intent = "simple" | "agent" | "discover";

interface ClassifyResult {
  intent: Intent;
  needsClarify: boolean;
  clarifyQuestion?: string;
  clarifyChips?: string[];
}

const SYSTEM = `You are the router for Finava, an AI stock-research chat. Classify the user's latest message into ONE intent and decide whether a single clarifying question is needed BEFORE answering.

Intents:
- "agent": the user names one or more specific stocks/tickers, or asks to analyze / value / get a verdict on a named company, or asks about THEIR portfolio (e.g. "full analysis of NVDA", "is TSLA a buy?", "review my holdings", "how risky is my portfolio?"). This deploys a multi-agent research crew.
- "discover": the user wants to FIND/SCREEN/DISCOVER stocks WITHOUT naming specific tickers (e.g. "find cheap energy stocks", "best AI plays right now", "which stocks have low debt and high growth?", "ideas for dividend income").
- "simple": greetings, definitions, quick factual or conceptual questions, and conversational follow-ups (e.g. "what's a P/E ratio?", "thanks", "explain what you just said", "how does the market work?"). Default here when unsure.

needsClarify — set TRUE only when ALL hold:
- the request is open-ended discovery or advice ("what should I buy?", "what's good right now?"), AND
- answering it well genuinely requires a user preference not stated (time horizon, sector focus, or risk tolerance).
Bias HARD toward false. Specific questions, named tickers, definitions, and anything already containing a sector/style/size/valuation cue do NOT need clarification.

When needsClarify is true, write ONE short friendly clarifyQuestion and 3-4 short tappable clarifyChips (e.g. "Growth & momentum", "Value & income", "Quality compounders", "A specific sector").

Respond with ONLY a JSON object, no prose:
{"intent":"simple|agent|discover","needsClarify":boolean,"clarifyQuestion":"...","clarifyChips":["...","..."]}`;

function parseJson(raw: string): Record<string, unknown> | null {
  const fenced = raw.replace(/```(?:json)?/gi, "");
  const match = fenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function coerce(parsed: Record<string, unknown> | null): ClassifyResult {
  const intentRaw = String(parsed?.intent ?? "simple");
  const intent: Intent =
    intentRaw === "agent" || intentRaw === "discover" ? intentRaw : "simple";
  const needsClarify = parsed?.needsClarify === true;
  const result: ClassifyResult = { intent, needsClarify };
  if (needsClarify) {
    const q = parsed?.clarifyQuestion;
    if (typeof q === "string" && q.trim()) result.clarifyQuestion = q.trim();
    const chips = parsed?.clarifyChips;
    if (Array.isArray(chips)) {
      const clean = chips.map(String).filter(Boolean).slice(0, 4);
      if (clean.length) result.clarifyChips = clean;
    }
    // A clarify with no question/chips is useless — degrade to a plain route.
    if (!result.clarifyQuestion || !result.clarifyChips) {
      return { intent, needsClarify: false };
    }
  }
  return result;
}

export async function POST(req: Request) {
  const res = await withAuthRaw({ body: ClassifyRequestSchema })(req);
  if (res instanceof NextResponse) return res;

  const { userId, body } = res;
  const { userPrompt, history, portfolioContext, pageContext } = body;

  // Generous throttle — fires once per Auto-mode send, but it's a tiny call.
  const throttled = await userRateLimit(userId, "classify", { capacity: 15, refillPerSec: 1 });
  if (throttled) return throttled;

  const limited = await checkUsageLimit(userId);
  if (limited) return limited;

  // Default route — used on any model/parse failure so Auto never dead-ends.
  const fallback: ClassifyResult = { intent: "simple", needsClarify: false };

  const result = await usageStore.run(makeRunContext(userId), async () => {
    try {
      const historyBlock = (history ?? [])
        .slice(-6)
        .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
        .join("\n");
      // A viewed page pins the subject: vague references ("is this a buy?",
      // "review these") are about what's on that page, so route accordingly and
      // never clarify "which stock?" — the subject is already known.
      const pageBlock = pageContext ? `${pageContextRouteHint(pageContext)}\n` : "";
      const prompt = [
        promptClockLine(),
        historyBlock ? `Recent conversation:\n${historyBlock}\n` : "",
        pageBlock,
        portfolioContext ? "The user HAS a portfolio with holdings.\n" : "",
        `Latest message: ${userPrompt.slice(0, 2000)}`,
      ]
        .filter(Boolean)
        .join("\n");

      const raw = await generate({
        agent: "chatRouter",
        system: SYSTEM,
        prompt,
        maxTokens: 200,
      });
      return coerce(parseJson(raw));
    } catch {
      return fallback;
    }
  });

  return NextResponse.json(result ?? fallback);
}
