import { NextResponse } from "next/server";
import { runCeoAgent } from "@/agents/ceo";
import { runDiscoveryWave, runDiscoverySynthesis } from "@/agents/discovery";
import { withAuthRaw } from "@/lib/withRoute";
import { AgentRequestSchema } from "@/lib/schemas/agent";
import { pageContextPrompt } from "@/lib/pageContext";
import { userRateLimit } from "@/lib/rateLimit";
import {
  checkUsageLimit,
  checkDeepResearchAllowed,
  recordDeepResearchRun,
  usageStore,
  makeRunContext,
} from "@/lib/usage";
import type { AgentEvent } from "@/types/chat";
import type { WaveRequest, SynthesizeRequest } from "@/lib/scoutTypes";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  // Auth + validate/bound the body (caps prompt/history sizes — cost control).
  const res = await withAuthRaw({ body: AgentRequestSchema })(req);
  if (res instanceof NextResponse) return res;
  const { userId, body } = res;

  const {
    userPrompt,
    portfolioContext,
    deepResearch,
    conversationHistory,
    holdings,
    discover,
    tier,
    wave,
    templateId,
    pageContext,
    conversationId,
  } = body;

  // Fold the viewed-page snapshot into the CEO's context block so the crew scopes
  // its work to the stock the user is looking at (and resolves "this"/"it" to that
  // ticker), without threading a new arg through every sub-agent.
  const ceoContext = pageContext
    ? `${pageContextPrompt(pageContext)}\n\n${portfolioContext ?? ""}`.trim()
    : portfolioContext ?? "";

  // Per-user burst throttle: each run is a long, expensive crew, so cap
  // concurrent/scripted bursts before the read-then-act credit meter can be
  // overshot. Tighter than the chat default since one run does far more work.
  const throttled = await userRateLimit(userId, "agent", { capacity: 4, refillPerSec: 0.1 });
  if (throttled) return throttled;

  // Hard cap: block before any model spend if the user is over their allowance.
  const limited = await checkUsageLimit(userId);
  if (limited) return limited;

  // Deep Research is the one explicitly-counted op. Count a run only on the
  // initiating CEO turn — the follow-up `wave`/`synthesize` calls are
  // continuations of an already-counted run and must not be re-charged or
  // stranded mid-session by the cap.
  const isDeepInitiation = !wave && (!!deepResearch || tier === "deep");
  if (isDeepInitiation) {
    const deepLimited = await checkDeepResearchAllowed(userId);
    if (deepLimited) return deepLimited;
    // Increment at run START (not completion) so a burst of concurrent runs
    // can't all slip past the pre-check. A failed run still counts — an
    // accepted anti-abuse trade-off.
    void recordDeepResearchRun(userId);
  }

  // Run the whole crew inside the usage context so every sub-agent generate()
  // call and the CEO's direct Anthropic turns are metered to this user.
  return usageStore.run(makeRunContext(userId), () => {
    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        const emit = (event: AgentEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        try {
          if (wave && wave.synthesize) {
            // Final discovery synthesis — one Sonnet pass, no crew. Shape is
            // validated inside runDiscoverySynthesis; cast through unknown.
            await runDiscoverySynthesis(wave as unknown as SynthesizeRequest, emit);
          } else if (wave) {
            // One deterministic crew wave over ≤5 names.
            await runDiscoveryWave(wave as unknown as WaveRequest, emit);
          } else {
            // Normal CEO turn (incl. quick discover + deep shortlist emit).
            await runCeoAgent(userPrompt ?? "", ceoContext, emit, {
              deepResearch: !!deepResearch,
              // Length-capped by the schema; element shape is consumed loosely
              // downstream, so cast to the expected param types.
              conversationHistory: (conversationHistory ?? []) as {
                role: "user" | "assistant";
                content: string;
              }[],
              userId,
              holdings: (Array.isArray(holdings) ? holdings : []) as {
                ticker: string;
                shares: number;
              }[],
              discover: !!discover,
              tier: tier === "deep" ? "deep" : "quick",
              templateId: typeof templateId === "string" ? templateId : undefined,
              conversationId: typeof conversationId === "string" ? conversationId : undefined,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          console.error("[agent route error]", err);
          emit({ type: "error", message: msg });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Disable proxy/CDN buffering so SSE chunks flush immediately on Vercel.
        "X-Accel-Buffering": "no",
      },
    });
  });
}
