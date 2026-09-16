"use client";
import { useEffect, useRef } from "react";
import { mutate } from "swr";
import { authFetch } from "@/lib/authFetch";
import { useChatStore, type SendRequest } from "@/stores/chatStore";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useQuotes } from "@/hooks/useQuotes";
import { useToast } from "@/hooks/useToast";
import { buildPortfolioContext } from "./ChatContainer";
import type { Conversation } from "@/components/layout/ConversationList";
import type { ChatMessage, ChatMode, AgentEvent } from "@/types/chat";
import type { ChatContext } from "@/lib/chatContext";
import type { PageContext } from "@/lib/pageContext";
import { planWaves, mergeWaveEvidence, mergeWaves } from "@/lib/discoveryRun";
import { applyFinalResponse, readSseData } from "@/lib/chat/stream";
import { agentBody, classifyBody, discoverScoutBody, simpleChatBody, streamAgent, streamSimple } from "@/lib/chat/requests";
import { discoverToMarkdown } from "@/lib/chat/discoverText";
import { RunRegistry, stoppedMessage } from "@/lib/chat/runControl";
import { INTENTS, type Intent } from "@/lib/chat/intent";
import { toStoredMessage } from "@/lib/chat/storedMessage";
import {
  emptyEvidence,
  type ScoutPick,
  type DiscoverEvidence,
  type WaveEvidence,
  type DiscoverMessageContent,
  type DiscoverLayout,
} from "@/lib/scoutTypes";

// One AbortController per in-flight conversation run, so a single chat can be
// stopped or cancelled without disturbing the others.
const runs = new RunRegistry();

// Which lane is producing the current run's answer, so Stop can label the
// partial message with the right mode.
const laneMode = new Map<string, ChatMode>();

const store = () => useChatStore.getState();

/** Cancel a conversation's run outright (e.g. the chat was deleted). */
export function abortConversationStream(convId: string) {
  runs.cancel(convId);
}

