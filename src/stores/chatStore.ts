"use client";
import { create } from "zustand";
import type { ChatMessage, ChatMode, AgentStep } from "@/types/chat";
import type { ChatContext } from "@/lib/chatContext";
import type { PageContext } from "@/lib/pageContext";

// ── Per-conversation streaming state ────────────────────────────────────────
// Each conversation owns its own live slice so multiple chats can stream at the
// same time. The VIEWED conversation is `conversationId`; the headless ChatEngine
// writes to whichever slice its stream owns, regardless of what's on screen.
export interface StreamSlice {
  isStreaming: boolean;
  /** Epoch ms when this stream started; drives the live "Analyzing · Ns" timer
   *  and is read at completion to stamp the message's duration. */
  streamStartedAt: number | null;
  streamingContent: string;
  agentSteps: AgentStep[];
  ceoThinking: string;
  pendingCritique: string;
  pendingFollowups: string[];
  discoverProgress: { current: number; total: number } | null;
  /** The planned crew for this run, its ETA, and how far through it is (W2-2).
   *  Null outside a crew run. W2-3's CrewProgress row renders it. */
  crewProgress: CrewProgress | null;
}

/** What the crew said it would do, and how it is tracking against that. */
export interface CrewProgress {
  /** Agent tool names, in the order the planner chose them. */
  agents: string[];
  /** Quoted wall-clock for the whole run, from `crew_plan`. */
  etaSeconds: number;
  /** Deep Research — a deliberately wider crew on a longer budget. */
  deep: boolean;
  /** Epoch ms the plan was announced, so the UI can count down from the ETA. */
  startedAt: number;
  /** Per-agent state. Absent = not started yet. */
  status: Record<string, "running" | "done" | "failed" | "skipped">;
  /** Observed wall-clock per finished agent, for re-basing the countdown. */
  ms: Record<string, number>;
  /** Set once the run is against its budget and will synthesize with what it has. */
  budgetRemainingSeconds: number | null;
}

export const emptySlice = (): StreamSlice => ({
  isStreaming: false,
  streamStartedAt: null,
  streamingContent: "",
  agentSteps: [],
  ceoThinking: "",
  pendingCritique: "",
  pendingFollowups: [],
  discoverProgress: null,
  crewProgress: null,
});

/** A queued send the ChatEngine will pick up and run. */
export interface SendRequest {
  id: string;
  /** Target conversation. null → create a new one at send time. */
  convId: string | null;
  text: string;
  mode: ChatMode;
  /** Context to stamp on a newly-created conversation. */
  context: ChatContext;
  /** Rich snapshot of the page this send was composed on (ticker + data), so the
   *  model can scope its answer. Captured at enqueue time — before the composing
   *  page can unmount — then remembered per-conversation for follow-up turns. */
  pageContext?: PageContext | null;
  /** "send" routes by mode; "deepen" escalates a quick discover to a deep run;
   *  "full_analysis" is the explicit "Run full analysis" request behind a fast
   *  answer — it runs the sized crew on `text` regardless of `mode`. */
  kind: "send" | "deepen" | "full_analysis";
  /** Optional response-template id whose instructions/format shape this answer. */
  templateId?: string;
}

interface ChatState {
  /** The conversation currently shown on screen. */
  conversationId: string | null;
  /** Messages per conversation (the viewed list is messagesByConv[conversationId]). */
  messagesByConv: Record<string, ChatMessage[]>;
  /** Live streaming slice per conversation. */
  streamsByConv: Record<string, StreamSlice>;
  mode: ChatMode;

  /** Engine work queue. */
  sendQueue: SendRequest[];

  pendingMessage: string;
  /** Context to stamp on the NEXT conversation created. Consumed at create time. */
  pendingContext: ChatContext;
  /** The page context the currently-viewed page publishes (e.g. the stock page
   *  writes its loaded bundle snapshot here). Read at send time; null off-page. */
  activePageContext: PageContext | null;
  /** Rich page context riding on the next send. Captured synchronously from
   *  activePageContext by the composer/launcher before navigation unmounts the
   *  page, then consumed by the engine's pendingMessage effect. */
  pendingPageContext: PageContext | null;
  /** Page context remembered per conversation, so a follow-up typed on /chat
   *  (after navigating away from the stock page) still carries the ticker+data. */
  pageContextByConv: Record<string, PageContext>;
  /** Response template riding on the next send (shown as a composer chip).
   *  Shared between the composer and the empty-state picker; cleared on send. */
  activeTemplate: { id: string; title: string } | null;

