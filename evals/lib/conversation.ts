/**
 * A headless conversation that sends turns the way ChatEngine does.
 *
 * Request bodies come from `src/lib/chat/requests.ts`, streams are read by
 * `src/lib/chat/stream.ts`, the rendered text lives in the real chat store, and
 * Stop uses the real `RunRegistry` + `stoppedMessage`. The only parts copied from
 * ChatEngine are its control flow: which lane runs, the clarify continuation
 * string, and what gets committed. ChatEngine is a React component and cannot run
 * outside a browser. `stream.smoke.test.ts` checks the copied final_response
 * handling against ChatEngine's source.
 *
 * The same class drives the smoke eval (fixture fetcher), the live eval and the
 * panel (HTTP fetcher), so all three test one code path.
 */
import {
  agentBody,
  classifyBody,
  discoverScoutBody,
  simpleChatBody,
  streamAgent,
  streamSimple,
  type Fetcher,
} from "@/lib/chat/requests";
import { applyFinalResponse, collectAgentStream } from "@/lib/chat/stream";
import { discoverToMarkdown } from "@/lib/chat/discoverText";
import { isFundQuestion } from "@/lib/capabilityCheck";
import { fullAnalysisPrompt } from "@/lib/chat/escalation";
import { INTENTS, type Intent } from "@/lib/chat/intent";
import { RunRegistry, stoppedMessage } from "@/lib/chat/runControl";
import { fromStoredMessage, toStoredMessage, type StoredMessage } from "@/lib/chat/storedMessage";
import { useChatStore } from "@/stores/chatStore";
import type { PageContext } from "@/lib/pageContext";
import type { AgentEvent, ChatMessage, ChatMode } from "@/types/chat";
import type { DiscoverLayout, ScoutPick } from "@/lib/scoutTypes";

/** What the user did: a composer mode, or the "Run full analysis" button. */
export type SendMode = "auto" | "simple" | "agent" | "deep_research" | "discover" | "full_analysis_button";

/** Which lane produced the answer. */
export type Lane = "fast" | "full_analysis" | "deep_research" | "discover" | "clarify";

export interface TurnOptions {
  portfolioContext?: string;
  holdings?: { ticker: string; shares: number }[];
  pageContext?: PageContext | null;
  templateId?: string;
  /** Called with every request the turn makes, before it is sent. */
  onRequest?: (url: string, body: unknown) => void;
  /** Press Stop when this returns true. Checked on every text delta (fast lane) and every event (crew). */
  stopWhen?: (rendered: string) => boolean;
}

export interface Turn {
  mode: SendMode;
  lane: Lane | null;
  text: string;
  /** The committed assistant message, or null when nothing was committed. */
  assistant: ChatMessage | null;
  /** The text the store rendered at the end of the stream (before it is cleared). */
  rendered: string;
  events: AgentEvent[];
  stopped: boolean;
}

