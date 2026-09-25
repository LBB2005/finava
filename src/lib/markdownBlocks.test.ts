import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { glossarySeeds, splitMarkdownBlocks } from "./markdownBlocks";

const FIXTURES = path.resolve(__dirname, "../../evals/fixtures/sse");
const expected = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".expected.md"))
  .map((f) => ({ name: f, md: readFileSync(path.join(FIXTURES, f), "utf8") }));

describe("splitMarkdownBlocks", () => {
  it("splits top-level blocks on blank lines", () => {
    expect(splitMarkdownBlocks("One.\n\nTwo.\n\n\nThree.")).toEqual(["One.", "Two.", "Three."]);
  });

  it("returns nothing for empty text", () => {
    expect(splitMarkdownBlocks("")).toEqual([]);
    expect(splitMarkdownBlocks("\n\n  \n")).toEqual([]);
  });

  it("keeps a fenced code block whole, blank lines and all", () => {
    const md = "Intro.\n\n```chart\n{\n\n  \"a\": 1\n}\n```\n\nAfter.";
    expect(splitMarkdownBlocks(md)).toEqual(["Intro.", "```chart\n{\n\n  \"a\": 1\n}\n```", "After."]);
  });

  it("keeps an unterminated fence (still streaming) in the tail block", () => {
    expect(splitMarkdownBlocks("Intro.\n\n```\ncode\n\nmore")).toEqual(["Intro.", "```\ncode\n\nmore"]);
  });

  it("keeps a loose list together, so it renders as one list", () => {
    const md = "- one\n\n- two\n\n  continued\n\n1. a\n\n2. b\n\nAfter.";
    expect(splitMarkdownBlocks(md)).toEqual(["- one\n\n- two\n\n  continued\n\n1. a\n\n2. b", "After."]);
  });

  it("does not split text that uses reference definitions or footnotes", () => {
    const md = "See [the filing][1].\n\nMore.\n\n[1]: https://www.sec.gov/";
    expect(splitMarkdownBlocks(md)).toEqual([md]);
  });

  it("keeps finished blocks byte-identical while the stream grows (only the tail changes)", () => {
    for (const { md } of expected) {
      let prev: string[] = [];
      for (let i = 1; i <= md.length; i += 7) {
        const blocks = splitMarkdownBlocks(md.slice(0, i));
        // Every block but the last one of the previous step is unchanged.
        for (let b = 0; b < prev.length - 1; b++) expect(blocks[b]).toBe(prev[b]);
        prev = blocks;
      }
    }
  });
});

describe("glossarySeeds", () => {
  it("blocks a term in later blocks once plain text in an earlier block used it", () => {
    const seeds = glossarySeeds(["The P/E is high.", "Its P/E and EPS both rose."]);
    expect(seeds[0]).toEqual([]);
    expect(seeds[1]).toEqual(["P/E"]);
  });

  it("ignores mentions the glossary never marks: headings, code, bold, link text", () => {
    const seeds = glossarySeeds(["## P/E and EPS\n\n`FCF` **DCF** [ROE](https://x.test)", "P/E, EPS, FCF, DCF, ROE"]);
    expect(seeds[1]).toEqual([]);
  });

  it("accumulates across blocks", () => {
    const seeds = glossarySeeds(["EPS rose.", "P/E fell.", "Both."]);
    expect(seeds[2]).toEqual(["EPS", "P/E"]);
  });
});
