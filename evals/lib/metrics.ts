/**
 * Pure measurement helpers shared by the live eval, the panel and the report.
 * No I/O here, so every number in a readout can be unit-tested.
 */
import { parseAnswer } from "@/lib/answerFormat";

// ── distributions ────────────────────────────────────────────────────────────

/** Nearest-rank percentile (p in 0–100). Null for an empty sample. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  return xs[Math.min(xs.length - 1, Math.max(0, rank - 1))];
}

export const median = (values: number[]) => percentile(values, 50);

export function mean(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// ── NPS ──────────────────────────────────────────────────────────────────────

/** Net Promoter Score from 0–10 ratings: % promoters (9–10) minus % detractors (0–6). */
export function nps(ratings: number[]): number | null {
  if (!ratings.length) return null;
  const promoters = ratings.filter((r) => r >= 9).length;
  const detractors = ratings.filter((r) => r <= 6).length;
  return Math.round(((promoters - detractors) / ratings.length) * 100);
}

// ── collapse ─────────────────────────────────────────────────────────────────

export interface CollapseCheck {
  streamedChars: number;
  renderedChars: number;
  savedChars: number;
  reloadedChars: number | null;
  collapsed: boolean;
  /** Which stage lost text first. */
  where: "rendered" | "saved" | "reloaded" | null;
}

/**
 * Did the user keep what the server sent? `streamed` is the answer rebuilt from
 * the raw wire (independent of client code). Any later stage that is shorter, or
 * different, is a collapse. A stopped run is judged against what had rendered.
 */
export function collapseCheck(a: { streamed: string; rendered: string; saved: string; reloaded?: string | null }): CollapseCheck {
  const out: CollapseCheck = {
    streamedChars: a.streamed.length,
    renderedChars: a.rendered.length,
    savedChars: a.saved.length,
    reloadedChars: a.reloaded == null ? null : a.reloaded.length,
    collapsed: false,
    where: null,
  };
  if (a.rendered !== a.streamed) out.where = "rendered";
  else if (a.saved !== a.streamed) out.where = "saved";
  else if (a.reloaded != null && a.reloaded !== a.saved) out.where = "reloaded";
  out.collapsed = out.where !== null;
  return out;
}

/**
 * The answer as the wire carried it, from raw `data:` payloads, without the
 * client reducer. The last `replace` event resets; every other `final_response`
 * appends. For /api/chat payloads, `text` fields append.
 */
export function answerFromWire(payloads: unknown[]): string {
  let out = "";
  for (const p of payloads) {
    if (!p || typeof p !== "object") continue;
    const e = p as { type?: string; content?: unknown; replace?: unknown; text?: unknown };
    if (e.type === "final_response" && typeof e.content === "string") out = e.replace === true ? e.content : out + e.content;
    else if (e.type === undefined && typeof e.text === "string") out += e.text;
  }
  return out;
}

// ── answer contract ──────────────────────────────────────────────────────────

const CORE = ["answer", "keyNumbers", "bull", "bear", "changeView", "confidence"] as const;
type Core = (typeof CORE)[number];

export interface ContractShape {
  /** full: every core section. answer_only: `## Answer` alone (allowed for conceptual questions). partial: some. none: no contract headings. */
  kind: "full" | "answer_only" | "partial" | "none";
  missing: Core[];
}

export function contractShape(md: string): ContractShape {
  const parsed = parseAnswer(md) as unknown as Record<string, unknown>;
  const present = CORE.filter((k) => parsed[k] !== undefined && parsed[k] !== "");
  if (!present.length) return { kind: "none", missing: [] };
  const missing = CORE.filter((k) => !present.includes(k));
  if (!missing.length) return { kind: "full", missing: [] };
  if (present.length === 1 && present[0] === "answer") return { kind: "answer_only", missing: [] };
  return { kind: "partial", missing };
}

// ── number check (W4-1) ──────────────────────────────────────────────────────

export interface NumberCheck {
  checked: number;
  mismatched: number;
}

/**
 * W4-1 verifies cited numbers against the facts layer after generation. The
 * eval reads a `number_check` SSE event ({ checked, mismatched }) when the server
 * emits one. Until W4-1 merges nothing emits it, and the result is null
 * ("Unavailable"), never zero.
 */
export function numberCheckFrom(payloads: unknown[]): NumberCheck | null {
  let checked = 0;
  let mismatched = 0;
  let seen = false;
  for (const p of payloads) {
    const e = p as { type?: string; checked?: unknown; mismatched?: unknown };
    if (e?.type === "number_check" && typeof e.checked === "number" && typeof e.mismatched === "number") {
      seen = true;
      checked += e.checked;
      mismatched += e.mismatched;
    }
  }
  return seen ? { checked, mismatched } : null;
}

export function mismatchRate(checks: (NumberCheck | null)[]): number | null {
  const real = checks.filter((c): c is NumberCheck => c !== null);
  const checked = real.reduce((a, c) => a + c.checked, 0);
  return checked ? real.reduce((a, c) => a + c.mismatched, 0) / checked : null;
}
