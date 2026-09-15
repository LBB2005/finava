// Section headings that hold the verdict, most specific first. `## Answer` is
// the answer contract (see docs/superpowers/plans/2026-09-beta-fixes/00-README.md);
// the rest cover today's crew report ("Summary & Recommendation").
const SECTION_PRIORITY = [/\banswer\b/i, /\bverdict\b/i, /\bbottom line\b/i, /\brecommendation\b/i, /\bsummary\b/i, /\bconclusion\b/i];

const DISCLAIMER = /not (financial|investment) advice|informational purposes|do your own research|consult (a|an|your) (licensed|financial)/i;

interface Heading { line: number; label: string; rest: string }

function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  lines.forEach((raw, line) => {
    const l = raw.trim();
    const md = /^#{1,6}\s+(.*)$/.exec(l);
    if (md) { out.push({ line, label: md[1], rest: "" }); return; }
    // A bold label line: "**Verdict:** text" or "**Verdict**: text".
    const bold = /^\*\*([^*]+?):\*\*\s*(.*)$/.exec(l) ?? /^\*\*([^*]+?)\*\*:\s*(.*)$/.exec(l);
    if (bold) out.push({ line, label: bold[1], rest: bold[2] });
  });
  return out;
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/[*_`~]+/g, "")
    .trim();
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“($])/).map((x) => x.trim()).filter(Boolean);
}

const isVerdictSentence = (s: string) =>
  !DISCLAIMER.test(s) && s.split(/\s+/).length >= 4 && /[a-z]/i.test(s);

/**
 * The verdict sentence for the VERDICT card: the first real sentence of the
 * report's verdict section. Returns null when there is no such section or it
 * holds only a disclaimer or a fragment; the caller hides the card then.
 */
export function extractVerdict(markdown: string): string | null {
  if (!markdown) return null;
  const lines = markdown.split("\n");
  const hs = headings(lines);

  for (const re of SECTION_PRIORITY) {
    const idx = hs.findIndex((h) => re.test(h.label));
    if (idx < 0) continue;
    const h = hs[idx];
    const end = hs[idx + 1]?.line ?? lines.length;
    const body = [h.rest, ...lines.slice(h.line + 1, end)]
      .filter((l) => !l.trim().startsWith("|"))
      .map(stripMarkdown)
      .filter(Boolean)
      .join(" ");
    const found = sentences(body).find(isVerdictSentence);
    if (found) return found;
  }
  return null;
}
