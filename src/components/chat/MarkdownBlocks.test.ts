import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Markdown, { MarkdownBlock, components, glossaryComponents } from "./Markdown";
import { GlossaryMarks } from "@/lib/glossary";

/**
 * The streaming answer renders block by block so finished blocks can be
 * memoised. That is only safe if the result is the same answer: these compare
 * block-by-block HTML with the old one-pass render over every recorded answer.
 */

const FIXTURES = path.resolve(__dirname, "../../../evals/fixtures/sse");
const answers = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".expected.md"))
  .map((f) => ({ name: f, md: readFileSync(path.join(FIXTURES, f), "utf8") }));

/** Whitespace between tags is the only allowed difference (react-markdown emits "\n" between blocks). */
const norm = (html: string) => html.replace(/>\s+</g, "><").trim();

function onePass(md: string, glossary: boolean): string {
  return renderToStaticMarkup(
    createElement(
      "div",
      { className: "markdown-body " },
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm], components: glossary ? glossaryComponents(new GlossaryMarks()) : components },
        md
      )
    )
  );
}

function blocks(md: string, glossary: boolean): string {
  const props = { glossary } as ComponentProps<typeof Markdown>;
  return renderToStaticMarkup(createElement(Markdown, props, md));
}

describe("block-by-block markdown", () => {
  it("has fixtures to compare", () => {
    expect(answers.length).toBeGreaterThan(5);
  });

  for (const { name, md } of answers) {
    it(`renders ${name} exactly as the one-pass render`, () => {
      expect(norm(blocks(md, false))).toBe(norm(onePass(md, false)));
    });

    it(`underlines the same glossary terms in ${name}`, () => {
      const terms = (html: string) => [...html.matchAll(/glossary-term"[^>]*>([^<]+)</g)].map((m) => m[1]);
      const a = blocks(md, true);
      const b = onePass(md, true);
      expect(terms(a)).toEqual(terms(b));
      if (name.startsWith("recorded-agent")) expect(terms(a).length).toBeGreaterThan(0);
      expect(norm(a)).toBe(norm(b));
    });
  }

  it("renders every partial prefix of an answer without throwing", () => {
    const { md } = answers.find((a) => a.name.startsWith("recorded-agent")) ?? answers[0];
    for (let i = 0; i < md.length; i += 97) {
      expect(() => blocks(md.slice(0, i), true)).not.toThrow();
    }
  });

  it("exports a memoised block, so a finished block is not re-rendered", () => {
    // React.memo components carry $$typeof = Symbol.for("react.memo").
    expect((MarkdownBlock as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });
});
