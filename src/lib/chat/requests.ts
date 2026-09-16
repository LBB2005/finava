import type { AgentEvent, ChatMessage } from "@/types/chat";
import type { PageContext } from "@/lib/pageContext";
import { buildHistory, type HistoryTurn } from "./history";
import { collectAgentStream, collectChatStream } from "./stream";

/** `fetch`-shaped. ChatEngine passes authFetch; tests pass a fake. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Classify only needs a short tail to resolve "that" / "it". */
const CLASSIFY_TURNS = 6;

function withoutTrailingUser(turns: HistoryTurn[]): HistoryTurn[] {
  const out = [...turns];
  while (out.at(-1)?.role === "user") out.pop();
  return out;
}

export function simpleChatBody(a: {
  prior: ChatMessage[];
  text: string;
  portfolioContext: string;
  templateId?: string;
  pageContext?: PageContext | null;
  /** Lets the fast lane reuse this conversation's last fetch for a reformat. */
  conversationId?: string;
}) {
  const next: ChatMessage = { id: "next", role: "user", content: a.text, mode: "fast", createdAt: "" };
  return {
    messages: buildHistory([...a.prior, next]),
    portfolioContext: a.portfolioContext,
    templateId: a.templateId,
    pageContext: a.pageContext ?? undefined,
    conversationId: a.conversationId,
  };
}

export function agentBody(a: {
  prior: ChatMessage[];
  text: string;
  portfolioContext: string;
  deepResearch: boolean;
  holdings: { ticker: string; shares: number }[];
  templateId?: string;
  pageContext?: PageContext | null;
}) {
  return {
    userPrompt: a.text,
    portfolioContext: a.portfolioContext,
    deepResearch: a.deepResearch,
    // The server appends userPrompt as the next user turn.
    conversationHistory: withoutTrailingUser(buildHistory(a.prior)),
    holdings: a.holdings,
    templateId: a.templateId,
    pageContext: a.pageContext ?? undefined,
  };
}

export function discoverScoutBody(a: {
  prior: ChatMessage[];
  text: string;
  portfolioContext: string;
  tier: "quick" | "deep";
}) {
  return {
    discover: true,
    tier: a.tier,
    userPrompt: a.text,
    portfolioContext: a.portfolioContext,
    conversationHistory: withoutTrailingUser(buildHistory(a.prior)),
  };
}

export function classifyBody(a: {
  prior: ChatMessage[];
  userPrompt: string;
  portfolioContext: string;
  pageContext?: PageContext | null;
  /** False on the turn right after a clarifying question, so we never ask twice. */
  allowClarify?: boolean;
}) {
  return {
    userPrompt: a.userPrompt,
    history: buildHistory(a.prior).slice(-CLASSIFY_TURNS),
    portfolioContext: a.portfolioContext,
    pageContext: a.pageContext ?? undefined,
    allowClarify: a.allowClarify,
  };
}

interface StreamOpts {
  signal?: AbortSignal;
  /** Inspect the response first; return true to stop (e.g. a usage-cap 429 was handled). */
  onResponse?: (res: Response) => Promise<boolean>;
}

async function post(fetcher: Fetcher, url: string, body: object, opts: StreamOpts): Promise<Response | null> {
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (opts.onResponse && (await opts.onResponse(res))) return null;
  if (!res.ok || !res.body) throw new Error(`${url} stream failed (${res.status})`);
  return res;
}

/** POST /api/chat and read the answer. Resolves null if `onResponse` stopped it. */
export async function streamSimple(
  fetcher: Fetcher,
  body: ReturnType<typeof simpleChatBody>,
  opts: StreamOpts & { onText: (t: string) => void; onFollowups: (q: string[]) => void }
): Promise<string | null> {
  const res = await post(fetcher, "/api/chat", body, opts);
  return res ? collectChatStream(res.body!, opts) : null;
}

/** POST /api/agent and read the full report. Resolves null if `onResponse` stopped it. */
export async function streamAgent(
  fetcher: Fetcher,
  body: object,
  opts: StreamOpts & { onEvent: (e: AgentEvent) => void }
): Promise<string | null> {
  const res = await post(fetcher, "/api/agent", body, opts);
  return res ? collectAgentStream(res.body!, opts.onEvent) : null;
}
