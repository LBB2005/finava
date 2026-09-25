import { describe, expect, it, vi } from "vitest";

// Message reaches the Firebase client (auth, experience level), which needs
// browser env. Nothing under test touches it.
vi.mock("@/lib/firebase", () => ({ auth: {}, db: {}, app: {} }));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import AnswerCard from "./AnswerCard";
import KeyNumbers from "./KeyNumbers";
import CaseColumns from "./CaseColumns";
import Message from "../Message";

const CREW = readFileSync(
  path.resolve(__dirname, "../../../../evals/fixtures/sse/recorded-agent-verdict-then-escalate-3.expected.md"),
  "utf8"
);

function card(markdown: string, streaming: boolean): string {
  return renderToStaticMarkup(createElement(AnswerCard, { markdown, messageId: "m1", streaming }));
}

const FADE = "fade-in fade-in-still";

describe("AnswerCard while streaming", () => {
  it("fades each section in (opacity only) when it mounts mid-stream", () => {
    const html = card(CREW, true);
    // Answer lede, key numbers, bull, bear, change-view, confidence, details.
    expect(html.split(FADE).length - 1).toBeGreaterThanOrEqual(7);
    // The card itself does not also fade: the sections do.
    expect(html.startsWith('<div style')).toBe(true);
  });

  it("fades a settled card in whole, and none of its sections", () => {
    const html = card(CREW, false);
    expect(html).toContain('class="verdict-fadein"');
    expect(html).not.toContain(FADE);
  });

  it("shows the details control while streaming, disabled, so the end of the stream doesn't add one", () => {
    const live = card(CREW, true);
    expect(live).toContain("Writing the full analysis…");
    expect(live).toMatch(/<button[^>]*disabled=""/);
    const settled = card(CREW, false);
    expect(settled).toContain("Show full analysis");
  });

  it("has the same layout streaming and settled: only classes and the details label differ", () => {
    const strip = (html: string) =>
      html
        .replace(/ class="[^"]*"/g, "")
        .replace(/ disabled=""/g, "")
        .replace(/ aria-expanded="(true|false)"/g, "")
        .replace(/cursor:(default|pointer);opacity:[0-9.]+/g, "")
        .replace("Writing the full analysis…", "Show full analysis");
    expect(strip(card(CREW, true))).toBe(strip(card(CREW, false)));
  });
});

describe("memoised sections", () => {
  const isMemo = (c: unknown) => (c as { $$typeof: symbol }).$$typeof === Symbol.for("react.memo");

  it("memoises the section components and the message", () => {
    expect(isMemo(KeyNumbers)).toBe(true);
    expect(isMemo(CaseColumns)).toBe(true);
    expect(isMemo(Message)).toBe(true);
  });

  it("treats a re-parsed but identical key-numbers table as unchanged", () => {
    const compare = (KeyNumbers as unknown as { compare: (a: object, b: object) => boolean }).compare;
    const rows = () => [{ metric: "RSI", value: "42.4", source: "Technical Agent", asOf: "Sep 18", unavailable: false }];
    expect(compare({ rows: rows() }, { rows: rows() })).toBe(true);
    expect(compare({ rows: rows() }, { rows: [...rows(), ...rows()] })).toBe(false);
  });
});

describe("the streaming message", () => {
  it("renders with the F avatar, never the pre-rebrand L", () => {
    const html = renderToStaticMarkup(
      createElement(Message, {
        message: { id: "streaming", role: "assistant", content: "## Answer\nYes.", mode: "fast", createdAt: new Date(0).toISOString() },
        streaming: true,
      })
    );
    expect(html).toMatch(/>F<\/div>/);
    expect(html).not.toMatch(/>L<\/div>/);
  });
});