let seq = 0;
const nextId = () => `eval-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const store = () => useChatStore.getState();

/** A message as the conversations API stores it: the POST body, with agentTrace stringified by the route. */
export function storedForm(m: ChatMessage): StoredMessage {
  const body = toStoredMessage(m);
  return {
    ...body,
    id: m.id,
    createdAt: m.createdAt,
    agentTrace: body.agentTrace ? JSON.stringify(body.agentTrace) : null,
    context: body.context ?? null,
  };
}

export class Conversation {
  readonly id: string;
  private runs = new RunRegistry();
  private pendingClarify: { originalPrompt: string } | null = null;

  constructor(private fetcher: Fetcher, id = nextId()) {
    this.id = id;
  }

  get messages(): ChatMessage[] {
    return store().messagesOf(this.id);
  }

  /** Simulate a reload: every message goes through the stored form and back. */
  reload(): void {
    const reloaded = this.messages.map((m) => fromStoredMessage(JSON.parse(JSON.stringify(storedForm(m))) as StoredMessage));
    useChatStore.setState((s) => ({ messagesByConv: { ...s.messagesByConv, [this.id]: reloaded } }));
    this.pendingClarify = null; // module state in ChatEngine; a reload loses it too
  }

  /** Put messages straight into the transcript (e.g. a legacy stored conversation). */
  seed(messages: StoredMessage[]): void {
    useChatStore.setState((s) => ({ messagesByConv: { ...s.messagesByConv, [this.id]: messages.map(fromStoredMessage) } }));
  }

  async send(mode: SendMode, text: string, opts: TurnOptions = {}): Promise<Turn> {
    const turn: Turn = { mode, lane: null, text, assistant: null, rendered: "", events: [], stopped: false };
    const fetcher = this.tap(opts);

    if (mode === "full_analysis_button") {
      // ChatEngine.runFullAnalysis: no new user message; re-ask the last question.
      const prior = this.messages;
      const question = text.trim() || [...prior].reverse().find((m) => m.role === "user")?.content.trim() || "";
      if (!question) return turn;
      return this.run(turn, opts, (ctrl) => this.agentLane(turn, fetcher, fullAnalysisPrompt(question), prior, false, ctrl, opts));
    }

    // ChatEngine.processSend: history is taken BEFORE the user message is added.
    const prior = this.messages;
    store().addMessage(this.id, { id: nextId(), role: "user", content: text, mode, createdAt: new Date().toISOString() });

    return this.run(turn, opts, async (ctrl) => {
      if (mode === "auto") return this.auto(turn, fetcher, text, prior, ctrl, opts);
      if (mode === "simple") return this.fastLane(turn, fetcher, text, prior, ctrl, opts, "simple");
      if (mode === "discover") return this.discoverLane(turn, fetcher, text, prior, ctrl, opts);
      return this.agentLane(turn, fetcher, text, prior, mode === "deep_research", ctrl, opts);
    });
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private tap(opts: TurnOptions): Fetcher {
    return (url, init) => {
      opts.onRequest?.(url, init?.body ? JSON.parse(String(init.body)) : undefined);
      return this.fetcher(url, init);
    };
  }

  private async run(turn: Turn, opts: TurnOptions, lane: (ctrl: AbortController) => Promise<void>): Promise<Turn> {
    const ctrl = this.runs.start(this.id);
    store().setStreaming(this.id, true);
    store().clearStreamingContent(this.id);
    try {
      await lane(ctrl);
    } catch (err) {
      if (!this.runs.wasStopped(ctrl)) throw err;
    } finally {
      turn.rendered ||= store().slice(this.id).streamingContent;
      if (this.runs.finish(this.id, ctrl)) {
        store().setStreaming(this.id, false);
        store().clearStreamingContent(this.id);
      }
    }
    return turn;
  }

  /** ChatEngine.stopConversationStream. */
  private stop(turn: Turn, lane: ChatMode) {
    const slice = store().slice(this.id);
    if (!this.runs.stop(this.id)) return;
    const msg = stoppedMessage(slice, lane);
    turn.rendered = slice.streamingContent;
    turn.stopped = true;
    turn.assistant = msg;
    store().addMessage(this.id, msg);
    store().setStreaming(this.id, false);
    store().clearStreamingContent(this.id);
  }

  private commit(turn: Turn, msg: Omit<ChatMessage, "id" | "role" | "createdAt">) {
    const full: ChatMessage = { id: nextId(), role: "assistant", createdAt: new Date().toISOString(), ...msg };
    turn.rendered = store().slice(this.id).streamingContent;
    turn.assistant = full;
    store().addMessage(this.id, full);
  }

  // ── lanes ─────────────────────────────────────────────────────────────────

  /** ChatEngine.runAuto. */
  private async auto(turn: Turn, fetcher: Fetcher, text: string, prior: ChatMessage[], ctrl: AbortController, opts: TurnOptions) {
    let combined = text;
    let allowClarify = true;
    if (this.pendingClarify) {
      combined = `${this.pendingClarify.originalPrompt}\n\n[User clarification]: ${text}`;
      allowClarify = false;
      this.pendingClarify = null;
    }

    let intent: Intent = "fast";
    let question = "";
    let chips: string[] = [];
    try {
      const res = await fetcher("/api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          classifyBody({ prior, userPrompt: combined, portfolioContext: opts.portfolioContext ?? "", pageContext: opts.pageContext, allowClarify })
        ),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const data = await res.json();
        if (INTENTS.includes(data?.intent)) intent = data.intent as Intent;
        if (intent === "clarify" && data?.clarifyQuestion && Array.isArray(data?.clarifyChips)) {
          question = String(data.clarifyQuestion);
          chips = data.clarifyChips.map(String).filter(Boolean).slice(0, 4);
        }
        if (intent === "clarify" && (!question || !chips.length)) intent = "fast";
        if (intent === "clarify" && !allowClarify) intent = "fast";
      }
    } catch (err) {
      if (this.runs.wasStopped(ctrl)) throw err;
      /* router failure: the fast lane, as in ChatEngine */
    }
    if (!this.runs.isCurrent(this.id, ctrl)) return;

    if (intent === "clarify") {
      turn.lane = "clarify";
      this.pendingClarify = { originalPrompt: text };
      this.commit(turn, { content: question, mode: "fast", followups: chips });
      return;
    }
    // ChatEngine: Discover screens individual stocks, so a fund question goes to
    // the fast lane instead of the stock scout (W4-1).
    if (intent === "discover" && isFundQuestion(combined, prior.filter((m) => m.role === "user").map((m) => m.content))) {
      intent = "fast";
    }
    if (intent === "discover") return this.discoverLane(turn, fetcher, combined, prior, ctrl, opts);
    if (intent === "full_analysis") return this.agentLane(turn, fetcher, combined, prior, false, ctrl, opts);
    return this.fastLane(turn, fetcher, combined, prior, ctrl, opts, "fast");
  }

  /** ChatEngine.runSimpleChat. */
  private async fastLane(turn: Turn, fetcher: Fetcher, text: string, prior: ChatMessage[], ctrl: AbortController, opts: TurnOptions, mode: ChatMode) {
    turn.lane = "fast";
    const content = await streamSimple(
      fetcher,
      simpleChatBody({ prior, text, portfolioContext: opts.portfolioContext ?? "", templateId: opts.templateId, pageContext: opts.pageContext, conversationId: this.id }),
      {
        signal: ctrl.signal,
        onText: (t) => {
          store().appendStreamChunk(this.id, t);
          if (opts.stopWhen?.(store().slice(this.id).streamingContent)) this.stop(turn, mode);
        },
        onFollowups: (q) => store().setPendingFollowups(this.id, q),
      }
    );
    if (content == null || !this.runs.isCurrent(this.id, ctrl)) return;
    const followups = store().slice(this.id).pendingFollowups;
    store().setPendingFollowups(this.id, []);
    this.commit(turn, { content, mode, followups: followups.length ? followups : undefined });
  }

  /** ChatEngine.runAgentMode (crew and deep research). */
  private async agentLane(turn: Turn, fetcher: Fetcher, text: string, prior: ChatMessage[], deep: boolean, ctrl: AbortController, opts: TurnOptions) {
    turn.lane = deep ? "deep_research" : "full_analysis";
    const answerMode: ChatMode = deep ? "deep_research" : "agent";
    const finalContent = await streamAgent(
      fetcher,
      {
        ...agentBody({ prior, text, portfolioContext: opts.portfolioContext ?? "", deepResearch: deep, holdings: opts.holdings ?? [], templateId: opts.templateId, pageContext: opts.pageContext }),
        conversationId: this.id,
      },
      {
        signal: ctrl.signal,
        onEvent: (event) => {
          turn.events.push(event);
          this.renderAgentEvent(event);
          if (event.type === "skeptic_complete") store().setPendingCritique(this.id, event.critique ?? "");
          if (event.type === "followups") store().setPendingFollowups(this.id, event.questions);
          // Checked on every event, so a patience limit can fire while the crew is still gathering.
          if (opts.stopWhen?.(store().slice(this.id).streamingContent)) this.stop(turn, answerMode);
        },
      }
    );
    if (finalContent && this.runs.isCurrent(this.id, ctrl)) {
      const sl = store().slice(this.id);
      store().setPendingCritique(this.id, "");
      store().setPendingFollowups(this.id, []);
      this.commit(turn, {
        content: finalContent,
        mode: answerMode,
        critique: sl.pendingCritique || undefined,
        followups: sl.pendingFollowups.length ? sl.pendingFollowups : undefined,
      });
    }
  }

  /** ChatEngine.runDiscoverMode, quick tier (the tier Auto and the composer use). */
  private async discoverLane(turn: Turn, fetcher: Fetcher, text: string, prior: ChatMessage[], ctrl: AbortController, opts: TurnOptions) {
    turn.lane = "discover";
    store().clearStreamingContent(this.id);
    let framing = "";
    let clarify: { question: string; chips: string[] } | null = null;
    let picks: ScoutPick[] = [];
    let query = text;
    let layout: DiscoverLayout | undefined;

    const res = await fetcher("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discoverScoutBody({ prior, text, portfolioContext: opts.portfolioContext ?? "", tier: "quick" })),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error("Discovery stream failed");
    await collectAgentStream(res.body, (event) => {
      turn.events.push(event);
      this.renderAgentEvent(event);
      if (event.type === "scout_complete" || event.type === "deep_shortlist") {
        picks = event.picks;
        query = event.query;
        layout = event.layout;
      }
      if (event.type === "discover_clarify") clarify = { question: event.question, chips: event.chips };
      if (event.type === "final_response") framing = applyFinalResponse(framing, event);
    });
    if (!this.runs.isCurrent(this.id, ctrl)) return;

    const c = clarify as { question: string; chips: string[] } | null;
    if (c) {
      const dc = { kind: "final" as const, report: framing || c.question };
      return this.commit(turn, { content: discoverToMarkdown(dc), attachment: dc, mode: "discover", followups: c.chips });
    }
    if (!picks.length) {
      if (framing) {
        const dc = { kind: "final" as const, report: framing };
        this.commit(turn, { content: discoverToMarkdown(dc), attachment: dc, mode: "discover" });
      }
      return;
    }
    const dc = { kind: "shortlist" as const, tier: "quick" as const, query, framing, picks, layout };
    this.commit(turn, { content: discoverToMarkdown(dc), attachment: dc, mode: "discover", scoutPicks: picks, tier: "quick" });
  }

  /** The final_response case of ChatEngine.handleAgentEvent (checked against its source in the smoke eval). */
  private renderAgentEvent(event: AgentEvent) {
    if (event.type !== "final_response") return;
    if (event.replace) store().clearStreamingContent(this.id);
    store().appendStreamChunk(this.id, event.content);
  }
}
