import { NextResponse } from "next/server";
import { generate } from "@/lib/llm";
import { withAuthRaw } from "@/lib/withRoute";
import { ClassifyRequestSchema } from "@/lib/schemas/chat";
import { pageContextRouteHint } from "@/lib/pageContext";
import { checkUsageLimit, usageStore, makeRunContext } from "@/lib/usage";
import { userRateLimit } from "@/lib/rateLimit";
import { promptClockLine } from "@/lib/promptClock";
import { recordProviderFailure } from "@/lib/providerHealth";
import { ROUTER_SYSTEM_PROMPT, resolveIntent, type ResolvedIntent } from "@/lib/chat/intent";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * The router's answer. `intent` is the lane Auto will actually run — see
 * `@/lib/chat/intent` for the rules that hold the model to it.
 */
interface ClassifyResult extends ResolvedIntent {
  /** Set only when the router model call failed and this is the default route. */
  degraded?: true;
}

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

export async function POST(req: Request) {
  const res = await withAuthRaw({ body: ClassifyRequestSchema })(req);
  if (res instanceof NextResponse) return res;

  const { userId, body } = res;
  const { userPrompt, history, portfolioContext, pageContext, allowClarify } = body;

  // The deterministic half of the decision, independent of the model. Computed
  // up front so an explicit "full analysis of NVDA" still reaches the crew when
  // the router itself is down.
  const intentCtx = { userPrompt, pageContext, portfolioContext, allowClarify };

  // Generous throttle — fires once per Auto-mode send, but it's a tiny call.
  const throttled = await userRateLimit(userId, "classify", { capacity: 15, refillPerSec: 1 });
  if (throttled) return throttled;

  const limited = await checkUsageLimit(userId);
  if (limited) return limited;

  // Default route — used on any model/parse failure so Auto never dead-ends.
  // Resolved through the same rules as a live answer, so the fast lane is the
  // floor and an explicit crew request is still honoured.
  const fallback: ClassifyResult = resolveIntent(null, intentCtx);

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
        system: ROUTER_SYSTEM_PROMPT,
        prompt,
        maxTokens: 200,
      });
      return resolveIntent(parseJson(raw), intentCtx) as ClassifyResult;
    } catch (err) {
      // Never silent: on 13 Sep an empty OpenRouter balance turned every Auto
      // send into plain chat with nothing in the logs and nothing on screen.
      console.error("[classify] router model failed, using default route:", err);
      recordProviderFailure("router");
      return { ...fallback, degraded: true as const };
    }
  });

  return NextResponse.json(result ?? fallback);
}