  // ── selectors (call via useChatStore.getState() in non-React code) ──
  slice: (convId: string | null) => StreamSlice;
  messagesOf: (convId: string | null) => ChatMessage[];

  // ── viewed-conversation helpers ──
  setConversationId: (id: string | null) => void;
  setMode: (mode: ChatMode) => void;
  setPendingMessage: (msg: string) => void;
  setPendingContext: (ctx: ChatContext) => void;
  setActivePageContext: (pc: PageContext | null) => void;
  setPendingPageContext: (pc: PageContext | null) => void;
  setPageContextForConv: (convId: string, pc: PageContext) => void;
  setActiveTemplate: (t: { id: string; title: string } | null) => void;

  // ── send queue ──
  enqueueSend: (req: Omit<SendRequest, "id">) => void;
  dequeueSend: () => SendRequest | undefined;

  // ── per-conversation message + stream mutations (all keyed by convId) ──
  setMessages: (convId: string, msgs: ChatMessage[]) => void;
  addMessage: (convId: string, msg: ChatMessage) => void;
  setStreaming: (convId: string, v: boolean) => void;
  appendStreamChunk: (convId: string, chunk: string) => void;
  clearStreamingContent: (convId: string) => void;
  setAgentSteps: (convId: string, steps: AgentStep[]) => void;
  updateAgentStep: (convId: string, agent: string, update: Partial<AgentStep>) => void;
  clearAgentSteps: (convId: string) => void;
  setCeoThinking: (convId: string, text: string) => void;
  setPendingCritique: (convId: string, c: string) => void;
  setPendingFollowups: (convId: string, q: string[]) => void;
  setDiscoverProgress: (convId: string, p: { current: number; total: number } | null) => void;
  /** Start (or clear) a crew run's progress. Called on `crew_plan`. */
  setCrewProgress: (convId: string, p: CrewProgress | null) => void;
  /** Fold one `agent_progress` / `budget_warning` update into the run. */
  patchCrewProgress: (
    convId: string,
    update: { agent?: string; status?: "running" | "done" | "failed" | "skipped"; ms?: number; budgetRemainingSeconds?: number }
  ) => void;
  /** Tear down a conversation's state entirely (e.g. on delete). */
  dropConversation: (convId: string) => void;

  /** Detach the view (start a fresh new chat). Leaves background streams intact. */
  reset: () => void;
}

