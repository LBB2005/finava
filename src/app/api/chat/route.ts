import { NextResponse } from "next/server";
import { anthropic, MODEL } from "@/lib/anthropic";
import { generate } from "@/lib/llm";
import { DATA_ACCURACY_RULE } from "@/lib/dataAccuracy";
import { promptClockLine } from "@/lib/promptClock";
import { aboutFinavaBlock } from "@/lib/aboutFinava";
import { withAuthRaw } from "@/lib/withRoute";
import { ChatRequestSchema } from "@/lib/schemas/chat";
import { pageContextPrompt } from "@/lib/pageContext";
import { getTemplateBlock } from "@/lib/templates.server";
import { checkUsageLimit, recordUsage, makeRunContext } from "@/lib/usage";
import { runTraced } from "@/lib/observability";
import { userRateLimit } from "@/lib/rateLimit";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const res = await withAuthRaw({ body: ChatRequestSchema })(req);
  if (res instanceof NextResponse) return res;

  const { userId, body } = res;
  const { messages, portfolioContext, templateId, pageContext } = body;

  // Per-user burst throttle, then the hard credit cap. The throttle caps
  // concurrent/scripted bursts the read-then-act meter could otherwise overshoot.
  const throttled = await userRateLimit(userId, "chat");
  if (throttled) return throttled;

  // Hard cap: block before any model spend if the user is over their allowance.
  const limited = await checkUsageLimit(userId);
  if (limited) return limited;

  // Optional user response-template — instructions/format injected ABOVE the
  // compliance block so it can shape tone/structure but never override it.
  const templateBlock = await getTemplateBlock(userId, templateId);

  // Run the whole stream inside the usage context so every model call it makes
  // (this chat message + the follow-up generate()) is metered to this user.
  return runTraced(makeRunContext(userId), () => {
    const systemPrompt = `You are Finava, an expert AI financial research assistant. You help users research stocks, understand their portfolio, and make informed investment decisions of their own.

${promptClockLine()}
Date statements against today: results for fiscal periods that have ended are reported figures, not projections, and an unconfirmed earnings date is "(estimated)".
${pageContext ? `\n${pageContextPrompt(pageContext)}\n` : ""}
${portfolioContext ? `## User's Current Portfolio\n${portfolioContext}` : "The user has no portfolio holdings yet."}

Be concise and data-driven. Use markdown formatting for clarity (tables, bullet points, etc.).

${DATA_ACCURACY_RULE}

${aboutFinavaBlock()}
${templateBlock ? `\n${templateBlock}\n` : ""}
COMPLIANCE (non-negotiable): Finava is an impersonal research publication, not a registered investment adviser. Never give personalized investment advice — never tell the user what THEY should buy, sell, hold, or how to allocate THEIR portfolio, even when their holdings are shown above and even if they ask directly ("should I sell my AAPL?"). Instead, present the relevant impersonal analysis (fundamentals, valuation, risks, scenarios both ways) and remind them the decision is theirs to make with a licensed adviser. General, non-personalized analysis of any stock is fine, including scenario levels about the stock itself ("below $X the valuation case breaks") and the portfolio's measured weights and concentration as facts. Never give exit or sell-price levels for the user's positions, share counts to trade, or rebalancing plans. Anything you know about the user's style is inferred: say "based on your holdings", never "your stated profile". Note that content is not financial advice.`;

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 8192,
      system: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } } as any,
      ],
      messages: messages as MessageParam[],
    });

    const lastUserContent = (messages as MessageParam[]).at(-1);
    const lastUserText =
      typeof lastUserContent?.content === "string"
        ? lastUserContent.content
        : "";

    // Follow-up suggestions depend only on the user's question, so run the
    // (cheap) call concurrently with the main stream instead of serializing it
    // after the last token. `.catch` attached immediately so an early rejection
    // can never surface as an unhandled rejection.
    const followupsPromise: Promise<string | null> = generate({
      agent: "chatFollowups",
      maxTokens: 120,
      prompt: `Generate exactly 3 short follow-up research questions (max 12 words each). Return a JSON array of strings only.\n\nQuestion: ${lastUserText.slice(0, 200)}`,
    }).catch(() => null);

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const event of stream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const data = JSON.stringify({ text: event.delta.text });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          }
          // Meter this chat message's token usage against the user's allowance.
          try {
            const final = await stream.finalMessage();
            await recordUsage({
              agent: "chat",
              model: MODEL,
              inputTokens: final.usage?.input_tokens,
              outputTokens: final.usage?.output_tokens,
              cacheRead: final.usage?.cache_read_input_tokens,
            });
          } catch { /* metering is best-effort */ }
          // Emit follow-up suggestions (started concurrently with the stream)
          try {
            const raw = await followupsPromise;
            const match = raw?.match(/\[[\s\S]*\]/);
            if (match) {
              const questions = JSON.parse(match[0]) as string[];
              if (Array.isArray(questions) && questions.length > 0) {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ followups: questions.slice(0, 3).map(String) })}\n\n`
                ));
              }
            }
          } catch { /* follow-ups are best-effort */ }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Stream error";
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`)
          );
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
