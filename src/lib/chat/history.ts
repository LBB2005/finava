import type { ChatMessage } from "@/types/chat";
import { discoverToMarkdown, parseDiscoverContent } from "./discoverText";

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Default history budget, in estimated tokens. Roughly two full crew reports. */
export const HISTORY_TOKEN_BUDGET = 16_000;
/** /api/agent caps conversationHistory at 100 entries. */
const MAX_TURNS = 60;

const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/** The text a message contributes to history. Legacy Discover JSON becomes readable text. */
function historyText(m: ChatMessage): string {
  if (m.mode === "discover") {
    const dc = parseDiscoverContent(m.content);
    if (dc) return discoverToMarkdown(dc);
  }
  return m.content;
}

/**
 * One transcript for every lane: user and assistant turns in order, whatever
 * mode produced them. Keeps the newest turns that fit `budget` (estimated
 * tokens). Consecutive same-role turns are merged and the result always starts
 * on a user turn, so it is a valid message list for any provider.
 */
export function buildHistory(messages: ChatMessage[], budget = HISTORY_TOKEN_BUDGET): HistoryTurn[] {
  const merged: HistoryTurn[] = [];
  for (const m of messages) {
    const content = historyText(m).trim();
    if (!content) continue;
    const last = merged.at(-1);
    if (last && last.role === m.role) last.content += `\n\n${content}`;
    else merged.push({ role: m.role, content });
  }

  const kept: HistoryTurn[] = [];
  let used = 0;
  for (let i = merged.length - 1; i >= 0 && kept.length < MAX_TURNS; i--) {
    const turn = merged[i];
    const cost = estimateTokens(turn.content);
    if (used + cost <= budget) {
      kept.unshift(turn);
      used += cost;
      continue;
    }
    if (kept.length === 0) {
      // The newest turn alone is over budget: keep its head (where the answer
      // leads) in half the budget, leaving room for the question before it.
      const chars = Math.floor(budget / 2) * 4;
      kept.unshift({ role: turn.role, content: `${turn.content.slice(0, chars)}\n\n[…truncated]` });
      used += Math.floor(budget / 2);
      continue;
    }
    break;
  }

  while (kept[0]?.role === "assistant") kept.shift();
  return kept;
}