// Apply a partial update to one conversation's slice, immutably.
function patchSlice(
  streamsByConv: Record<string, StreamSlice>,
  convId: string,
  patch: Partial<StreamSlice>
): Record<string, StreamSlice> {
  const cur = streamsByConv[convId] ?? emptySlice();
  return { ...streamsByConv, [convId]: { ...cur, ...patch } };
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversationId: null,
  messagesByConv: {},
  streamsByConv: {},
  mode: "auto",
  sendQueue: [],
  pendingMessage: "",
  pendingContext: null,
  activePageContext: null,
  pendingPageContext: null,
  pageContextByConv: {},
  activeTemplate: null,

  slice: (convId) => (convId ? get().streamsByConv[convId] ?? emptySlice() : emptySlice()),
  messagesOf: (convId) => (convId ? get().messagesByConv[convId] ?? [] : []),

  setConversationId: (id) => set({ conversationId: id }),
  setMode: (mode) => set({ mode }),
  setPendingMessage: (msg) => set({ pendingMessage: msg }),
  setPendingContext: (ctx) => set({ pendingContext: ctx }),
  setActivePageContext: (pc) => set({ activePageContext: pc }),
  setPendingPageContext: (pc) => set({ pendingPageContext: pc }),
  setPageContextForConv: (convId, pc) =>
    set((s) => ({ pageContextByConv: { ...s.pageContextByConv, [convId]: pc } })),
  setActiveTemplate: (t) => set({ activeTemplate: t }),

  enqueueSend: (req) =>
    set((s) => ({
      sendQueue: [...s.sendQueue, { ...req, id: crypto.randomUUID() }],
    })),
  dequeueSend: () => {
    const [first, ...rest] = get().sendQueue;
    if (!first) return undefined;
    set({ sendQueue: rest });
    return first;
  },

  setMessages: (convId, msgs) =>
    set((s) => ({ messagesByConv: { ...s.messagesByConv, [convId]: msgs } })),
  addMessage: (convId, msg) =>
    set((s) => ({
      messagesByConv: {
        ...s.messagesByConv,
        [convId]: [...(s.messagesByConv[convId] ?? []), msg],
      },
    })),

  setStreaming: (convId, v) =>
    set((s) => ({
      streamsByConv: patchSlice(s.streamsByConv, convId, {
        isStreaming: v,
        // Stamp the start when a stream begins; leave it on completion so the
        // engine can read it to compute the message duration.
        ...(v ? { streamStartedAt: Date.now() } : {}),
      }),
    })),
  appendStreamChunk: (convId, chunk) =>
    set((s) => {
      const cur = s.streamsByConv[convId] ?? emptySlice();
      return {
        streamsByConv: {
          ...s.streamsByConv,
          [convId]: { ...cur, streamingContent: cur.streamingContent + chunk },
        },
      };
    }),
  clearStreamingContent: (convId) =>
    set((s) => ({ streamsByConv: patchSlice(s.streamsByConv, convId, { streamingContent: "" }) })),
  setAgentSteps: (convId, steps) =>
    set((s) => ({ streamsByConv: patchSlice(s.streamsByConv, convId, { agentSteps: steps }) })),
  updateAgentStep: (convId, agent, update) =>
    set((s) => {
      const cur = s.streamsByConv[convId] ?? emptySlice();
      return {
        streamsByConv: {
          ...s.streamsByConv,
          [convId]: {
            ...cur,
            agentSteps: cur.agentSteps.map((step) =>
              step.agent === agent ? { ...step, ...update } : step
            ),
          },
        },
      };
    }),
  clearAgentSteps: (convId) =>
    set((s) => ({ streamsByConv: patchSlice(s.streamsByConv, convId, { agentSteps: [] }) })),
  setCeoThinking: (convId, text) =>
    set((s) => ({ streamsByConv: patchSlice(s.streamsByConv, convId, { ceoThinking: text }) })),
  setPendingCritique: (convId, c) =>
    set((s) => ({ streamsByConv: patchSlice(s.streamsByConv, convId, { pendingCritique: c }) })),
  setPendingFollowups: (convId, q) =>
    set((s) => ({ streamsByConv: patchSlice(s.streamsByConv, convId, { pendingFollowups: q }) })),
  setDiscoverProgress: (convId, p) =>
    set((s) => ({ streamsByConv: patchSlice(s.streamsByConv, convId, { discoverProgress: p }) })),
  setCrewProgress: (convId, p) =>
    set((s) => ({ streamsByConv: patchSlice(s.streamsByConv, convId, { crewProgress: p }) })),
  patchCrewProgress: (convId, update) =>
    set((s) => {
      const cur = s.streamsByConv[convId]?.crewProgress;
      // Progress only exists inside a planned run — an update that arrives after
      // the run is cleared (a stopped chat, a late event) is dropped, not resurrected.
      if (!cur) return {};
      const next: CrewProgress = {
        ...cur,
        status: update.agent && update.status ? { ...cur.status, [update.agent]: update.status } : cur.status,
        ms: update.agent && update.ms != null ? { ...cur.ms, [update.agent]: update.ms } : cur.ms,
        budgetRemainingSeconds:
          update.budgetRemainingSeconds != null ? update.budgetRemainingSeconds : cur.budgetRemainingSeconds,
      };
      return { streamsByConv: patchSlice(s.streamsByConv, convId, { crewProgress: next }) };
    }),

  dropConversation: (convId) =>
    set((s) => {
      const messagesByConv = { ...s.messagesByConv };
      const streamsByConv = { ...s.streamsByConv };
      delete messagesByConv[convId];
      delete streamsByConv[convId];
      return {
        messagesByConv,
        streamsByConv,
        conversationId: s.conversationId === convId ? null : s.conversationId,
      };
    }),

  reset: () => set({ conversationId: null, pendingMessage: "", pendingContext: null, pendingPageContext: null, activeTemplate: null }),
}));
