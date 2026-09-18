import { NextResponse, after } from "next/server";
import { anthropic, HAIKU } from "@/lib/anthropic";
import { ANSWER_HEADINGS } from "@/lib/answerFormat";
import { answerFollowupPrompt, parseFollowups } from "@/lib/chat/answerFollowups";
import { generate } from "@/lib/llm";
import { DATA_ACCURACY_RULE } from "@/lib/dataAccuracy";
import { promptClockLine } from "@/lib/promptClock";
import { aboutFinavaBlock } from "@/lib/aboutFinava";
import { withAuthRaw } from "@/lib/withRoute";
import { ChatRequestSchema } from "@/lib/schemas/chat";
import { pageContextPrompt, type PageContext } from "@/lib/pageContext";
import { getTemplateBlock } from "@/lib/templates.server";
import { loadDnaSummary } from "@/lib/investorDnaStore";
import { checkUsageLimit, recordUsage, makeRunContext } from "@/lib/usage";
import { logRunCost } from "@/lib/usageRunCost";
import { runTraced } from "@/lib/observability";
import { userRateLimit } from "@/lib/rateLimit";
import { EXTERNAL_DATA_RULE, fenceExternal } from "@/lib/externalContent";
import { extractTickers } from "@/lib/tickers";
import { isReuseFollowUp } from "@/lib/chat/intent";
import { getQuickContext, renderQuickContext, UNAVAILABLE, DEFAULT_BUDGET_MS, type QuickContext } from "@/lib/quickContext";
import { collectFacts, indexFacts, renderFactsBlock, readerBlock, FACT_CITATION_RULE, type FactsInput } from "@/lib/facts/promptBlock";
import { createCitationStream } from "@/lib/facts/citations";
import { loadChatFacts } from "@/lib/facts/chatFacts";
import { hasValue } from "@/lib/facts/types";
import { getExperienceLevel } from "@/lib/experienceLevel.server";
import {
  capabilityPromptBlock,
  checkCapabilities,
  DEFAULT_AVAILABILITY,
  FUND_ANSWER_RULE,
  isFundQuestion,
  wantsInsider,
  wantsPortfolio,
} from "@/lib/capabilityCheck";
import { isReusable, loadTurnData, saveTurnData } from "@/lib/turnData";
import { logger } from "@/lib/logger";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export const runtime = "nodejs";
export const maxDuration = 60;

const log = logger("chat");

/**
 * The fast grounded lane.
 *
 * The 13–14 Sep beta readout: Auto sent 80 of 138 turns to the 15-agent crew
 * (median 253 s), and 48 of 50 testers complained about the wait. Quick chat
 * answered in ~15 s but was ungrounded, so nobody trusted it. This route is now
 * the default for every question: fetch the handful of live numbers the answer
 * needs under a 2.5 s budget, then stream a contract-shaped answer. Target is
 * first token under 3 s after the data and the whole answer under 10 s.
 */

/**
 * The fast lane runs on Haiku, not Sonnet.
 *
 * Measured on this branch, same prompt, same live AMD data: Sonnet produced a
 * correct contract-shaped answer but took 20.6 s end to end — the model writes
 * ~900 tokens and Sonnet writes them slowly. The reasoning here is narration of
 * figures we already fetched, which is exactly what the cheap model is for, and
 * the 10 s budget is the whole point of the lane.
 */
const FAST_MODEL = HAIKU;

/** Content budget for a first answer — enough for the contract, not a report. */
const FAST_MAX_TOKENS = 2048;

/** A reformat of an answer we already gave needs far less room. */
const REUSE_MAX_TOKENS = 700;

/**
 * The answer contract, in fast-lane terms.
 *
 * The headings come from `@/lib/answerFormat` (W2-3) so what the model writes
 * and what the UI parses can never drift apart. The wording around them is the
 * lane's own: terser than the crew's, tied to the live data block, and with no
 * ## Details section — this lane answers in a screenful.
 */
