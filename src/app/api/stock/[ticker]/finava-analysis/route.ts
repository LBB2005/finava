// Finava Analysis — deterministic 15-factor score, streamed. The FINAVA tab POSTs here.
//
// We assemble real per-metric data (EDGAR + Finnhub metric/candles/peers + Grok X
// sentiment + insider flow), compute the score DETERMINISTICALLY via computeFinavaScore
// (six pillars, each a weighted blend of factors, with exclude-and-reweight on missing
// data), and stream the six pillar signals followed by a verdict. The LLM is used ONLY
// to write the narrative ("the take") around the already-decided numbers — never to pick
// the score. A narrative failure still ships the deterministic verdict, flagged
// `fallback: true` (no model badge, not cached).
//
// Because the pillars are COMPUTED, they carry no model badge — only the narrative does.
// The completed run is persisted via saveVerdict for the cached-first stock page.

import { generate, AGENT_MODELS } from "@/lib/llm";
import { requireAuth } from "@/lib/requireAuth";
import { checkUsageLimit, usageStore, makeRunContext } from "@/lib/usage";
import { userRateLimit } from "@/lib/rateLimit";
import { getStockBundle } from "@/lib/stockData";
import { assembleScoreInputs } from "@/lib/finavaInputs";
import {
  computeFinavaScore,
  blendFairValue,
  type PillarScore,
  type PillarKey,
} from "@/lib/finavaScore";
import {
  stanceFromScore,
  verdictLabel,
  SIGNAL_ORDER,
  type FinavaSignal,
  type FinavaVerdict,
  type SignalKey,
  type FinavaEvent,
} from "@/lib/finava";
import { DATA_ACCURACY_RULE } from "@/lib/dataAccuracy";
import { saveVerdict } from "@/lib/verdictStore";

export const runtime = "nodejs";

const FALLBACK_TAKE = "AI analysis unavailable right now — showing factor data only.";
export const maxDuration = 60;

/** Pull the first JSON object out of a model response, tolerating code fences. */
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

function toStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, 4);
}

/** Headline = the most extreme present factor in the pillar, with a direction word. */
function topFactorHeadline(p: PillarScore): string {
  const present = p.factors.filter((f) => f.score != null);
  if (present.length === 0) return "Limited data";
  const top = present.reduce((a, b) =>
    Math.abs(b.score! - 50) > Math.abs(a.score! - 50) ? b : a
  );
  const dir = top.score! >= 60 ? "Strong" : top.score! <= 40 ? "Weak" : "Mixed";
  return `${dir} ${top.label.toLowerCase()}`;
}

