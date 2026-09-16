// The post-generation number check. Client-safe: no I/O.
//
// The model is told to write every number with its fact ID ("$1.0M
// [F:PFE.insider.largestBuy]"). This module reads the answer back, compares each
// cited number with the fact it names, replaces a wrong one with the fact's own
// value, and strips the IDs. In a Key numbers table row it also fills Source and
// As of from the fact, so the UI's source chip (with its link) is the fact's,
// not whatever the model typed.

import { UNAVAILABLE, type FactEntry } from "./promptBlock";

const CITATION = /\[F:([A-Za-z0-9._-]+)\]/g;

/** How far back from a citation its number may sit ("bought $1.0M of stock [F:…]"). */
const LOOKBACK_CHARS = 60;

// A number token: optional sign, optional $, digits with commas/decimals, optional
// unit or scale. The lookbehind stops "2026-10-30" reading as "-10" and an en-dash
// range ("$86–$195") reading as a negative; the lookahead stops a label like
// "52-week" or "10-year" reading as a number at all.
const NUMBER =
  /(?<![\w.,])(?:[-−](?=\$?\d))?\$?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?(?:%|x(?![a-z])|×|percentage points|pts?(?![a-z])|thousand|million|billion|trillion|bn(?![a-z])|mn(?![a-z])|[KMBT](?![a-z])))?(?!\d|[.,]\d|[-‐–][A-Za-z])/gi;

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
};

export interface ParsedNumber {
  value: number;
  /** Half a unit of the last written digit: "$1.0M" is anything in 0.95M–1.05M. */
  tolerance: number;
  /** The writer put a sign on it. */
  signed: boolean;
  /** Written with a $. */
  currency: boolean;
  unit: "%" | "x" | "pts" | null;
}