const ANSWER_CONTRACT = `## Answer format

Write the answer in markdown using these exact H2 headings, in this order:

## ${ANSWER_HEADINGS.answer}
2-3 plain-English sentences. The verdict / the answer to the literal question. No hedging preamble.

## ${ANSWER_HEADINGS.keyNumbers}
A markdown table with columns: Metric | Value | Source | As of.
Only numbers that appear in the live data block above. A metric you were not given is "${UNAVAILABLE}".
When the data block gives fact IDs, put the ID right after the value in the Value cell ("51.3x [F:AAPL.pe]"); Source and As of are filled in from the fact.

## ${ANSWER_HEADINGS.bull}
Up to 3 bullets, ONE LINE each.

## ${ANSWER_HEADINGS.bear}
Up to 3 bullets, ONE LINE each.

## ${ANSWER_HEADINGS.changeView}
1-3 bullets, ONE LINE each.

## ${ANSWER_HEADINGS.confidence}
One line: High / Medium / Low, plus what data was missing (name it — e.g. "no analyst data for this ticker").

A purely conceptual question ("what is an ETF?") may use only ## ${ANSWER_HEADINGS.answer}.

Be terse. The whole answer is a screenful, not an essay — the reader wants the verdict and the numbers behind it, and W2-3's UI gives them somewhere to expand.

OVERRIDE: if the user asked for a particular brevity or format — "yes or no", "3 bullets", "simpler", "one line" — answer in the shape they asked for and ignore this contract entirely.`;

/** How the answer must treat the fetched data block. */
const GROUNDING_RULE = `Every number you state must come from the live data block above, and you must carry its source and as-of with it. If a number is not in that block, say "${UNAVAILABLE}" — do not recall it, estimate it, or infer it from a number that is there. If the block lists sources that were not retrieved in time, say so in ## Confidence & gaps.

You cannot fetch anything: this answer is written from the block above and nothing else, and there is no later turn in which you go and get more. Never write "fetching", "let me pull that", "one moment", "I'll look that up" or anything that promises data you don't have. If the answer needs more than the block has, say what is Unavailable and that "Run full analysis" gathers more.`;

/** The last user turn's plain text, for ticker extraction and follow-up detection. */
function lastUserText(messages: MessageParam[]): string {
  const last = messages.at(-1);
  return typeof last?.content === "string" ? last.content : "";
}

/** The user's earlier turns (oldest first), for questions that only make sense against them. */
function earlierUserTexts(messages: MessageParam[]): string[] {
  return messages
    .slice(0, -1)
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string);
}

interface TurnGrounding {
  quickContext: QuickContext | null;
  reusedData: boolean;
}

/**
 * The live data this turn answers from.
 *
 * A reformat follow-up ("so yes or no?", "3 bullets") reuses the previous
 * turn's fetch when it is still fresh — 13 testers hit exactly this and each
 * re-cut cost a whole new run. Anything else, or anything stale, refetches.
 * Never throws: an answer with no grounding still beats no answer.
 */
