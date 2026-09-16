import { describe, it, expect } from "vitest";
import {
  ANSWER_HEADINGS,
  ANSWER_CONTRACT_BLOCK,
  parseAnswer,
  isContractShaped,
} from "./answerFormat";

const FULL = `## Answer
NVDA looks expensive against its own history but the growth still supports it. The bull case rests on data-centre demand holding through 2027.

## Key numbers
| Metric | Value | Source | As of |
| --- | --- | --- | --- |
| Price | $184.21 | Polygon | 2026-09-15 |
| P/E (TTM) | 48.2 | SEC 10-Q | 2026-07-27 |
| Free cash flow | Unavailable | — | — |

## Bull case
- Data-centre backlog covers four quarters
- Gross margin above 70%

## Bear case
- Customer concentration in three hyperscalers

## What would change the view
- A hyperscaler cutting 2027 capex guidance

## Confidence & gaps
Medium — no options data for this ticker.

## Details
### Risk Analysis
Beta 1.7 against SPY.
`;

describe("isContractShaped", () => {
  it("accepts a full contract answer", () => {
    expect(isContractShaped(FULL)).toBe(true);
  });

  it("accepts an Answer-only reply (simple conceptual question)", () => {
    expect(isContractShaped("## Answer\nAn ETF is a basket of assets you can buy as one share.")).toBe(true);
  });

  it("rejects a brevity reply with no headings", () => {
    expect(isContractShaped("Yes — it beat on both lines.")).toBe(false);
  });

  it("rejects a legacy report whose headings are not the contract", () => {
    expect(isContractShaped("## Summary & Recommendation\nBuy.\n\n## Technicals\nRSI 62.")).toBe(false);
  });

  it("accepts a contract answer that skips Answer but has two other sections", () => {
    expect(isContractShaped("## Bull case\n- x\n\n## Bear case\n- y")).toBe(true);
  });

  it("handles empty input", () => {
    expect(isContractShaped("")).toBe(false);
  });
});

describe("parseAnswer — full answer", () => {
  const p = parseAnswer(FULL);

  it("pulls the answer prose", () => {
    expect(p.answer).toContain("NVDA looks expensive");
    expect(p.answer).not.toContain("Key numbers");
  });

  it("parses key-number rows with source and as-of", () => {
    expect(p.keyNumbers).toHaveLength(3);
    expect(p.keyNumbers![0]).toEqual({
      metric: "Price",
      value: "$184.21",
      source: "Polygon",
      asOf: "2026-09-15",
      unavailable: false,
    });
  });

  it("flags an Unavailable value instead of dropping the row", () => {
    const fcf = p.keyNumbers!.find((r) => r.metric === "Free cash flow")!;
    expect(fcf.unavailable).toBe(true);
    expect(fcf.source).toBeUndefined();
    expect(fcf.asOf).toBeUndefined();
  });

  it("keeps bull, bear, change-view and confidence bodies", () => {
    expect(p.bull).toContain("Data-centre backlog");
    expect(p.bear).toContain("Customer concentration");
    expect(p.changeView).toContain("2027 capex");
    expect(p.confidence).toBe("Medium — no options data for this ticker.");
  });

  it("keeps the details section verbatim", () => {
    expect(p.details).toContain("### Risk Analysis");
    expect(p.details).toContain("Beta 1.7");
  });

  it("always returns the raw markdown", () => {
    expect(p.raw).toBe(FULL);
  });
});

describe("parseAnswer — heading tolerance", () => {
  it("matches headings case-insensitively and with a trailing colon", () => {
    const p = parseAnswer("## ANSWER:\nShort.\n\n## key Numbers\n| Metric | Value |\n| --- | --- |\n| Price | $1 |");
    expect(p.answer).toBe("Short.");
    expect(p.keyNumbers).toHaveLength(1);
  });

  it("accepts bold-emphasised headings the model sometimes writes", () => {
    const p = parseAnswer("## **Answer**\nShort.");
    expect(p.answer).toBe("Short.");
  });

  it("keeps unrecognised H2 sections instead of dropping them", () => {
    const p = parseAnswer("## Answer\nYes.\n\n## Dividend history\n- 12 straight raises");
    expect(p.other).toEqual([{ heading: "Dividend history", body: "- 12 straight raises" }]);
  });

  it("keeps text written before the first heading", () => {
    const p = parseAnswer("One moment.\n\n## Answer\nYes.");
    expect(p.preamble).toBe("One moment.");
  });
});

describe("parseAnswer — while streaming", () => {
  it("fills sections in as they arrive", () => {
    const p = parseAnswer("## Answer\nNVDA is richly priced but");
    expect(p.answer).toBe("NVDA is richly priced but");
    expect(p.keyNumbers).toBeUndefined();
    expect(p.bull).toBeUndefined();
  });

  it("ignores a heading line that is still being typed", () => {
    const p = parseAnswer("## Answer\nYes.\n\n## Key num");
    expect(p.answer).toBe("Yes.");
    expect(p.keyNumbers).toBeUndefined();
  });

  it("treats a completed heading with no body yet as an empty section", () => {
    const p = parseAnswer("## Answer\nYes.\n\n## Bull case\n");
    expect(p.bull).toBe("");
  });

  it("parses a half-written key-numbers table", () => {
    const p = parseAnswer("## Key numbers\n| Metric | Value | Source | As of |\n| --- | --- | --- | --- |\n| Price | $10 | Polygon | today |\n| P/E | 2");
    expect(p.keyNumbers).toHaveLength(1);
    expect(p.keyNumbers![0].metric).toBe("Price");
  });
});

describe("parseAnswer — non-contract markdown", () => {
  it("returns raw only for a brevity answer", () => {
    const p = parseAnswer("Yes — it beat on both lines.");
    expect(p.answer).toBeUndefined();
    expect(p.preamble).toBe("Yes — it beat on both lines.");
    expect(p.raw).toBe("Yes — it beat on both lines.");
  });

  it("does not crash on empty input", () => {
    expect(parseAnswer("")).toEqual({ raw: "" });
  });
});

describe("the shared contract block", () => {
  it("names every heading so prompts and UI cannot drift", () => {
    for (const h of Object.values(ANSWER_HEADINGS)) {
      expect(ANSWER_CONTRACT_BLOCK).toContain(`## ${h}`);
    }
  });
});
