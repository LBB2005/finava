/**
 * The simulated tester. One Claude call per turn (read what the app showed,
 * react, decide what to do next) and one rating call at the end over the whole
 * transcript. Scores use the Sep-14 keys, so the readout can compare them.
 *
 * These are simulated people. Their scores and quotes are model-written
 * reactions to real app output, and the readout says so.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface Persona {
  id: number;
  name: string;
  age: number;
  job: string;
  ai: string;
  stock: string;
  channel: "api" | "browser";
  mobile: boolean;
  goal: string;
  opening: string;
  voiceSample: string;
}

export interface Levels {
  ai: Record<string, string>;
  stock: Record<string, string>;
}

/** What the tester saw after one message. */
export interface Shown {
  prompt: string;
  lane: string | null;
  waitSec: number;
  answer: string;
  chips: string[];
  stopped: boolean;
  error: string | null;
}

export type NextAction =
  | { action: "send"; text: string }
  | { action: "run_full_analysis" }
  | { action: "done" }
  | { action: "quit" };

export interface TurnDecision {
  reaction: string;
  next: NextAction;
}

export const SCORE_KEYS = ["easeOfUse", "answerUsefulness", "answerClarityForMe", "trustInNumbers", "speed", "modeUnderstanding", "wouldReturn"] as const;

export interface Rating {
  scores: Record<(typeof SCORE_KEYS)[number], number>;
  /** 0–10 "how likely to recommend". */
  nps: number;
  pay: "yes" | "maybe" | "no";
  /** Highest monthly price they'd pay, USD. */
  price: number;
  quit: boolean;
  summary: string;
  quote: string;
  liked: string[];
  frustrations: string[];
  missing: string[];
  /** Checkable factual claims quoted verbatim from the app's answers, for the fact-check sample. */
  claims: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reaction", "action", "text"],
  properties: {
    reaction: { type: "string", description: "Your honest, in-voice reaction to what the app just showed you (2–4 sentences, quote the app where it matters)." },
    action: { type: "string", enum: ["send", "run_full_analysis", "done", "quit"] },
    text: { type: "string", description: "The next message you type, when action is send. Empty otherwise." },
  },
};

const list = { type: "array", items: { type: "string" } };
const RATING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "nps", "pay", "price", "quit", "summary", "quote", "liked", "frustrations", "missing", "claims"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: [...SCORE_KEYS],
      properties: Object.fromEntries(SCORE_KEYS.map((k) => [k, { type: "integer", description: "1–10" }])),
    },
    nps: { type: "integer", description: "0–10: how likely you are to recommend Finava to a friend like you" },
    pay: { type: "string", enum: ["yes", "maybe", "no"] },
    price: { type: "number", description: "Most you'd pay per month in USD; 0 if nothing" },
    quit: { type: "boolean", description: "Did you give up before you got what you came for?" },
    summary: { type: "string" },
    quote: { type: "string", description: "What you'd tell a friend, in your own voice" },
    liked: list,
    frustrations: list,
    missing: list,
    claims: { ...list, description: "Up to 3 specific, checkable factual claims (numbers, dates, filings) copied verbatim from the app's answers" },
  },
};

function system(p: Persona, levels: Levels): string {
  return `You are role-playing a beta tester of Finava, an AI stock-research chat app. Stay in character.

You are ${p.name}, ${p.age}, ${p.job}.
AI experience: ${levels.ai[p.ai]} (${p.ai}). Investing experience: ${levels.stock[p.stock]} (${p.stock}).
Why you're here: ${p.goal}
How you write: match this voice — "${p.voiceSample}"

How the session works:
- You chat in the app's default Auto mode. You don't know or care how it routes.
- After a short answer there is a "Run full analysis" button. Press it only if you'd genuinely want more.
- You have the patience a real person like you has. If you'd have given up, quit.
- A session is 2–4 messages. Say "done" when you have what you came for.
- Judge only what the app showed you. Don't invent features or answers.`;
}

function transcript(shown: Shown[]): string {
  return shown
    .map((s, i) =>
      [
        `### Message ${i + 1}`,
        `You typed: ${s.prompt || "(pressed Run full analysis)"}`,
        `Waited: ${s.waitSec.toFixed(0)} s${s.stopped ? " (you gave up waiting and pressed Stop)" : ""}`,
        s.error ? `The app showed an error: ${s.error}` : `The app showed:\n"""\n${s.answer || "(nothing)"}\n"""`,
        s.chips.length ? `Suggested follow-up buttons: ${s.chips.join(" · ")}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}

export class PersonaAgent {
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(
    private client: Anthropic,
    private model: string,
    private persona: Persona,
    private levels: Levels
  ) {}

  private async json<T>(user: string, schema: object, effort: "low" | "medium" | "high"): Promise<T> {
    // Opus 5 refusals: server-side fallback by refusal category. The SDK in this
    // repo predates the `fallbacks` field, so the request is typed loosely.
    const params = {
      model: this.model,
      max_tokens: 16000,
      system: system(this.persona, this.levels),
      messages: [{ role: "user", content: user }],
      thinking: { type: "adaptive" },
      output_config: { effort, format: { type: "json_schema", schema } },
      ...(this.model === "claude-opus-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };
    const res = (await this.client.beta.messages.create(params as never)) as unknown as Anthropic.Message;
    this.usage.inputTokens += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    this.usage.outputTokens += res.usage.output_tokens;
    if (res.stop_reason === "refusal") throw new Error(`persona ${this.persona.id}: model refused`);
    if (res.stop_reason === "max_tokens") throw new Error(`persona ${this.persona.id}: hit max_tokens`);
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (!text) throw new Error(`persona ${this.persona.id}: no text in response`);
    return JSON.parse(text) as T;
  }

  /** How long this person waits before pressing Stop, in seconds. Deterministic by grid cell. */
  patienceSec(): number {
    const stock = Number(this.persona.stock.slice(1));
    // Beginners and casual pickers expect chat speed; pros tolerate a report taking minutes.
    return [0, 60, 75, 60, 180, 240][stock] ?? 120;
  }

  async decide(shown: Shown[], turnsLeft: number): Promise<TurnDecision> {
    const d = await this.json<{ reaction: string; action: NextAction["action"]; text: string }>(
      `${transcript(shown)}\n\nReact to the last thing the app showed you, then decide what you do next. ${
        turnsLeft <= 0 ? "This was your last message: choose done or quit." : `You can send up to ${turnsLeft} more.`
      }`,
      DECISION_SCHEMA,
      "low"
    );
    const next: NextAction =
      d.action === "send" && d.text.trim() && turnsLeft > 0
        ? { action: "send", text: d.text.trim() }
        : d.action === "run_full_analysis" && turnsLeft > 0
          ? { action: "run_full_analysis" }
          : d.action === "quit"
            ? { action: "quit" }
            : { action: "done" };
    return { reaction: d.reaction, next };
  }

  async rate(shown: Shown[], reactions: string[]): Promise<Rating> {
    const r = await this.json<Rating>(
      `Your whole session:\n\n${transcript(shown)}\n\nYour reactions as you went:\n${reactions.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nNow fill in the beta survey honestly, as ${this.persona.name}.`,
      RATING_SCHEMA,
      "medium"
    );
    for (const k of SCORE_KEYS) r.scores[k] = Math.min(10, Math.max(1, Math.round(r.scores[k])));
    r.nps = Math.min(10, Math.max(0, Math.round(r.nps)));
    return r;
  }
}
