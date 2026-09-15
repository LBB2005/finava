import { describe, expect, it } from "vitest";
import { extractVerdict } from "./verdict";

describe("extractVerdict", () => {
  it("takes the first sentence of the Answer section (answer contract)", () => {
    const md = "## Answer\nNVDA looks fairly valued at today's price. Growth is priced in.\n\n## Key numbers\n| a | b |";
    expect(extractVerdict(md)).toBe("NVDA looks fairly valued at today's price.");
  });

  it("takes the first sentence of a Summary & Recommendation section", () => {
    const md = [
      "## 📊 Valuation",
      "P/E is high.",
      "## 🧭 Summary & Recommendation",
      "",
      "- **Hold**: the data suggests AAPL is fairly priced vs peers, with limited upside.",
      "- Watch margins.",
      "",
      "*This is not financial advice.*",
    ].join("\n");
    expect(extractVerdict(md)).toBe("Hold: the data suggests AAPL is fairly priced vs peers, with limited upside.");
  });

  it("accepts bold-line headings like **Verdict:**", () => {
    const md = "Intro text here.\n\n**Verdict:** The bull case outweighs the bear case for MSFT. More detail follows.";
    expect(extractVerdict(md)).toBe("The bull case outweighs the bear case for MSFT.");
  });

  it("skips disclaimer sentences", () => {
    const md = "## Bottom line\nNot financial advice. The data points to a cautious hold on TSLA.";
    expect(extractVerdict(md)).toBe("The data points to a cautious hold on TSLA.");
  });

  it("returns null when there is no verdict section or only a fragment", () => {
    expect(extractVerdict(" advice.*")).toBeNull();
    expect(extractVerdict("## Details\nSome table")).toBeNull();
    expect(extractVerdict("## Answer\n*Not financial advice.*")).toBeNull();
    expect(extractVerdict("")).toBeNull();
  });

  it("does not split on decimals or abbreviations like U.S.", () => {
    const md = "## Answer\nAt $182.50 the U.S. listing trades near fair value. Second.";
    expect(extractVerdict(md)).toBe("At $182.50 the U.S. listing trades near fair value.");
  });
});