export function parseNumberToken(token: string): ParsedNumber | null {
  const t = token.trim();
  const signed = /^[-−+]/.test(t);
  const negative = /^[-−]/.test(t);
  const m = /(\d[\d,]*)(?:\.(\d+))?\s*([a-z%×]+(?: points)?)?\s*$/i.exec(t.replace(/^[-−+]?\$?/, ""));
  if (!m) return null;
  const decimals = m[2]?.length ?? 0;
  const base = parseFloat(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
  if (!Number.isFinite(base)) return null;
  const suffix = (m[3] ?? "").toLowerCase();
  const scale = SCALE[suffix] ?? 1;
  const unit = suffix === "%" ? "%" : suffix === "x" || suffix === "×" ? "x" : /^(pts?|percentage points)$/.test(suffix) ? "pts" : null;
  return {
    value: (negative ? -base : base) * scale,
    tolerance: 0.5 * 10 ** -decimals * scale,
    signed,
    currency: /^[-−+]?\$/.test(t),
    unit,
  };
}

/** How well a written number's form fits a fact's kind: 2 exact, 1 plausible, 0 not this fact. */
function fit(kind: FactEntry["kind"], p: ParsedNumber): 0 | 1 | 2 {
  switch (kind) {
    case "usd": return p.currency ? 2 : 0;
    case "pct":
    case "chg": return p.unit === "%" ? 2 : 0;
    case "pts": return p.unit === "pts" ? 2 : p.unit === "%" ? 1 : 0;
    case "ratio": return p.unit === "x" ? 2 : !p.currency && !p.unit ? 1 : 0;
    case "count":
    case "number": return !p.currency && !p.unit ? 2 : 0;
    default: return 0;
  }
}

/** The number a citation is about: the nearest one whose form fits the fact best. */
function pickToken(region: string, kind: FactEntry["kind"]): { match: RegExpMatchArray; parsed: ParsedNumber } | null {
  let loose: { match: RegExpMatchArray; parsed: ParsedNumber } | null = null;
  for (const match of [...region.matchAll(NUMBER)].reverse()) {
    // A denominator ("62 / 100", "out of 100") is a scale, not the figure.
    if (/(\/|\bout of)\s*$/i.test(region.slice(0, match.index))) continue;
    const parsed = parseNumberToken(match[0]);
    if (!parsed) continue;
    const f = fit(kind, parsed);
    if (f === 2) return { match, parsed };
    if (f === 1) loose ??= { match, parsed };
  }
  return loose;
}

function matches(written: ParsedNumber, fact: number): boolean {
  const slack = written.tolerance + Math.abs(fact) * 1e-9;
  if (written.signed) return Math.abs(written.value - fact) <= slack;
  // "6.7% below its high" is the same fact as -6.7%.
  return Math.abs(Math.abs(written.value) - Math.abs(fact)) <= slack;
}

export interface Mismatch {
  id: string;
  written: string;
  replacedWith: string;
}

/** The number was right but its ID named another fact; the number was kept. */
export interface Reattribution {
  from: string;
  to: string;
  written: string;
}

export interface VerifyResult {
  text: string;
  mismatches: Mismatch[];
  unknownIds: string[];
  reattributed: Reattribution[];
}

export interface VerifyOptions {
  onMismatch?: (m: Mismatch) => void;
  onReattribute?: (r: Reattribution) => void;
}

/** The subject an ID belongs to: "PFE" for PFE.insider.buyTotal, "PORT.GOOGL" for a holding. */
function subjectOf(id: string): string {
  const parts = id.split(".");
  return parts[0] === "PORT" && parts.length > 2 ? `${parts[0]}.${parts[1]}` : parts[0];
}

/**
 * A written number that matches a different fact about the same subject is a
 * citation slip, not an arithmetic error: replacing it would turn a true figure
 * into a false one. Returns that fact, or null.
 */
function matchingSibling(written: ParsedNumber, citedId: string, index: Map<string, FactEntry>): FactEntry | null {
  const subject = subjectOf(citedId);
  for (const e of index.values()) {
    if (e.id === citedId || e.kind === "text" || e.value == null) continue;
    if (subjectOf(e.id) !== subject || fit(e.kind, written) === 0) continue;
    if (matches(written, e.value)) return e;
  }
  return null;
}

/**
 * Check and strip the citations in one run of text (no table handling). Each
 * citation's resolved fact (after any re-attribution) is pushed to `resolved`.
 */
function verifyInline(
  text: string,
  index: Map<string, FactEntry>,
  out: VerifyResult,
  opts: VerifyOptions,
  resolved: FactEntry[] = []
): string {
  let result = "";
  let cursor = 0;
  let windowStart = 0;
  for (const cite of text.matchAll(CITATION)) {
    const at = cite.index!;
    const id = cite[1];
    const entry = index.get(id);
    let before = text.slice(cursor, at);

    if (!entry) {
      out.unknownIds.push(id);
    } else if (entry.kind === "text") {
      resolved.push(entry);
    } else {
      const from = Math.max(windowStart, at - LOOKBACK_CHARS) - cursor;
      const region = before.slice(Math.max(0, from));
      const picked = pickToken(region, entry.kind);
      const last = picked?.match;
      const parsed = picked?.parsed ?? null;
      const sibling = last && parsed && !(entry.value != null && matches(parsed, entry.value))
        ? matchingSibling(parsed, id, index)
        : null;
      resolved.push(sibling ?? entry);
      if (sibling) {
        const r = { from: id, to: sibling.id, written: last![0].trim() };
        out.reattributed.push(r);
        opts.onReattribute?.(r);
      } else if (last && parsed) {
        const ok = entry.value != null && matches(parsed, entry.value);
        if (!ok) {
          const replacement =
            entry.value == null ? UNAVAILABLE : parsed.signed ? entry.text : entry.text.replace(/^[-+]/, "");
          const pos = before.length - region.length + last.index!;
          const written = last[0].trim();
          before = before.slice(0, pos) + last[0].replace(written, replacement) + before.slice(pos + last[0].length);
          const m = { id, written, replacedWith: replacement };
          out.mismatches.push(m);
          opts.onMismatch?.(m);
        }
      }
    }

    // Drop the citation and the one space that introduced it.
    result += before.replace(/[ \t]$/, "");
    cursor = at + cite[0].length;
    windowStart = cursor;
  }
  return result + text.slice(cursor);
}

function sourceCell(e: FactEntry): string {
  const name = e.source.replace(/\|/g, "/");
  return e.url && /^https?:\/\//.test(e.url) ? `[${name}](${e.url})` : name;
}

/** A Key numbers row: check the value, then take Source and As of from the fact. */
function verifyTableRow(line: string, index: Map<string, FactEntry>, out: VerifyResult, opts: VerifyOptions): string {
  const indent = /^\s*/.exec(line)![0];
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  const valueFacts: FactEntry[] = [];
  const checked = cells.map((c, i) => verifyInline(c, index, out, opts, i === 1 ? valueFacts : []));
  const entry = valueFacts[0];

  if (entry && cells.length >= 2 && cells.length <= 4) {
    while (checked.length < 4) checked.push(" ");
    if (entry.value == null && entry.kind !== "text") checked[1] = ` ${UNAVAILABLE} `;
    checked[2] = ` ${sourceCell(entry)} `;
    checked[3] = ` ${entry.asOf.slice(0, 10)} `;
  }
  return `${indent}|${checked.join("|")}|`;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * Rewrite the citation shapes models actually produce into the one we check:
 * "[F:X.pe = 53.2x]" → "53.2x [F:X.pe]", "[F:X.a, F:X.b]" → "[F:X.a][F:X.b]".
 */
function normalizeCitations(line: string): string {
  return line
    .replace(/\[F:\s*([A-Za-z0-9._-]+)\s*[=:]\s*([^\][]+?)\s*\]/g, "$2 [F:$1]")
    .replace(/\[F:([^\][]*[,;][^\][]*)\]/g, (_, ids: string) =>
      ids
        .split(/[,;]/)
        .map((id) => id.trim().replace(/^F:\s*/, ""))
        .filter(Boolean)
        .map((id) => `[F:${id}]`)
        .join("")
    );
}

/** Whatever citation-like fragment is left is dropped: an ID is never shown to a reader. */
function sweepCitations(line: string): string {
  return line.replace(/[ \t]*\[F:[^\]]*\]/g, "").replace(/[ \t]*\[F:[^\]]*$/, "");
}

/** Verify and strip every citation in a finished (or line-complete) piece of text. */
export function verifyCitations(text: string, index: Map<string, FactEntry>, opts: VerifyOptions = {}): VerifyResult {
  const out: VerifyResult = { text: "", mismatches: [], unknownIds: [], reattributed: [] };
  if (!text.includes("[F:")) return { ...out, text };
  out.text = text
    .split("\n")
    .map((raw) => {
      if (!raw.includes("[F:")) return raw;
      const line = normalizeCitations(raw);
      const checked = TABLE_ROW.test(line) ? verifyTableRow(line, index, out, opts) : verifyInline(line, index, out, opts);
      return sweepCitations(checked);
    })
    .join("\n");
  return out;
}

export interface CitationStream {
  /** Add a streamed delta; complete lines are checked and emitted. */
  push(delta: string): void;
  /** Check and emit whatever is left. */
  flush(): void;
  /** A whole-answer replacement: resets the stream and returns the checked text (not emitted). */
  replace(full: string): string;
  /** Everything emitted or replaced so far, checked. */
  text(): string;
  mismatches(): Mismatch[];
  unknownIds(): string[];
}

/**
 * Line-buffered check for a streamed answer. A number and its citation always
 * sit on one line, so holding back only the unfinished line is enough to fix a
 * number before any of it reaches the reader.
 */
export function createCitationStream(
  index: Map<string, FactEntry>,
  emit: (text: string) => void,
  opts: VerifyOptions & { maxBufferChars?: number } = {}
): CitationStream {
  const max = opts.maxBufferChars ?? 4_000;
  let buf = "";
  let acc = "";
  const mismatches: Mismatch[] = [];
  const unknown: string[] = [];

  const check = (chunk: string) => {
    if (!chunk) return;
    const r = verifyCitations(chunk, index, opts);
    mismatches.push(...r.mismatches);
    unknown.push(...r.unknownIds);
    acc += r.text;
    if (r.text) emit(r.text);
  };

  return {
    push(delta) {
      buf += delta;
      const nl = buf.lastIndexOf("\n");
      if (nl >= 0) {
        check(buf.slice(0, nl + 1));
        buf = buf.slice(nl + 1);
      }
      if (buf.length > max) {
        // Keep an unfinished citation back so it's never split from its number.
        const open = buf.lastIndexOf("[");
        const cut = open >= 0 && !buf.slice(open).includes("]") ? open : buf.length;
        check(buf.slice(0, cut));
        buf = buf.slice(cut);
      }
    },
    flush() {
      check(buf);
      buf = "";
    },
    replace(full) {
      buf = "";
      const r = verifyCitations(full, index, opts);
      mismatches.push(...r.mismatches);
      unknown.push(...r.unknownIds);
      acc = r.text;
      return r.text;
    },
    text: () => acc,
    mismatches: () => [...mismatches],
    unknownIds: () => [...unknown],
  };
}

/** A Source cell as label + link. Only http(s) links are links. Client-safe. */
export function sourceLink(source: string): { label: string; href?: string } {
  const m = /^\[([^\]]+)\]\((\S+)\)$/.exec(source.trim());
  if (!m) return { label: source };
  return /^https?:\/\//i.test(m[2]) ? { label: m[1], href: m[2] } : { label: m[1] };
}