async function persistMessage(convId: string, msg: ChatMessage): Promise<void> {
  await authFetch(`/api/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toStoredMessage(msg)),
  });
}

/**
 * The user pressed Stop. Keeps whatever had streamed as a "Stopped" message and
 * unlocks the composer immediately; the aborted run unwinds quietly later.
 */
export function stopConversationStream(convId: string) {
  const st = store();
  const slice = st.slice(convId);
  if (!runs.stop(convId)) return;
  const durationMs = slice.streamStartedAt != null ? Date.now() - slice.streamStartedAt : undefined;
  const msg = stoppedMessage(slice, laneMode.get(convId) ?? "fast", durationMs);
  laneMode.delete(convId);
  st.addMessage(convId, msg);
  st.setStreaming(convId, false);
  st.clearStreamingContent(convId);
  st.setCeoThinking(convId, "");
  st.setPendingCritique(convId, "");
  st.setPendingFollowups(convId, []);
  st.setDiscoverProgress(convId, null);
  persistMessage(convId, msg).catch((e) => console.warn("[stop] saveMessage failed:", e));
}

// Auto mode: when the router asks a clarifying question, we stash the original
// prompt here keyed by conversation. The user's next message (a chip tap or
// typed reply) is treated as the answer and folded back into that prompt.
const pendingClarify = new Map<string, { originalPrompt: string }>();

/**
 * Headless chat engine. Mounted once in the app shell (next to GlobalComposer),
 * outside the route-keyed <main>, so streams survive navigation and several
 * conversations can generate at the same time. It drains the store's send queue;
 * each send runs as its own async task writing to that conversation's slice.
 */
export default function ChatEngine() {
  const { holdings, cashBalance } = usePortfolio();
  const { quoteMap } = useQuotes(holdings.map((h) => h.ticker));
  const toast = useToast();

  // Snapshot the latest portfolio context so async streams don't capture stale
  // closures.
  const ctxRef = useRef({ holdings, cashBalance, quoteMap });
  ctxRef.current = { holdings, cashBalance, quoteMap };

  const sendQueue = useChatStore((s) => s.sendQueue);
  const pendingMessage = useChatStore((s) => s.pendingMessage);

  // ── store action shorthands (all keyed by convId) ──
  const s = store;

  // A hard usage-cap returns HTTP 429 from the AI routes. Surface it as a clear
  // toast that links to the usage page. Returns true when it was a limit hit.
  async function handleUsageLimit(res: Response): Promise<boolean> {
    if (res.status !== 429) return false;
    const info = (await res.json().catch(() => null)) as { scope?: string } | null;
    const scope = info?.scope === "daily" ? "daily" : "weekly";
    toast.error(`You've reached your ${scope} AI usage limit.`, {
      action: { label: "View usage", onClick: () => { window.location.href = "/settings?section=usage"; } },
    });
    return true;
  }

  // Surface a chat failure as a toast with a Retry — but only when the failing
  // conversation is the one the user is currently viewing. A background-stream
  // error for conversation X must not pop a toast while the user is on Y.
  function notifyChatError(ownerConvId: string | null, message: string, retry: () => void) {
    const activeConvId = s().conversationId;
    const isActive = ownerConvId == null || ownerConvId === activeConvId;
    if (!isActive) return;
    toast.error(message, { action: { label: "Retry", onClick: retry } });
  }

  /** Release the run's hold on the conversation. A stopped or replaced run is a no-op. */
  function endRun(convId: string, ctrl: AbortController | undefined) {
    if (!runs.finish(convId, ctrl)) return;
    laneMode.delete(convId);
    s().setStreaming(convId, false);
    s().clearStreamingContent(convId);
  }

  // Drop an optimistic row into the sidebar list cache synchronously, so the
  // recents entry and the originating page's nav pulse appear the instant you
  // hit send — before the server write round-trips.
  function insertOptimisticConversation(id: string, context: ChatContext, firstText: string, mode: ChatMode) {
    const now = new Date().toISOString();
    const optimistic: Conversation = {
      id,
      title: null,
      context: context ?? null,
      createdAt: now,
      updatedAt: now,
      messages: [{ id: crypto.randomUUID(), role: "user", content: firstText, mode, createdAt: now }],
    };
    void mutate(
      "/api/conversations",
      (prev: Conversation[] | undefined) => [optimistic, ...(prev ?? []).filter((c) => c.id !== id)],
      { revalidate: false }
    );
  }

  // Persist the conversation under the client-generated id. Awaited before any
  // message write so the parent doc exists, but NOT before the streaming UI
  // renders — that's already shown optimistically.
  async function createConversation(id: string, context: ChatContext, pageContext?: PageContext | null): Promise<void> {
    await authFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title: null, context, pageContext: pageContext ?? undefined }),
    });
  }

  /** Add an assistant/user message to the store and persist it. */
  async function commitMessage(convId: string, msg: ChatMessage) {
    s().addMessage(convId, msg);
    await persistMessage(convId, msg).catch((e) => console.warn(`[${msg.mode}] saveMessage failed:`, e));
  }

  /** Elapsed ms since this conversation's stream began, for the response receipt. */
  function streamDuration(convId: string): number | undefined {
    const startedAt = s().slice(convId).streamStartedAt;
    return startedAt != null ? Date.now() - startedAt : undefined;
  }

  /**
   * The fast grounded lane (W2-1): live data under a 2.5 s budget, then one
   * streamed answer. `mode` is "fast" from Auto and "simple" from the manual
   * Quick mode — the route is the same either way.
   */
  async function runSimpleChat(text: string, portfolioContext: string, convId: string, mode: ChatMode, history: ChatMessage[], templateId?: string, pageContext?: PageContext | null) {
    const ctrl = runs.get(convId);
    laneMode.set(convId, mode);
    try {
      const fullContent = await streamSimple(
        authFetch,
        simpleChatBody({ prior: history, text, portfolioContext, templateId, pageContext, conversationId: convId }),
        {
          signal: ctrl?.signal,
          onResponse: handleUsageLimit,
          onText: (t) => s().appendStreamChunk(convId, t),
          onFollowups: (q) => s().setPendingFollowups(convId, q),
        }
      );
      if (fullContent == null || !runs.isCurrent(convId, ctrl)) return;

      const followups = s().slice(convId).pendingFollowups;
      s().setPendingFollowups(convId, []);
      await commitMessage(convId, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: fullContent,
        mode,
        createdAt: new Date().toISOString(),
        followups: followups.length ? followups : undefined,
        durationMs: streamDuration(convId),
      });
    } finally {
      endRun(convId, ctrl);
    }
  }

  async function runAgentMode(text: string, portfolioContext: string, convId: string, mode: ChatMode, deepResearch = false, history: ChatMessage[] = [], templateId?: string, pageContext?: PageContext | null) {
    const ctrl = runs.get(convId);
    const answerMode: ChatMode = deepResearch ? "deep_research" : "agent";
    laneMode.set(convId, answerMode);
    s().setAgentSteps(convId, []);
    s().setCeoThinking(convId, "");
    // Last run's crew panel must not linger over this one; `crew_plan` refills it.
    s().setCrewProgress(convId, null);

    const retry = () => { void runAgentMode(text, portfolioContext, convId, mode, deepResearch, history, templateId, pageContext); };

    try {
      const finalContent = await streamAgent(
        authFetch,
        {
          ...agentBody({
            prior: history,
            text,
            portfolioContext,
            deepResearch,
            holdings: ctxRef.current.holdings.map((h) => ({ ticker: h.ticker, shares: h.shares })),
            templateId,
            pageContext,
          }),
          // Keys the crew's gathered outputs so a short follow-up can be answered
          // from them by the fast lane instead of re-running the whole crew.
          conversationId: convId,
        },
        {
          signal: ctrl?.signal,
          onResponse: handleUsageLimit,
          onEvent: (event) => handleAgentEvent(event, convId, { convId, retry }),
        }
      );

      if (finalContent && runs.isCurrent(convId, ctrl)) {
        const sl = s().slice(convId);
        s().setPendingCritique(convId, "");
        s().setPendingFollowups(convId, []);
        await commitMessage(convId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: finalContent,
          mode: answerMode,
          createdAt: new Date().toISOString(),
          agentTrace: sl.agentSteps,
          critique: sl.pendingCritique || undefined,
          followups: sl.pendingFollowups.length ? sl.pendingFollowups : undefined,
          durationMs: streamDuration(convId),
        });
      }
    } finally {
      // The finished run's crew state lives on the committed message's agentTrace;
      // the live panel is cleared so it can't outlast the run that produced it.
      if (runs.isCurrent(convId, ctrl)) s().setCrewProgress(convId, null);
      endRun(convId, ctrl);
    }
  }

  // ── Discovery funnel ────────────────────────────────────────────────────────

  async function postAgentStream(
    body: object,
    onEvent: (e: AgentEvent) => void,
    parent: AbortController | undefined,
    timeoutMs?: number
  ) {
    // A stopped run must not start its next phase.
    if (parent?.signal.aborted) return;
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    // Cancel this wave if the whole conversation run is stopped.
    const onParentAbort = () => controller.abort();
    parent?.signal.addEventListener("abort", onParentAbort);
    try {
      const res = await authFetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error("Discovery stream failed");
      await readSseData(res.body, (data) => {
        try { onEvent(JSON.parse(data) as AgentEvent); } catch { /* ignore */ }
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") throw e;
      // Soft abort — caller proceeds with whatever evidence arrived.
    } finally {
      if (timer) clearTimeout(timer);
      parent?.signal.removeEventListener("abort", onParentAbort);
    }
  }

  // Discover results are stored as readable text (what the model sees in
  // history) with the structured payload alongside for the card.
  async function pushDiscover(dc: DiscoverMessageContent, convId: string, extra?: Partial<ChatMessage>) {
    await commitMessage(convId, {
      id: crypto.randomUUID(),
      role: "assistant",
      content: discoverToMarkdown(dc),
      attachment: dc,
      mode: "discover",
      createdAt: new Date().toISOString(),
      ...extra,
    });
  }

  async function runDiscoverMode(
    text: string,
    portfolioContext: string,
    convId: string,
    tier: "quick" | "deep",
    seed?: { picks: ScoutPick[]; query: string; evidence: DiscoverEvidence; startWave: number },
    history: ChatMessage[] = []
  ) {
    const ctrl = runs.get(convId);
    laneMode.set(convId, "discover");
    const live = () => runs.isCurrent(convId, ctrl);
    s().setAgentSteps(convId, []);
    s().setCeoThinking(convId, "");
    const retry = () => { void runDiscoverMode(text, portfolioContext, convId, tier, seed, history); };
    try {
      let picks: ScoutPick[] = seed?.picks ?? [];
      let query = seed?.query ?? text;
      let evidence: DiscoverEvidence = seed?.evidence ?? emptyEvidence();

      // Phase 1 — scout (skipped on resume).
      if (!seed) {
        s().clearStreamingContent(convId);
        s().setCeoThinking(convId, "Scanning all 500 S&P names…");
        let framing = "";
        let clarify: { question: string; chips: string[] } | null = null;
        let scoutPicks: ScoutPick[] = [];
        let layout: DiscoverLayout | undefined;
        await postAgentStream(
          discoverScoutBody({ prior: history, text, portfolioContext, tier }),
          (event) => {
            handleAgentEvent(event, convId, { convId, retry });
            if (event.type === "scout_complete" || event.type === "deep_shortlist") {
              scoutPicks = event.picks;
              query = event.query;
              layout = event.layout;
            }
            if (event.type === "discover_clarify") clarify = { question: event.question, chips: event.chips };
            if (event.type === "final_response") framing = applyFinalResponse(framing, event);
          },
          ctrl
        );
        if (!live()) return;

        if (clarify) {
          const c = clarify as { question: string; chips: string[] };
          await pushDiscover({ kind: "final", report: framing || c.question }, convId, { followups: c.chips });
          return;
        }
        picks = scoutPicks;
        if (!picks.length) {
          if (framing) await pushDiscover({ kind: "final", report: framing }, convId);
          return;
        }
        await pushDiscover({ kind: "shortlist", tier, query, framing, picks, layout }, convId, { scoutPicks: picks, tier });

        if (tier === "quick") return;
      }

      // Phase 2 — deterministic crew waves (deep only).
      const waves = planWaves(picks);
      const totalWaves = waves.length;
      const startWave = seed?.startWave ?? 0;
      for (const waveReq of waves.slice(startWave)) {
        s().setDiscoverProgress(convId, { current: waveReq.waveIndex + 1, total: totalWaves });
        s().clearStreamingContent(convId);
        let waveEvidence: WaveEvidence | null = null;
        await postAgentStream(
          { wave: waveReq },
          (event) => {
            handleAgentEvent(event, convId, { convId, retry });
            if (event.type === "wave_result") waveEvidence = event.wave;
          },
          ctrl,
          240_000
        );
        if (!live()) return;
        if (waveEvidence) {
          const we = waveEvidence as WaveEvidence;
          evidence = mergeWaveEvidence(evidence, we);
          await pushDiscover({ kind: "wave", wave: we, totalWaves }, convId);
        }
      }
      s().setDiscoverProgress(convId, null);

      // Phase 3 — single synthesis pass.
      s().clearStreamingContent(convId);
      s().setCeoThinking(convId, "Ranking the shortlist on the crew's evidence…");
      let report = "";
      await postAgentStream(
        { wave: { synthesize: true, query, picks, evidence } },
        (event) => {
          handleAgentEvent(event, convId, { convId, retry });
          if (event.type === "final_response") report = applyFinalResponse(report, event);
        },
        ctrl
      );
      if (report && live()) await pushDiscover({ kind: "final", report }, convId);
    } finally {
      if (runs.isCurrent(convId, ctrl)) s().setDiscoverProgress(convId, null);
      endRun(convId, ctrl);
    }
  }

  function handleAgentEvent(
    event: AgentEvent,
    convId: string,
    owner?: { convId: string; retry: () => void }
  ) {
    const st = s();
    switch (event.type) {
      case "crew_plan": {
        // The deterministic plan (W2-2): who is on the job and how long it should
        // take, announced before any agent runs so the panel opens with a real ETA.
        st.setCrewProgress(convId, {
          agents: event.agents,
          etaSeconds: event.etaSeconds,
          deep: !!event.deep,
          startedAt: Date.now(),
          status: {},
          ms: {},
          budgetRemainingSeconds: null,
        });
        break;
      }
      case "agent_progress": {
        st.patchCrewProgress(convId, { agent: event.agent, status: event.status, ms: event.ms });
        // An agent the run never got to is marked skipped rather than left on
        // "queued", which reads as a hang.
        if (event.status === "skipped") st.updateAgentStep(convId, event.agent, { status: "skipped" });
        break;
      }
      case "budget_warning":
        st.patchCrewProgress(convId, { budgetRemainingSeconds: event.remainingSeconds });
        st.setCeoThinking(convId, "Time budget reached — writing the report from what finished…");
        break;
      case "crew_planned": {
        // Pre-size the panel: show every planned agent as queued before any runs.
        // Preserve already-known statuses if this fires after some agents started.
        const existing = new Map(st.slice(convId).agentSteps.map((x) => [x.agent, x]));
        st.setAgentSteps(
          convId,
          event.agents.map((agent) => existing.get(agent) ?? { agent, status: "pending" as const })
        );
        break;
      }
      case "agent_start": {
        // Flip the queued slot to running in place (crew_planned set the order).
        const steps = st.slice(convId).agentSteps;
        if (steps.some((x) => x.agent === event.agent)) {
          st.updateAgentStep(convId, event.agent, { status: "running", models: event.models });
        } else {
          st.setAgentSteps(convId, [...steps, { agent: event.agent, status: "running", models: event.models }]);
        }
        break;
      }
      case "agent_complete":
        st.updateAgentStep(convId, event.agent, { status: "complete", result: event.result, models: event.models });
        break;
      case "agent_error":
        st.updateAgentStep(convId, event.agent, { status: "error", error: event.error });
        break;
      case "ceo_thinking":
        st.setCeoThinking(convId, event.content);
        break;
      case "ceo_compiling":
        st.setCeoThinking(convId, "Compiling all reports…");
        break;
      case "final_response":
        if (event.replace) st.clearStreamingContent(convId);
        st.appendStreamChunk(convId, event.content);
        break;
      case "skeptic_start": {
        st.setAgentSteps(convId, [
          ...st.slice(convId).agentSteps.filter((x) => x.agent !== "skeptic_review"),
          { agent: "skeptic_review", status: "running" },
        ]);
        break;
      }
      case "skeptic_complete":
        st.updateAgentStep(convId, "skeptic_review", { status: "complete", result: event.critique });
        if (event.critique) st.setPendingCritique(convId, event.critique);
        break;
      case "followups":
        st.setPendingFollowups(convId, event.questions);
        break;
      case "deep_shortlist":
        st.setCeoThinking(convId, "Shortlist ready — running the analyst crew…");
        break;
      case "wave_start":
        st.setCeoThinking(convId, `Analyzing ${event.tickers.join(", ")} (wave ${event.waveIndex + 1} of ${event.totalWaves})…`);
        break;
      case "error":
        console.error("[agent error event]", event.message);
        st.appendStreamChunk(convId, `\n\n**Error:** ${event.message}`);
        if (owner) {
          notifyChatError(owner.convId, event.message || "Something went wrong while analyzing. Please retry.", owner.retry);
        }
        break;
    }
  }

  // "Run full analysis" — the explicit crew request behind a fast answer (W2-3
  // renders the button and calls this through the send queue). It re-asks the
  // question the fast answer was about, with the conversation's page context, so
  // the sized crew works on the same ticker.
  async function runFullAnalysis(convId: string, text: string, pageContext?: PageContext | null) {
    if (s().slice(convId).isStreaming) return;
    const prior = s().messagesOf(convId);
    const question =
      text.trim() || [...prior].reverse().find((m) => m.role === "user")?.content.trim() || "";
    if (!question) return; // nothing to analyze — don't start an empty crew run
    s().setStreaming(convId, true);
    s().clearStreamingContent(convId);
    const ctrl = runs.start(convId);
    try {
      const { holdings, cashBalance, quoteMap } = ctxRef.current;
      const portfolioContext = buildPortfolioContext(holdings, cashBalance, quoteMap);
      const pc = pageContext ?? s().pageContextByConv[convId] ?? null;
      await runAgentMode(question, portfolioContext, convId, "agent", false, prior, undefined, pc);
    } catch (err) {
      if (runs.wasStopped(ctrl)) return;
      console.error("[full analysis] error:", err);
      endRun(convId, ctrl);
      notifyChatError(convId, "Couldn't run the full analysis. Please retry.", () => {
        void runFullAnalysis(convId, text, pageContext);
      });
    }
  }

  // "Go deeper" — escalate a quick result to the full deep funnel on the same query.
  async function deepen(convId: string, query: string) {
    if (s().slice(convId).isStreaming) return;
    s().setStreaming(convId, true);
    s().clearStreamingContent(convId);
    const ctrl = runs.start(convId);
    try {
      const { holdings, cashBalance, quoteMap } = ctxRef.current;
      const portfolioContext = buildPortfolioContext(holdings, cashBalance, quoteMap);
      await runDiscoverMode(query, portfolioContext, convId, "deep", undefined, s().messagesOf(convId));
    } catch (err) {
      if (runs.wasStopped(ctrl)) return;
      console.error("[discover deeper] error:", err);
      endRun(convId, ctrl);
      notifyChatError(convId, "Couldn't run the deeper discovery. Please retry.", () => { void deepen(convId, query); });
    }
  }

  // Auto mode — the unified router. Classify the message
  // (fast/discover/clarify/full_analysis), optionally ask ONE clarifying
  // question first, then delegate to the matching handler exactly as the manual
  // modes do. Any router failure falls back to the fast lane so Auto never
  // dead-ends — and never silently spends four minutes on the crew.
  async function runAuto(
    text: string,
    portfolioContext: string,
    convId: string,
    prior: ChatMessage[],
    templateId?: string,
    pageContext?: PageContext | null
  ) {
    const ctrl = runs.get(convId);
    const retry = () => { void runAuto(text, portfolioContext, convId, prior, templateId, pageContext); };
    try {
      // Clarify continuation: if we asked a question last turn, this message is
      // the answer — fold it into the original prompt and don't clarify again.
      const pending = pendingClarify.get(convId);
      let combined = text;
      let allowClarify = true;
      if (pending) {
        combined = `${pending.originalPrompt}\n\n[User clarification]: ${text}`;
        allowClarify = false;
        pendingClarify.delete(convId);
      }

      s().setCeoThinking(convId, "Working out the best way to answer…");

      let intent: Intent = "fast";
      let clarifyQuestion = "";
      let clarifyChips: string[] = [];
      try {
        const res = await authFetch("/api/classify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(classifyBody({ prior, userPrompt: combined, portfolioContext, pageContext, allowClarify })),
          signal: ctrl?.signal,
        });
        if (await handleUsageLimit(res)) return;
        if (res.ok) {
          const data = await res.json();
          if (INTENTS.includes(data?.intent)) intent = data.intent as Intent;
          if (intent === "clarify" && data?.clarifyQuestion && Array.isArray(data?.clarifyChips)) {
            clarifyQuestion = String(data.clarifyQuestion);
            clarifyChips = data.clarifyChips.map(String).filter(Boolean).slice(0, 4);
          }
          // A clarify with nothing to ask is not a clarify — answer instead.
          if (intent === "clarify" && (!clarifyQuestion || !clarifyChips.length)) intent = "fast";
          // The server already suppresses a second clarify, but the client knows
          // for certain whether it just asked one.
          if (intent === "clarify" && !allowClarify) intent = "fast";
        }
      } catch { /* fall through to the fast lane */ }

      // Stopped while routing: don't start a lane.
      if (!runs.isCurrent(convId, ctrl)) return;

      // Clarify: post the question as a plain assistant message with tappable
      // chips (reuses the followup-chip UI) and stop. The reply re-enters here
      // and hits the pending branch above.
      if (intent === "clarify") {
        pendingClarify.set(convId, { originalPrompt: text });
        s().setCeoThinking(convId, "");
        endRun(convId, ctrl);
        await commitMessage(convId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: clarifyQuestion,
          mode: "fast",
          createdAt: new Date().toISOString(),
          followups: clarifyChips,
        });
        return;
      }

      s().setCeoThinking(convId, "");
      if (intent === "discover") {
        await runDiscoverMode(combined, portfolioContext, convId, "quick", undefined, prior);
      } else if (intent === "full_analysis") {
        // The crew, only because the user asked for it. W2-2 replaces this call
        // with its sized-crew entry point (same signature).
        await runAgentMode(combined, portfolioContext, convId, "agent", false, prior, templateId, pageContext);
      } else {
        await runSimpleChat(combined, portfolioContext, convId, "fast", prior, templateId, pageContext);
      }
    } catch (err) {
      if (runs.wasStopped(ctrl)) return;
      console.error("[auto] error:", err);
      notifyChatError(convId, "Couldn't process your message. Please retry.", retry);
    } finally {
      endRun(convId, ctrl);
    }
  }

  // ── Send queue processing ───────────────────────────────────────────────────

  async function processSend(req: SendRequest) {
    if (req.kind === "deepen") {
      await deepen(req.convId!, req.text);
      return;
    }
    if (req.kind === "full_analysis") {
      await runFullAnalysis(req.convId!, req.text, req.pageContext);
      return;
    }

    const { text, mode, context, templateId } = req;
    let convId = req.convId;
    const isNew = !convId;
    // History BEFORE the new user message is added (for context building).
    const prior = s().messagesOf(convId);

    // Resolve the page context for this turn: the snapshot captured at send time
    // (user was on the page), else the one this conversation already remembers
    // (a follow-up typed on /chat after navigating away). Either way it's threaded
    // into the model payload AND persisted so the NEXT follow-up keeps it too.
    const pageContext = req.pageContext ?? (convId ? s().pageContextByConv[convId] ?? null : null);

    let ctrl: AbortController | undefined;
    try {
      // New chat: render everything optimistically (id, sidebar row, streaming
      // state) before any network call, then persist in the background.
      if (!convId) {
        convId = crypto.randomUUID();
        s().setConversationId(convId); // view the new chat
        insertOptimisticConversation(convId, context, text, mode);
      }
      if (pageContext) s().setPageContextForConv(convId, pageContext);
      ctrl = runs.start(convId);
      laneMode.set(convId, mode === "auto" ? "fast" : mode);

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        mode,
        createdAt: new Date().toISOString(),
        context,
      };
      s().addMessage(convId, userMsg);
      s().setStreaming(convId, true);
      s().clearStreamingContent(convId);

      // Persist the parent doc before any message write, but after the UI is live.
      // Store the page context on it too, so follow-ups keep the ticker+data even
      // after a reload rehydrates the conversation from scratch.
      if (isNew) await createConversation(convId, context, pageContext);

      const { holdings, cashBalance, quoteMap } = ctxRef.current;
      const portfolioContext = buildPortfolioContext(holdings, cashBalance, quoteMap);

      persistMessage(convId, userMsg).catch((e) => console.warn("[send] saveMessage failed:", e));

      if (!runs.isCurrent(convId, ctrl)) return; // stopped before the lane started

      // Every lane gets the same transcript (see buildHistory).
      if (mode === "auto") {
        await runAuto(text, portfolioContext, convId, prior, templateId, pageContext);
      } else if (mode === "simple") {
        await runSimpleChat(text, portfolioContext, convId, mode, prior, templateId, pageContext);
      } else if (mode === "discover") {
        await runDiscoverMode(text, portfolioContext, convId, "quick", undefined, prior);
      } else if (mode === "deep_research") {
        await runAgentMode(text, portfolioContext, convId, mode, true, prior, templateId, pageContext);
      } else {
        await runAgentMode(text, portfolioContext, convId, mode, false, prior, templateId, pageContext);
      }
    } catch (err) {
      if (runs.wasStopped(ctrl)) return;
      console.error("[send] top-level error:", err);
      const failedId = convId;
      if (failedId) endRun(failedId, ctrl);
      notifyChatError(failedId, "Couldn't send your message. Check your connection and retry.", () =>
        s().enqueueSend({ convId: failedId, text, mode, context, pageContext, kind: "send" })
      );
    }
  }

  // Drain the send queue — each request runs concurrently (not awaited).
  useEffect(() => {
    if (!sendQueue.length) return;
    let req: SendRequest | undefined;
    while ((req = useChatStore.getState().dequeueSend())) {
      void processSend(req);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendQueue]);

  // Consume a pendingMessage (set by composers / quick-action buttons).
  // A send that carries a page context (composed from /research, /portfolio,
  // /watchlist, /stock — contextFromPath only returns non-null there) always
  // starts a NEW conversation tagged with that page, so it can't hijack or
  // interrupt the chat you happened to be viewing. A send with no context (a
  // follow-up typed on /chat) continues the viewed conversation.
  useEffect(() => {
    if (!pendingMessage) return;
    const { conversationId, mode, pendingContext, pendingPageContext, activeTemplate } = useChatStore.getState();
    useChatStore.getState().setPendingMessage("");
    useChatStore.getState().enqueueSend({
      convId: pendingContext ? null : conversationId,
      text: pendingMessage,
      mode,
      context: pendingContext,
      pageContext: pendingPageContext,
      kind: "send",
      templateId: activeTemplate?.id,
    });
    if (pendingContext) useChatStore.getState().setPendingContext(null);
    if (pendingPageContext) useChatStore.getState().setPendingPageContext(null);
    if (activeTemplate) useChatStore.getState().setActiveTemplate(null);
  }, [pendingMessage]);

  // ── Resume an interrupted deep discovery run (viewed conversation) ───────────
  const conversationId = useChatStore((s2) => s2.conversationId);
  const viewedMessages = useChatStore((s2) => (s2.conversationId ? s2.messagesByConv[s2.conversationId] : undefined));
  const viewedStreaming = useChatStore((s2) => (s2.conversationId ? s2.streamsByConv[s2.conversationId]?.isStreaming : false));
  const resumedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (viewedStreaming || !conversationId) return;
    const messages = viewedMessages ?? [];
    const discoverMsgs = messages.filter((m) => m.mode === "discover");
    if (!discoverMsgs.length) return;

    const lastMsg = discoverMsgs[discoverMsgs.length - 1];
    // A run the user stopped is finished, not interrupted.
    if (lastMsg.stopped) return;
    const last = lastMsg.attachment;
    if (!last) return;
    if (last.kind === "final") return;
    if (last.kind === "shortlist" && last.tier === "quick") return;

    let shortlistIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const c = messages[i].mode === "discover" ? messages[i].attachment : undefined;
      if (c?.kind === "shortlist" && c.tier === "deep") { shortlistIdx = i; break; }
    }
    if (shortlistIdx < 0) return;

    const shortlist = messages[shortlistIdx].attachment;
    if (shortlist?.kind !== "shortlist" || !shortlist.picks.length) return;
    const { picks, query } = shortlist;

    const doneWaveEvidence: WaveEvidence[] = [];
    let doneWaves = 0;
    for (let i = shortlistIdx + 1; i < messages.length; i++) {
      const c = messages[i].mode === "discover" ? messages[i].attachment : undefined;
      if (c?.kind === "wave") {
        doneWaveEvidence.push(c.wave);
        doneWaves = Math.max(doneWaves, c.wave.waveIndex + 1);
      }
    }
    const evidence = mergeWaves(doneWaveEvidence);

    const key = `${conversationId}:${messages[shortlistIdx].id}:${doneWaves}`;
    if (resumedRef.current.has(key)) return;
    resumedRef.current.add(key);

    const resumeConvId = conversationId;
    const resumeSeed = { picks, query, evidence, startWave: doneWaves };
    const runResume = async () => {
      s().setStreaming(resumeConvId, true);
      const ctrl = runs.start(resumeConvId);
      try {
        await runDiscoverMode(query, "", resumeConvId, "deep", resumeSeed);
      } catch (e) {
        if (runs.wasStopped(ctrl)) return;
        console.error("[discover resume] error:", e);
        endRun(resumeConvId, ctrl);
        notifyChatError(resumeConvId, "Couldn't resume your discovery run. Please retry.", () => { void runResume(); });
      }
    };
    void runResume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewedMessages, conversationId, viewedStreaming]);

  return null;
}
