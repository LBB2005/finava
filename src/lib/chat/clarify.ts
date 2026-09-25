import type { ChatMessage, ChatMode } from "@/types/chat";

/**
 * Clarifying questions — asked in a panel docked at the composer, not as a chat
 * bubble. The router (Auto) and the Discover scout both raise them.
 *
 * The question set rides on an assistant message (`clarify`) and the answer on
 * the user message that follows it (`clarifyReply`). Both persist, so whether a
 * question is still open is read off the transcript: it survives a reload and
 * each conversation keeps its own.
 */

export interface ClarifyOption {
  label: string;
  description?: string;
}

export interface ClarifyQuestion {
  /** 1–2 words, shown on the tab and in the receipt ("Horizon"). */
  header: string;
  question: string;
  options: ClarifyOption[];
}

export interface ClarifyAnswer {
  header: string;
  question: string;
  answer: string;
}

export interface ClarifyReply {
  answers: ClarifyAnswer[];
  /** The user pressed Skip: answer anyway and say what was assumed. */
  skipped: boolean;
}

export const MAX_CLARIFY_QUESTIONS = 3;
export const MAX_CLARIFY_OPTIONS = 4;
const MIN_CLARIFY_OPTIONS = 2;
const MAX_HEADER = 16;
const MAX_QUESTION = 200;
const MAX_LABEL = 60;
const MAX_DESCRIPTION = 120;
/** The panel always offers its own free-text row, so the model's is dropped. */
const OTHER_RE = /^other\b/i;

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max).trim() : "";

function cleanOption(raw: unknown): ClarifyOption | null {
  const src = typeof raw === "string" ? { label: raw } : (raw as Record<string, unknown> | null);
  if (!src || typeof src !== "object") return null;
  const label = str(src.label, MAX_LABEL);
  if (!label || OTHER_RE.test(label)) return null;
  const description = str(src.description, MAX_DESCRIPTION);
  return description ? { label, description } : { label };
}

function cleanQuestion(raw: unknown, index: number): ClarifyQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const question = str(src.question, MAX_QUESTION);
  if (!question || !Array.isArray(src.options)) return null;

  const seen = new Set<string>();
  const options: ClarifyOption[] = [];
  for (const o of src.options) {
    const opt = cleanOption(o);
    if (!opt || seen.has(opt.label.toLowerCase())) continue;
    seen.add(opt.label.toLowerCase());
    options.push(opt);
    if (options.length === MAX_CLARIFY_OPTIONS) break;
  }
  if (options.length < MIN_CLARIFY_OPTIONS) return null;

  const header = str(src.header, MAX_HEADER) || `Question ${index + 1}`;
  return { header, question, options };
}

/**
 * Sanitise a question set from the router model or from storage. Returns null
 * when nothing askable is left, so the caller answers instead of asking.
 *
 * Accepts the array itself, a `{ clarify: [...] }` wrapper, or the legacy
 * single-question `{ clarifyQuestion, clarifyChips }` shape.
 */
export function cleanClarify(raw: unknown): ClarifyQuestion[] | null {
  let list: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.clarify)) list = o.clarify;
    else if (typeof o.clarifyQuestion === "string" && Array.isArray(o.clarifyChips)) {
      list = [{ header: "Focus", question: o.clarifyQuestion, options: o.clarifyChips }];
    }
  }
  if (!Array.isArray(list)) return null;

  const out: ClarifyQuestion[] = [];
  for (const q of list) {
    const clean = cleanQuestion(q, out.length);
    if (clean) out.push(clean);
    if (out.length === MAX_CLARIFY_QUESTIONS) break;
  }
  return out.length ? out : null;
}

/** Sanitise a stored reply. Returns undefined when it isn't one. */
export function cleanClarifyReply(raw: unknown): ClarifyReply | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  if (!Array.isArray(src.answers)) return undefined;
  const answers: ClarifyAnswer[] = [];
  for (const a of src.answers.slice(0, MAX_CLARIFY_QUESTIONS)) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const answer = str(o.answer, 500);
    if (!answer) continue;
    answers.push({ header: str(o.header, MAX_HEADER), question: str(o.question, MAX_QUESTION), answer });
  }
  return { answers, skipped: src.skipped === true };
}

export interface PendingClarify {
  /** The assistant message that asked. */
  messageId: string;
  questions: ClarifyQuestion[];
  /** The user message the questions are about. */
  originalPrompt: string;
  /** Its mode, so the answer runs through the same lane. */
  mode: ChatMode;
}

/** The open question set, if the conversation ends on one. */
export function pendingClarifyOf(messages: readonly ChatMessage[]): PendingClarify | null {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || !last.clarify?.length) return null;
  let original: ChatMessage | undefined;
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === "user") { original = messages[i]; break; }
  }
  return {
    messageId: last.id,
    questions: last.clarify,
    originalPrompt: original?.content ?? "",
    mode: original?.mode ?? "auto",
  };
}

const isSkip = (r: ClarifyReply) => r.skipped || r.answers.length === 0;

/** The lane prompt: the original ask plus what the user chose. */
export function foldClarification(originalPrompt: string, reply: ClarifyReply): string {
  if (isSkip(reply)) {
    return `${originalPrompt}\n\n[The user skipped the clarifying questions. Answer anyway using sensible defaults, and say in one short line what you assumed.]`;
  }
  const lines = reply.answers.map((a) => `- ${[a.question, a.answer].filter(Boolean).join(" ")}`).join("\n");
  return `${originalPrompt}\n\n[User clarification]:\n${lines}`;
}

/** The user message's text, as history and the sidebar read it. */
export function replyContent(reply: ClarifyReply): string {
  if (isSkip(reply)) return "Skipped the questions.";
  return reply.answers.map((a) => `${a.header}: ${a.answer}`).join("\n");
}

/** The one-line receipt under the prompt. */
export function receiptText(reply: ClarifyReply): string {
  if (isSkip(reply)) return "Skipped — answered with assumptions";
  return reply.answers.map((a) => `${a.header}: ${a.answer}`).join(" · ");
}

/** The asking message's text, as history reads it. */
export function questionsText(questions: readonly ClarifyQuestion[]): string {
  return questions.map((q) => q.question).join("\n");
}
