import { findGlossaryHits } from "./glossary";

/**
 * Split markdown into top-level blocks so a streaming answer can render each
 * finished block once and re-render only the block still being written.
 *
 * Rendering the whole answer through react-markdown on every reveal frame was
 * 65% of the main thread during a crew answer (Session 1 bench). The split has
 * to be invisible: rendered block by block, the answer must come out the same
 * as rendered in one go, so a blank line only splits where CommonMark would
 * also end the block.
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/** A last line that may still become a list marker once more text arrives ("2", "2."). */
const PARTIAL_LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)]?)$/;
const INDENTED = /^(?: {2,}|\t)\S/;
/** Link reference definitions and footnotes point across blocks; never split those. */
const DEFINITION = /^\s{0,3}\[[^\]]+\]:/m;

export function splitMarkdownBlocks(md: string): string[] {
  if (!md.trim()) return [];
  if (DEFINITION.test(md)) return [md.trim()];

  const lines = md.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let lastContent = "";
  let pendingBlank = false;

  const flush = () => {
    const text = current.join("\n").replace(/\s+$/, "");
    if (text.trim()) blocks.push(text.replace(/^\n+/, ""));
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      current.push(line);
      const m = FENCE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length).trim()) fence = null;
      lastContent = line;
      continue;
    }

    if (!line.trim()) {
      if (current.length) pendingBlank = true;
      if (current.length) current.push(line);
      continue;
    }

    if (pendingBlank) {
      pendingBlank = false;
      const inList = LIST_ITEM.test(lastContent) || INDENTED.test(lastContent) || currentIsList(current);
      const isLastLine = i === lines.length - 1;
      const continuesList =
        inList && (LIST_ITEM.test(line) || INDENTED.test(line) || (isLastLine && PARTIAL_LIST_ITEM.test(line)));
      // An indented line after a blank is either list content or indented code:
      // both belong to what came before.
      if (!continuesList && !INDENTED.test(line)) flush();
    }

    const m = FENCE.exec(line);
    if (m) fence = m[1];
    current.push(line);
    lastContent = line;
  }
  flush();
  return blocks;
}

/** The block is (or ends in) a list, so a following item joins it. */
function currentIsList(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    return LIST_ITEM.test(lines[i]) || INDENTED.test(lines[i]);
  }
  return false;
}

/**
 * Text the glossary would actually decorate: plain runs directly inside a
 * paragraph, list item or table cell. Headings, code, emphasis and link text
 * are never marked, so a term there must not stop a later plain mention.
 */
function decoratableText(block: string): string {
  return block
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/~~~[\s\S]*?(~~~|$)/g, " ")
    .split("\n")
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
    .join("\n")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    .replace(/(\*\*|__)[^\n]*?\1/g, " ")
    .replace(/(\*|_)[^\s*_][^\n]*?\1/g, " ");
}

const termsCache = new Map<string, string[]>();
const CACHE_MAX = 500;

function termsIn(block: string): string[] {
  let terms = termsCache.get(block);
  if (!terms) {
    terms = findGlossaryHits(decoratableText(block)).map((h) => h.term);
    if (termsCache.size >= CACHE_MAX) termsCache.clear();
    termsCache.set(block, terms);
  }
  return terms;
}

/**
 * For each block, the glossary terms an earlier block already marked, so a term
 * is still underlined once per answer when the answer renders block by block.
 * Sorted, so the value is stable for memoisation.
 */
export function glossarySeeds(blocks: string[]): string[][] {
  const seen = new Set<string>();
  return blocks.map((block) => {
    const seed = [...seen].sort();
    for (const t of termsIn(block)) seen.add(t);
    return seed;
  });
}
