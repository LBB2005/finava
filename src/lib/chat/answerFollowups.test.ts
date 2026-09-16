import { describe, it, expect } from "vitest";
import { answerFollowupPrompt, parseFollowups, answerAnchors } from "./answerFollowups";

const ANSWER = `## Answer
NVDA is priced for four more quarters of data-centre growth.

## Key numbers
| Metric | Value | Source | As of |
| --- | --- | --- | --- |
| Price | $184.21 | Polygon | 2026-09-15 |
| Free cash flow | Unavailable | — | — |

## Bear case
- Customer concentration: three hyperscalers are most of revenue
- AMD's MI450 ships in Q1

## Confidence & gaps
Medium — no options data for this ticker.`;

describe("answerAnchors", () => {
  const a = answerAnchors(ANSWER);

  it("picks up tickers the answer actually named", () => {
    expect(a.tickers).toEqual(["NVDA", "AMD"]);
  });

  it("lists the gaps the answer admitted to", () => {
    expect(a.gaps.join(" ")).toContain("no options data");
    expect(a.gaps.join(" ")).toContain("Free cash flow");
  });

  it("keeps the bear points as chip material", () => {
    expect(a.bearPoints[0]).toContain("Customer concentration");
  });

  it("survives a non-contract answer", () => {
    const plain = answerAnchors("Yes — it beat on both lines.");
    expect(plain.tickers).toEqual([]);
    expect(plain.gaps).toEqual([]);
    expect(plain.bearPoints).toEqual([]);
  });
});

describe("answerFollowupPrompt", () => {
  const p = answerFollowupPrompt({ question: "Is NVDA a buy?", answer: ANSWER });

  it("feeds the answer's own content to the model, not just the question", () => {
    expect(p).toContain("NVDA");
    expect(p).toContain("no options data");
    expect(p).toContain("Customer concentration");
  });

  it("states the chip limits the UI enforces", () => {
    expect(p).toContain("3");
    expect(p).toContain("40 characters");
  });

  it("bans definition chips for terms the user never asked about", () => {
    expect(p.toLowerCase()).toContain("do not");
    expect(p.toLowerCase()).toContain("definition");
  });
});

describe("parseFollowups", () => {
  it("reads a JSON array out of a chatty response", () => {
    expect(parseFollowups('Sure!\n["Compare AMD", "Show the DCF"]')).toEqual(["Compare AMD", "Show the DCF"]);
  });

  it("caps at 3 chips", () => {
    expect(parseFollowups('["a one","b two","c three","d four"]')).toHaveLength(3);
  });

  it("drops chips over 40 characters rather than truncating them", () => {
    const long = "x".repeat(41);
    expect(parseFollowups(`["${long}","Short one"]`)).toEqual(["Short one"]);
  });

  it("drops definition chips the user did not ask for", () => {
    expect(parseFollowups('["What is a P/E ratio?","Compare AMD"]')).toEqual(["Compare AMD"]);
  });

  it("keeps a question that only looks like a definition chip", () => {
    expect(parseFollowups('["What are the risks?","What is the bear case?"]')).toEqual([
      "What are the risks?",
      "What is the bear case?",
    ]);
  });

  it("keeps a definition chip when the user asked what something is", () => {
    expect(parseFollowups('["What is a P/E ratio?"]', { question: "what is an ETF" })).toEqual(["What is a P/E ratio?"]);
  });

  it("drops blanks and duplicates", () => {
    expect(parseFollowups('["Compare AMD","  ","compare amd"]')).toEqual(["Compare AMD"]);
  });

  it("returns nothing for junk", () => {
    expect(parseFollowups("no json here")).toEqual([]);
    expect(parseFollowups(null)).toEqual([]);
    expect(parseFollowups('{"a":1}')).toEqual([]);
  });
});
