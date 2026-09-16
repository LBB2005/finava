/**
 * The answer contract shared by the fast lane, the crew and the UI.
 *
 * The model writes these H2 sections; `parseAnswer` reads them back so the UI
 * can lead with the verdict instead of burying it 20,000 characters down. The
 * parse is deliberately forgiving: it runs on every streaming frame, so a
 * half-typed heading or a table with one row written must not throw away the
 * text that already arrived.
 */

export const ANSWER_HEADINGS = {
  answer: "Answer",
  keyNumbers: "Key numbers",
  bull: "Bull case",
  bear: "Bear case",
  changeView: "What would change the view",
  confidence: "Confidence & gaps",
  details: "Details",
} as const;

export type AnswerSection = keyof typeof ANSWER_HEADINGS;

/** The block prompts paste in so the written shape and the parsed shape match. */
export const ANSWER_CONTRACT_BLOCK = `Answer in markdown with these exact H2 headings, in this order. Omit a heading only when you have nothing true to put under it.

## ${ANSWER_HEADINGS.answer}
2–3 plain-English sentences answering the literal question. No hedging preamble.

## ${ANSWER_HEADINGS.keyNumbers}
| Metric | Value | Source | As of |
Only numbers that came from data or tools. Write "Unavailable" when a number is missing — never invent one.

## ${ANSWER_HEADINGS.bull}
- up to 3 bullets

## ${ANSWER_HEADINGS.bear}
- up to 3 bullets

## ${ANSWER_HEADINGS.changeView}
- 1–3 bullets

## ${ANSWER_HEADINGS.confidence}
One line: High/Medium/Low, plus what data is missing.

## ${ANSWER_HEADINGS.details}
Everything else: per-agent sections, tables, charts, conflicting signals. The UI collapses this by default.

A request for brevity or a specific format ("yes or no", "3 bullets") overrides this shape — answer as asked.`;

export interface KeyNumberRow {
  metric: string;
  value: string;
  source?: string;
  asOf?: string;
  /** The model reported no figure. Rendered as a styled placeholder, not an error. */
  unavailable: boolean;
}

export interface ParsedAnswer {
  /** Text before the first recognised heading — also the whole body of a non-contract reply. */
  preamble?: string;
  answer?: string;
  keyNumbers?: KeyNumberRow[];
  bull?: string;
  bear?: string;
  changeView?: string;
  confidence?: string;
  details?: string;
  /** H2 sections that are not part of the contract, kept in written order. */
  other?: { heading: string; body: string }[];
  raw: string;
}

/** `## **Key numbers**:` → `key numbers` */
function normalizeHeading(label: string): string {
  return label
    .replace(/[*_`]/g, "")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();
}

const SECTION_BY_HEADING = new Map<string, AnswerSection>(
  (Object.entries(ANSWER_HEADINGS) as [AnswerSection, string][]).map(([key, label]) => [
    normalizeHeading(label),
    key,
  ])
);

// "Confidence & gaps" also arrives as "Confidence and gaps".
const ALIASES: Record<string, AnswerSection> = {
  "confidence and gaps": "confidence",
  "key numbers & sources": "keyNumbers",
};

function sectionFor(label: string): AnswerSection | undefined {
  const norm = normalizeHeading(label);
  return SECTION_BY_HEADING.get(norm) ?? ALIASES[norm];
}

interface RawSection { section?: AnswerSection; heading: string; body: string }

/**
 * Split markdown into H2 sections. The last line is dropped when it is an
 * unterminated heading — while streaming, `## Key num` is not yet a section.
 */
function splitSections(md: string): { preamble: string; sections: RawSection[] } {
  const lines = md.split("\n");
  // An unterminated final line that looks like a heading is still being typed.
  if (lines.length > 0 && !md.endsWith("\n")) {
    const last = lines[lines.length - 1];
    if (/^##\s*\S*$|^#{1,2}$/.test(last.trim()) && !/^##\s+\S+\s*$/.test(last.trim())) {
      lines.pop();
    } else if (/^##\s+/.test(last.trim()) && !sectionFor(last.trim().replace(/^#+\s+/, ""))) {
      // A recognisable but incomplete contract heading ("## Key num") — hold it
      // back rather than opening a section under the wrong name.
      const partial = normalizeHeading(last.trim().replace(/^#+\s+/, ""));
      const isPrefixOfContract = [...SECTION_BY_HEADING.keys()].some(
        (h) => h.startsWith(partial) && h !== partial
      );
      if (isPrefixOfContract) lines.pop();
    }
  }

  const preambleLines: string[] = [];
  const sections: RawSection[] = [];
  let current: RawSection | null = null;

  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line.trim());
    if (m) {
      const heading = m[1].replace(/[*_`]/g, "").replace(/:$/, "").trim();
      current = { section: sectionFor(m[1]), heading, body: "" };
      sections.push(current);
      continue;
    }
    if (current) current.body += (current.body ? "\n" : "") + line;
    else preambleLines.push(line);
  }

  for (const s of sections) s.body = s.body.replace(/\s+$/, "");
  return { preamble: preambleLines.join("\n").trim(), sections };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const EMPTY_CELL = /^(|—|-{1,3}|n\/a|na|null|undefined)$/i;
const UNAVAILABLE = /^unavailable$/i;

/** Read the Key numbers markdown table. Unfinished trailing rows are skipped. */
export function parseKeyNumbers(body: string): KeyNumberRow[] {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows: KeyNumberRow[] = [];
  let sawHeader = false;

  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    // A row still being streamed has no closing pipe.
    if (!line.endsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator
    if (!sawHeader && /^metric$/i.test(cells[0] ?? "")) { sawHeader = true; continue; }
    if (cells.length < 2) continue;
    const [metric, value, source, asOf] = cells;
    if (!metric) continue;
    rows.push({
      metric,
      value: value ?? "",
      source: source && !EMPTY_CELL.test(source) ? source : undefined,
      asOf: asOf && !EMPTY_CELL.test(asOf) ? asOf : undefined,
      unavailable: UNAVAILABLE.test(value ?? ""),
    });
  }
  return rows;
}

/** Parse a (possibly partial) answer into its contract sections. */
export function parseAnswer(md: string): ParsedAnswer {
  if (!md) return { raw: "" };

  const { preamble, sections } = splitSections(md);
  const out: ParsedAnswer = { raw: md };
  if (preamble) out.preamble = preamble;

  for (const s of sections) {
    if (!s.section) {
      (out.other ??= []).push({ heading: s.heading, body: s.body });
      continue;
    }
    if (s.section === "keyNumbers") {
      const rows = parseKeyNumbers(s.body);
      if (rows.length) out.keyNumbers = rows;
      continue;
    }
    out[s.section] = s.body.trim();
  }
  return out;
}

/**
 * Is this markdown written to the contract? `## Answer` alone counts (a simple
 * conceptual question), otherwise two contract sections are needed so a legacy
 * report with a "Summary" heading doesn't get rendered as an answer card.
 */
export function isContractShaped(md: string): boolean {
  if (!md) return false;
  const { sections } = splitSections(md);
  const known = sections.filter((s) => s.section);
  if (known.some((s) => s.section === "answer")) return true;
  return known.length >= 2;
}