async function groundTurn(
  userId: string,
  text: string,
  body: { conversationId?: string; pageContext?: PageContext | null; portfolioContext?: string }
): Promise<TurnGrounding> {
  const convId = body.conversationId;

  if (convId && isReuseFollowUp(text)) {
    const stored = await loadTurnData(userId, convId).catch(() => null);
    if (isReusable(stored)) return { quickContext: stored!.quickContext, reusedData: true };
  }

  try {
    const quickContext = await getQuickContext({
      tickers: extractTickers(text),
      pageContext: body.pageContext ?? null,
      portfolioContext: body.portfolioContext,
    });
    await addRequestedFacts(userId, text, quickContext, body.portfolioContext);
    if (convId) {
      await saveTurnData(userId, convId, {
        quickContext,
        storedAt: new Date().toISOString(),
      }).catch(() => {});
    }
    return { quickContext, reusedData: false };
  } catch (err) {
    log.warn("fast lane could not fetch live data; answering without it", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { quickContext: null, reusedData: false };
  }
}

/**
 * Insider and portfolio facts, fetched only when the question is about them —
 * both are extra calls inside the turn's budget. Mutates the context so the
 * reuse path stores and replays them too. Never throws.
 */
async function addRequestedFacts(userId: string, text: string, qc: QuickContext, portfolioContext?: string) {
  const insider = qc.tickers.length > 0 && wantsInsider(text);
  const portfolio = !!portfolioContext && wantsPortfolio(text);
  if (!insider && !portfolio) return;
  try {
    const extra = await loadChatFacts({
      tickers: insider ? qc.tickers : [],
      insider,
      portfolioUserId: portfolio ? userId : undefined,
      deadlineMs: DEFAULT_BUDGET_MS,
      cachedOnly: true,
    });
    qc.factsInput = { ...qc.factsInput, ...extra.input, tickers: qc.factsInput?.tickers ?? [] };
    qc.dropped.push(...extra.dropped);
  } catch (err) {
    log.warn("fast lane could not load extra facts", { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Tickers this turn read without a cached Finava Score. The fast lane reads
 * scores from cache only (it never waits on a cold assembly), so a stock nobody
 * had opened stayed "Not scored yet" — the Sep-17 panel hit it on every ticker.
 */
function unscoredTickers(qc: QuickContext | null): string[] {
  if (!qc) return [];
  const scored = new Set((qc.factsInput?.tickers ?? []).filter((t) => hasValue(t.score)).map((t) => t.ticker));
  // A ticker whose facts didn't arrive in time at all is the coldest case.
  return qc.tickers.filter((t) => !scored.has(t));
}

/**
 * Score them after the answer is sent: the full facts read computes and caches
 * the score and DCF globally, so the next question (and the stock page) has
 * them. Best-effort; runs within this route's maxDuration.
 */
function scoreAfterResponse(tickers: string[]) {
  if (!tickers.length) return;
  after(async () => {
    const { getTickerFacts } = await import("@/lib/facts/ticker");
    await Promise.allSettled(tickers.map((t) => getTickerFacts(t, { deadlineMs: 45_000 })));
  });
}

/** Headlines with their article links, for the data block. */
function renderHeadlines(qc: QuickContext): string {
  const lines = ["Recent headlines:"];
  if (!qc.headlines.length) lines.push(`- ${UNAVAILABLE}`);
  for (const h of qc.headlines) lines.push(`- ${h.date} — ${h.headline} (${h.url ? `[${h.source}](${h.url})` : h.source})`);
  return lines.join("\n");
}

/**
 * The data block the model answers from. With facts, every number carries an
 * ID the answer must cite; a context stored before W4-1 has no facts and keeps
 * the old table.
 */
function renderDataBlock(qc: QuickContext, facts: FactsInput | undefined): string {
  if (!facts) return renderQuickContext(qc);
  const parts = [
    `Live data${qc.ticker ? ` for ${qc.tickers.join(", ")}` : ""} (fetched ${qc.fetchedAt}). FACTS:`,
    renderFactsBlock(collectFacts(facts)),
    "",
    renderHeadlines(qc),
  ];
  if (qc.dropped.length) parts.push("", `Not retrieved in time this turn: ${qc.dropped.join(", ")}.`);
  return parts.join("\n");
}

export async function POST(req: Request) {
  const res = await withAuthRaw({ body: ChatRequestSchema })(req);
  if (res instanceof NextResponse) return res;

  const { userId, body } = res;
  const { messages, portfolioContext, templateId, pageContext, conversationId } = body;

  // Per-user burst throttle, then the hard credit cap. The throttle caps
  // concurrent/scripted bursts the read-then-act meter could otherwise overshoot.
  const throttled = await userRateLimit(userId, "chat");
  if (throttled) return throttled;

  // Hard cap: block before any model spend if the user is over their allowance.
  const limited = await checkUsageLimit(userId);
  if (limited) return limited;

  const text = lastUserText(messages as MessageParam[]);

  // Optional user response-template — instructions/format injected ABOVE the
  // compliance block so it can shape tone/structure but never override it.
  // Fetched alongside the market data: neither depends on the other, and this
  // pair is the whole pre-model latency budget.
  const [templateBlock, grounding, dnaSummary, experienceLevel] = await Promise.all([
    getTemplateBlock(userId, templateId),
    groundTurn(userId, text, { conversationId, pageContext, portfolioContext }),
    loadDnaSummary(userId),
    getExperienceLevel(userId),
  ]);
  const { quickContext, reusedData } = grounding;

  const factsInput = quickContext?.factsInput;
  const factIndex = indexFacts(factsInput ? collectFacts(factsInput) : []);
  const dataBlock = quickContext
    ? fenceExternal("finava:live-market-data", renderDataBlock(quickContext, factsInput))
    : `No live market data was retrieved for this turn. Every market number is "${UNAVAILABLE}".`;

  // Say up front what we can't get, rather than a long answer that ends in "check your broker".
  const subject = quickContext?.ticker ?? null;
  const subjectFacts = factsInput?.tickers?.find((t) => t.ticker === subject);
  const capabilities = checkCapabilities(text, {
    ...DEFAULT_AVAILABILITY,
    priceTargets: !!subjectFacts && hasValue(subjectFacts.streetTarget),
  });
  const capabilityBlock = capabilityPromptBlock(capabilities, subject);
  const fundRule = isFundQuestion(text, earlierUserTexts(messages as MessageParam[])) ? FUND_ANSWER_RULE : "";

  const unscored = unscoredTickers(quickContext);
  scoreAfterResponse(unscored);
  const scoringNote = unscored.length
    ? `The Finava Score for ${unscored.join(", ")} is being computed now. If the score matters to the answer, say it will be ready on the next question; don't describe it as missing or unavailable for good.`
    : "";

  // Run the whole stream inside the usage context so every model call it makes
  // (this chat message + the follow-up generate()) is metered to this user.
  return runTraced(makeRunContext(userId, undefined, "fast"), () => {
    const startedAt = Date.now();
    const systemPrompt = `You are Finava, an expert AI financial research assistant. You help users research stocks, understand their portfolio, and make informed investment decisions of their own.

${promptClockLine()}
Date statements against today: results for fiscal periods that have ended are reported figures, not projections, and an unconfirmed earnings date is "(estimated)".
${pageContext ? `\n${pageContextPrompt(pageContext)}\n` : ""}
${portfolioContext ? `## User's Current Portfolio\n${portfolioContext}` : "The user has no portfolio holdings yet."}
${dnaSummary ? `\n${dnaSummary}\n` : ""}
## Live data for this turn
${EXTERNAL_DATA_RULE}

${dataBlock}

${GROUNDING_RULE}
${factIndex.size ? `\n${FACT_CITATION_RULE}\n` : ""}${scoringNote ? `\n${scoringNote}\n` : ""}${capabilityBlock ? `\n${capabilityBlock}\n` : ""}${fundRule ? `\n${fundRule}\n` : ""}
${readerBlock(experienceLevel)}

Be concise and data-driven. Use markdown formatting for clarity (tables, bullet points, etc.).

${DATA_ACCURACY_RULE}

${ANSWER_CONTRACT}

${aboutFinavaBlock()}
${templateBlock ? `\n${templateBlock}\n` : ""}
COMPLIANCE (non-negotiable): Finava is an impersonal research publication, not a registered investment adviser. Never give personalized investment advice — never tell the user what THEY should buy, sell, hold, or how to allocate THEIR portfolio, even when their holdings are shown above and even if they ask directly ("should I sell my AAPL?"). Instead, present the relevant impersonal analysis (fundamentals, valuation, risks, scenarios both ways) and remind them the decision is theirs to make with a licensed adviser. General, non-personalized analysis of any stock is fine, including scenario levels about the stock itself ("below $X the valuation case breaks") and the portfolio's measured weights and concentration as facts. Never give exit or sell-price levels for the user's positions, share counts to trade, rebalancing plans, or position-size rules of thumb applied to their holdings. Anything you know about the user's style is inferred: say "based on your holdings", never "your stated profile", and never label them with a risk tolerance. Note that content is not financial advice in one short line as the last line of the answer. Never open with a disclaimer: the answer comes first.`;

    const stream = anthropic.messages.stream({
      model: FAST_MODEL,
      max_tokens: reusedData ? REUSE_MAX_TOKENS : FAST_MAX_TOKENS,
      system: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } } as any,
      ],
      messages: messages as MessageParam[],
    });

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (payload: object) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        let ttftMs: number | null = null;
        // The finished answer, kept so the follow-up chips can be drawn from it.
        let answerText = "";
        // With facts, each streamed line is number-checked before it is sent: a
        // wrong cited figure is replaced with the fact's own value (W4-1).
        // Time to first token is what the reader sees, so it is taken at the first send.
        const sendText = (t: string) => {
          ttftMs ??= Date.now() - startedAt;
          send({ text: t });
        };
        const cited = factIndex.size
          ? createCitationStream(factIndex, sendText, {
              onMismatch: (m) => log.warn("cited number did not match its fact; replaced", { ...m }),
              onReattribute: (r) => log.info("cited number matched a different fact; kept", { ...r }),
            })
          : null;
        try {
          // Which lane answered, and whether it had to refetch. Four testers
          // asked to be told how the answer was produced.
          send({ meta: { lane: "fast", reusedData } });

          for await (const event of stream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              if (cited) {
                cited.push(event.delta.text);
              } else {
                answerText += event.delta.text;
                sendText(event.delta.text);
              }
            }
          }
          if (cited) {
            cited.flush();
            answerText = cited.text();
            const unknown = cited.unknownIds();
            if (unknown.length) log.warn("answer cited facts that were not in the block", { ids: unknown });
            // What the check compared, for the eval's mismatch rate (W4-3).
            send({ type: "number_check", ...cited.counts() });
          }
          // Meter this chat message's token usage against the user's allowance.
          try {
            const final = await stream.finalMessage();
            await recordUsage({
              agent: "chat",
              model: FAST_MODEL,
              inputTokens: final.usage?.input_tokens,
              outputTokens: final.usage?.output_tokens,
              cacheRead: final.usage?.cache_read_input_tokens,
            });
          } catch { /* metering is best-effort */ }
          // Follow-up chips come from the answer the user just read, not from
          // their question alone — chips about things the answer never covered
          // were a top beta complaint. This runs after the stream because the
          // finished text is its input.
          try {
            const raw = await generate({
              agent: "chatFollowups",
              maxTokens: 160,
              prompt: answerFollowupPrompt({ question: text, answer: answerText }),
            });
            const questions = parseFollowups(raw, { question: text });
            if (questions.length > 0) send({ followups: questions });
          } catch { /* follow-ups are best-effort */ }

          // Per-lane timing, so W4-3 can compare lanes on the re-run panel.
          const timing = { lane: "fast", ttftMs: ttftMs ?? Date.now() - startedAt, totalMs: Date.now() - startedAt, reusedData };
          log.info("chat lane finished", timing);
          send({ timing });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (err) {
          // What was already checked still reaches the reader before the error.
          cited?.flush();
          const msg = err instanceof Error ? err.message : "Stream error";
          send({ error: msg });
        } finally {
          // One run_cost line per answer, at the only point where the run is
          // actually over — the stream closing, not the handler returning.
          logRunCost({ reusedData });
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