function pillarToSignal(p: PillarScore): FinavaSignal {
  const score = p.score == null ? 50 : Math.round(p.score);
  const present = p.factors.filter((f) => f.score != null);
  return {
    key: p.key as SignalKey,
    label: p.label,
    score,
    isNoData: p.score == null, // dark pillar: UI renders N/A instead of a 50 bar
    stance: stanceFromScore(score),
    headline: p.score == null ? "No data yet" : topFactorHeadline(p),
    detail:
      present.map((f) => f.detail).slice(0, 2).join(" · ") ||
      "Insufficient data for a confident signal.",
    factors: p.factors.map((f) => ({ key: f.key, label: f.label, score: f.score, detail: f.detail })),
  };
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { userId, error: authError } = await requireAuth();
  if (authError) return authError;
  const throttled = await userRateLimit(userId, "finava-analysis");
  if (throttled) return throttled;
  const limited = await checkUsageLimit(userId);
  if (limited) return limited;
  usageStore.enterWith(makeRunContext(userId));

  const { ticker } = await params;
  const symbol = (ticker ?? "").trim().toUpperCase();
  if (!symbol) {
    return new Response(JSON.stringify({ error: "Missing ticker." }), { status: 400 });
  }

  let bundle;
  try {
    bundle = await getStockBundle(symbol);
  } catch (err) {
    console.error("[finava bundle]", symbol, err);
    return new Response(JSON.stringify({ error: "Failed to load stock data." }), { status: 500 });
  }
  if (!bundle.quote && !bundle.profile) {
    return new Response(JSON.stringify({ error: `Couldn't find ${symbol}.` }), { status: 404 });
  }

  const name = bundle.profile?.name ?? symbol;
  const price = bundle.quote?.price ?? null;
  const street = bundle.analysts?.targetMean ?? null;
  const newsSentiment = bundle.sentiment?.score ?? null;
  const insiderTrades = bundle.insider;

  const encoder = new TextEncoder();
  // Assembly (incl. a Grok call up to ~30s) runs INSIDE start() so the HTTP response
  // opens immediately — the client shows its streaming/skeleton state instead of a
  // pending request, and a slow ticker can't trip a client-side fetch timeout. The
  // score is still computed deterministically before any signal is sent.
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: FinavaEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));

      try {
        const inputs = await assembleScoreInputs(symbol, price, insiderTrades, newsSentiment, name);
        const result = computeFinavaScore(inputs);
        const dcfFair = inputs.dcfFair;
        const fairValue = blendFairValue({ dcf: dcfFair, street });
        const upsidePct =
          fairValue != null && price && price > 0 ? ((fairValue - price) / price) * 100 : null;

        // Steady peer-relative read: avg premium/discount of P/E & P/S vs the peer
        // group. Headlined on the card until a Street anchor makes fairValue credible.
        const pePrem = inputs.peTTM != null && inputs.peTTM > 0 && inputs.peerPe != null && inputs.peerPe > 0
          ? inputs.peTTM / inputs.peerPe - 1 : null;
        const psPrem = inputs.psTTM != null && inputs.psTTM > 0 && inputs.peerPs != null && inputs.peerPs > 0
          ? inputs.psTTM / inputs.peerPs - 1 : null;
        const prems = [pePrem, psPrem].filter((x): x is number => x != null);
        const peerPremiumPct = prems.length ? (prems.reduce((a, b) => a + b, 0) / prems.length) * 100 : null;

        // Stream the six pillar signals in display order.
        const byKey = new Map<PillarKey, PillarScore>(result.pillars.map((p) => [p.key, p]));
        const signals: FinavaSignal[] = [];
        for (const key of SIGNAL_ORDER) {
          const p = byKey.get(key as PillarKey);
          if (!p) continue;
          const signal = pillarToSignal(p);
          signals.push(signal);
          send({ type: "signal", signal });
        }

        // ── Narrative (LLM only writes prose around the decided numbers) ────────
        // A narrative failure (provider error or no usable take) is NOT dressed
        // up as model output: no badge, a plain "unavailable" line, and no cache
        // write — so a canned sentence never persists under "Powered by …".
        let take = FALLBACK_TAKE;
        let catalysts: string[] = [];
        let risks: string[] = [];
        let fallback = true;
        try {
          const pillarLine = result.pillars
            .map((p) => `${p.label} ${p.score == null ? "n/a" : Math.round(p.score)}`)
            .join(", ");
          const synthPrompt = `You are Finava's lead equity analyst writing research color (not advice) for a retail investor. We have ALREADY computed a deterministic Finava Score for ${name} (${symbol}) — do NOT invent a different score.

${DATA_ACCURACY_RULE}

Finava Score: ${result.score}/100 (${verdictLabel(result.score)}), confidence ${result.confidence}.
Pillar scores: ${pillarLine}.
Current price: ${price != null ? `$${price.toFixed(2)}` : "n/a"}. Blended fair value: ${fairValue != null ? `$${fairValue.toFixed(2)}` : "n/a"}. DCF: ${dcfFair != null ? `$${dcfFair.toFixed(2)}` : "n/a"}. Street target: ${street != null ? `$${street.toFixed(2)}` : "n/a"}.

Explain WHY the score is what it is, grounded in the pillar scores and valuation gap. Respond with ONLY this JSON (no markdown):
{"take":"<2-3 sentences, specific to these pillar numbers>","catalysts":["<short>","<short>"],"risks":["<short>","<short>"]}`;

          const raw = await generate({ agent: "finavaSynthesis", maxTokens: 700, prompt: synthPrompt });
          const p = parseJson(raw);
          if (p && typeof p.take === "string" && p.take.trim()) {
            take = p.take.trim();
            catalysts = toStrings(p.catalysts);
            risks = toStrings(p.risks);
            fallback = false;
          }
        } catch (err) {
          console.error("[finava take]", symbol, err);
        }

        const verdict: FinavaVerdict = {
          score: result.score,
          stance: verdictLabel(result.score),
          confidence: result.confidence,
          fairValue,
          upsidePct,
          peerPremiumPct,
          take,
          catalysts,
          risks,
          comparison: { finava: fairValue, street, dcf: dcfFair },
          fallback,
          // generate() doesn't report which model answered; finavaSynthesis is
          // routed to Claude and its failover is also Claude, so the brand holds.
          ...(fallback ? {} : { model: AGENT_MODELS["finavaSynthesis"] }),
        };
        send({ type: "verdict", verdict });

        // Persist the completed run for the cached-first stock page (rail /
        // Overview Read / tab hydration). Awaited so the serverless runtime
        // can't kill the write after the stream closes; saveVerdict never throws.
        // Fallback runs are not cached (see above).
        if (!fallback) await saveVerdict(userId, symbol, verdict, signals);
      } catch (err) {
        console.error("[finava assemble]", symbol, err);
        send({ type: "error", message: "Failed to compute the Finava Score." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
