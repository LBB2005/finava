import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ASOF } from "@/test/factsFixture";
import { insiderFacts, form4Url } from "./precomputed";
import { indexFacts, collectFacts, type FactEntry } from "./promptBlock";
import { parseNumberToken, verifyCitations, createCitationStream, sourceLink } from "./citations";
import { parseKeyNumbers } from "@/lib/answerFormat";

const entry = (over: Partial<FactEntry> & Pick<FactEntry, "id" | "kind" | "value" | "text">): FactEntry => ({
  label: over.id, source: "Finnhub quote", asOf: FIXTURE_ASOF, ...over,
});

const INDEX = indexFacts([
  entry({ id: "AAPL.price", kind: "usd", value: 231.45, text: "$231.45" }),
  entry({ id: "AAPL.pe", kind: "ratio", value: 35.24, text: "35.2x", source: "Computed: price ÷ EPS (TTM)" }),
  entry({ id: "AAPL.pctFrom52wHigh", kind: "chg", value: -6.71, text: "-6.7%", source: "Computed: price ÷ 52-week high − 1" }),
  entry({ id: "AAPL.revenueTTM", kind: "usd", value: 391.04e9, text: "$391.04B", source: "SEC EDGAR (last four quarters)", url: "https://www.sec.gov/x" }),
  entry({ id: "AAPL.streetTarget", kind: "usd", value: null, text: "Unavailable", source: "Finnhub price target" }),
  entry({ id: "PORT.AAPL.weight", kind: "pct", value: 15.3, text: "15.3%" }),
  entry({ id: "AAPL.nextEarnings", kind: "text", value: null, text: "2026-10-30 (estimated)" }),
]);

describe("parseNumberToken", () => {
  it("reads currency, suffixes, commas, signs and percents", () => {
    expect(parseNumberToken("$1.0M")).toMatchObject({ value: 1e6, tolerance: 0.05e6, signed: false });
    expect(parseNumberToken("$10.3 million")).toMatchObject({ value: 10.3e6 });
    expect(parseNumberToken("$1,000,160")).toMatchObject({ value: 1_000_160, tolerance: 0.5 });
    expect(parseNumberToken("−6.7%")).toMatchObject({ value: -6.7, signed: true });
    expect(parseNumberToken("35.2x")).toMatchObject({ value: 35.2, tolerance: 0.05 });
    expect(parseNumberToken("$391B")).toMatchObject({ value: 391e9, tolerance: 0.5e9 });
  });
});

describe("verifyCitations", () => {
  it("leaves a correct cited number alone and strips the ID", () => {
    const r = verifyCitations("Apple trades at $231.45 [F:AAPL.price], a P/E of 35.2x [F:AAPL.pe].", INDEX);
    expect(r.text).toBe("Apple trades at $231.45, a P/E of 35.2x.");
    expect(r.mismatches).toEqual([]);
  });

  it("accepts a coarser rounding of the right value", () => {
    const r = verifyCitations("Revenue was $391B [F:AAPL.revenueTTM] and the P/E about 35x [F:AAPL.pe].", INDEX);
    expect(r.mismatches).toEqual([]);
    expect(r.text).toBe("Revenue was $391B and the P/E about 35x.");
  });

  it("accepts an unsigned distance written in words", () => {
    const r = verifyCitations("It sits 6.7% below its high [F:AAPL.pctFrom52wHigh].", INDEX);
    expect(r.mismatches).toEqual([]);
  });

  it("replaces a wrong cited number with the fact, and reports it", () => {
    const onMismatch = vi.fn();
    const r = verifyCitations("The P/E is 53.2x [F:AAPL.pe] and weight 51.3% [F:PORT.AAPL.weight].", INDEX, { onMismatch });
    expect(r.text).toBe("The P/E is 35.2x and weight 15.3%.");
    expect(r.mismatches).toEqual([
      { id: "AAPL.pe", written: "53.2x", replacedWith: "35.2x" },
      { id: "PORT.AAPL.weight", written: "51.3%", replacedWith: "15.3%" },
    ]);
    expect(onMismatch).toHaveBeenCalledTimes(2);
  });

  it("keeps the writer's sign style when correcting an unsigned distance", () => {
    const r = verifyCitations("It sits 16.7% below its high [F:AAPL.pctFrom52wHigh].", INDEX);
    expect(r.text).toBe("It sits 6.7% below its high.");
  });

  it("replaces a number cited to a fact we don't have with Unavailable", () => {
    const r = verifyCitations("The Street target is $250 [F:AAPL.streetTarget].", INDEX);
    expect(r.text).toBe("The Street target is Unavailable.");
    expect(r.mismatches[0]).toMatchObject({ id: "AAPL.streetTarget", replacedWith: "Unavailable" });
  });

  it("strips an ID it doesn't know and reports it, without touching the text", () => {
    const r = verifyCitations("Margin was 44% [F:AAPL.grossMargin].", INDEX);
    expect(r.text).toBe("Margin was 44%.");
    expect(r.unknownIds).toEqual(["AAPL.grossMargin"]);
  });

  it("never number-checks a text fact", () => {
    const r = verifyCitations("Earnings are due 2026-10-30 [F:AAPL.nextEarnings].", INDEX);
    expect(r.text).toBe("Earnings are due 2026-10-30.");
    expect(r.mismatches).toEqual([]);
  });

  it("strips back-to-back citations", () => {
    expect(verifyCitations("$231.45 [F:AAPL.price][F:AAPL.pe] ok", INDEX).text).toBe("$231.45 ok");
  });

  it("fills a Key numbers row's Source and As of from the fact, linking the source", () => {
    const md = [
      "| Metric | Value | Source | As of |",
      "| --- | --- | --- | --- |",
      "| Revenue (TTM) | $391.04B [F:AAPL.revenueTTM] | Finnhub | today |",
      "| Price | $231.45 [F:AAPL.price] | | |",
    ].join("\n");
    const out = verifyCitations(md, INDEX).text;
    const rows = parseKeyNumbers(out);
    expect(rows[0]).toMatchObject({ metric: "Revenue (TTM)", value: "$391.04B", source: "[SEC EDGAR (last four quarters)](https://www.sec.gov/x)", asOf: "2026-09-15" });
    expect(rows[1]).toMatchObject({ value: "$231.45", source: "Finnhub quote", asOf: "2026-09-15" });
  });

  it("marks a table row Unavailable when its fact is missing", () => {
    const out = verifyCitations("| Street target | $250 [F:AAPL.streetTarget] | web | 2025 |", INDEX).text;
    expect(parseKeyNumbers(out)[0]).toMatchObject({ value: "Unavailable", unavailable: true, source: "Finnhub price target" });
  });
});

// Seen live on NVDA: "9.6% below its 52-week high [F:…]" was "corrected" to
// "9.6% below its 9.6%-week high". The cited number is the one whose form fits
// the fact, never a label like "52-week".
describe("choosing which number a citation is about", () => {
  it("ignores numbers that are part of a label", () => {
    const r = verifyCitations("It trades 6.7% below its 52-week high [F:AAPL.pctFrom52wHigh].", INDEX);
    expect(r.text).toBe("It trades 6.7% below its 52-week high.");
    expect(r.mismatches).toEqual([]);
  });

  it("still corrects the percent when it's wrong", () => {
    expect(verifyCitations("It trades 16.7% below its 52-week high [F:AAPL.pctFrom52wHigh].", INDEX).text)
      .toBe("It trades 6.7% below its 52-week high.");
  });

  it("matches a dollar fact to a dollar figure, not a year after it", () => {
    const r = verifyCitations("Price was $231.45 in 2026 [F:AAPL.price].", INDEX);
    expect(r.mismatches).toEqual([]);
    expect(r.text).toBe("Price was $231.45 in 2026.");
  });

  it("matches a multiple to its x, not a plain number after it", () => {
    expect(verifyCitations("A P/E of 35.2x over 12 months [F:AAPL.pe].", INDEX).mismatches).toEqual([]);
  });

  // Seen live on a PFE crew report: "62 / 100 (C+)" became "62 / 62 (C+)".
  it("never reads a denominator as the cited number", () => {
    const idx = indexFacts([entry({ id: "PFE.score", kind: "count", value: 62, text: "62" })]);
    for (const written of ["62 / 100 (C+)", "62/100", "62 out of 100"]) {
      const r = verifyCitations(`Score ${written} [F:PFE.score].`, idx);
      expect(r.text).toBe(`Score ${written}.`);
      expect(r.mismatches).toEqual([]);
    }
    expect(verifyCitations("Score 71 / 100 [F:PFE.score].", idx).text).toBe("Score 62 / 100.");
  });

  it("leaves the text alone when no number of the right form is near", () => {
    const r = verifyCitations("Up over 3 quarters [F:AAPL.pctFrom52wHigh].", INDEX);
    expect(r.text).toBe("Up over 3 quarters.");
    expect(r.mismatches).toEqual([]);
  });
});

// Seen live: models don't always write the ID the way they were told to.
describe("malformed citations never reach the reader", () => {
  it("reads [F:ID = value] as the value followed by its citation", () => {
    const r = verifyCitations("a high P/E [F:AAPL.pe = 53.2x], still", INDEX);
    expect(r.text).toBe("a high P/E 35.2x, still");
    expect(r.mismatches).toHaveLength(1);
  });

  it("splits several IDs in one bracket", () => {
    expect(verifyCitations("$231.45 [F:AAPL.price, F:AAPL.pe] and", INDEX).text).toBe("$231.45 and");
    expect(verifyCitations("$231.45 [F:AAPL.price; AAPL.pe] and", INDEX).text).toBe("$231.45 and");
  });

  it("drops any other [F:…] fragment rather than showing it", () => {
    expect(verifyCitations("price (see [F: the block]) ok", INDEX).text).toBe("price (see) ok");
    expect(verifyCitations("tail [F:AAPL.price", INDEX).text).toBe("tail");
  });
});

describe("the Pfizer arithmetic case", () => {
  // Seeded from the readout: the CEO's buy was 38,000 × $26.32 ≈ $1.0M; the answer said $10.3M.
  const ins = insiderFacts("PFE", { data: [{ name: "Bourla Albert", change: 38_000, transactionPrice: 26.32, transactionDate: "2026-08-04", transactionCode: "P" }] }, FIXTURE_ASOF);
  const index = indexFacts(collectFacts({ insider: [ins] }));

  it("renders the buy as $1.0M when the model got it right", () => {
    expect(verifyCitations("CEO Albert Bourla bought $1.0M [F:PFE.insider.largestBuy] of stock.", index).text)
      .toBe("CEO Albert Bourla bought $1.0M of stock.");
  });

  it("replaces the model's $10.3M with the fact's $1.0M", () => {
    const r = verifyCitations("CEO Albert Bourla bought $10.3M [F:PFE.insider.largestBuy] of stock.", index);
    expect(r.text).toBe("CEO Albert Bourla bought $1.0M of stock.");
    expect(r.mismatches).toEqual([{ id: "PFE.insider.largestBuy", written: "$10.3M", replacedWith: "$1.0M" }]);
  });

  it("links the Key numbers row to the Form 4 index", () => {
    const out = verifyCitations("| Largest insider buy | $10.3M [F:PFE.insider.largestBuy] | SEC | |", index).text;
    expect(parseKeyNumbers(out)[0]).toMatchObject({ value: "$1.0M", source: `[Finnhub insider transactions (SEC Form 4)](${form4Url("PFE")})` });
  });
});

// Seen live on PFE: the model wrote the right number next to the wrong ID. A
// "correction" there would have turned a true $134,661 into a false $3.0M.
describe("a right number cited to the wrong fact", () => {
  const ins = insiderFacts("PFE", {
    data: [
      { name: "Bourla Albert", change: 38_000, transactionPrice: 26.34, transactionDate: "2026-08-12", transactionCode: "P" },
      { name: "Buyer Two", change: 10_000, transactionPrice: 26.3, transactionDate: "2026-03-01", transactionCode: "P" },
      { name: "Seller", change: -5_000, transactionPrice: 26.9322, transactionDate: "2026-05-01", transactionCode: "S" },
    ],
  }, FIXTURE_ASOF);
  const index = indexFacts(collectFacts({ insider: [ins] }));

  it("keeps the number and credits the fact it actually matches", () => {
    const r = verifyCitations("Two sales totaling $134,661 [F:PFE.insider.buyTotal].", index);
    expect(r.text).toBe("Two sales totaling $134,661.");
    expect(r.mismatches).toEqual([]);
    expect(r.reattributed).toEqual([{ from: "PFE.insider.buyTotal", to: "PFE.insider.sellTotal", written: "$134,661" }]);
  });

  it("recognises the share price of the largest buy as its own fact", () => {
    const r = verifyCitations("Bourla bought 38,000 shares at $26.34 [F:PFE.insider.largestBuy].", index);
    expect(r.text).toBe("Bourla bought 38,000 shares at $26.34.");
    expect(r.reattributed[0]).toMatchObject({ to: "PFE.insider.largestBuyPrice" });
  });

  it("still replaces a number that matches no fact at all", () => {
    expect(verifyCitations("Bourla bought $10.3M [F:PFE.insider.largestBuy].", index).text).toBe("Bourla bought $1.0M.");
  });

  it("sources the table row from the fact the number matched", () => {
    const out = verifyCitations("| Insider sales | $134,661 [F:PFE.insider.buyTotal] | | |", index).text;
    expect(parseKeyNumbers(out)[0]).toMatchObject({ value: "$134,661" });
  });
});

describe("createCitationStream", () => {
  it("emits whole, checked lines as the deltas arrive, and the tail on flush", () => {
    const out: string[] = [];
    const s = createCitationStream(INDEX, (t) => out.push(t));
    s.push("## Answer\nThe P/E is 5");
    expect(out).toEqual(["## Answer\n"]);
    s.push("3.2x [F:AAPL");
    s.push(".pe] today.\nPrice $231.45 [F:AAPL.price]");
    expect(out.join("")).toBe("## Answer\nThe P/E is 35.2x today.\n");
    s.flush();
    expect(out.join("")).toBe("## Answer\nThe P/E is 35.2x today.\nPrice $231.45");
    expect(s.text()).toBe(out.join(""));
    expect(s.mismatches()).toHaveLength(1);
  });

  it("does not sit on a very long line forever", () => {
    const out: string[] = [];
    const s = createCitationStream(INDEX, (t) => out.push(t), { maxBufferChars: 50 });
    s.push("x".repeat(60));
    expect(out.join("")).toBe("x".repeat(60));
  });

  it("counts what it checked, for the eval's mismatch rate", () => {
    const s = createCitationStream(INDEX, () => {});
    s.push("P/E 53.2x [F:AAPL.pe], price $231.45 [F:AAPL.price].\n");
    s.push("Earnings 2026-10-30 [F:AAPL.nextEarnings], margin 44% [F:AAPL.grossMargin].\n");
    s.flush();
    // Two numeric citations compared, one of them wrong. A text fact and an
    // unknown ID are not comparisons, so neither counts.
    expect(s.counts()).toEqual({ checked: 2, mismatched: 1 });
  });

  it("counts a re-attributed number as checked, not mismatched", () => {
    const s = createCitationStream(INDEX, () => {});
    // The revenue figure, cited to the price fact: kept, and credited to revenue.
    s.push("Revenue was $391.04B [F:AAPL.price].\n");
    s.flush();
    expect(s.counts()).toEqual({ checked: 1, mismatched: 0 });
  });

  it("starts over on a whole-answer replacement", () => {
    const out: string[] = [];
    const s = createCitationStream(INDEX, (t) => out.push(t));
    s.push("partial line");
    expect(s.replace("P/E 53.2x [F:AAPL.pe]\n")).toBe("P/E 35.2x\n");
    s.flush();
    expect(out).toEqual([]);
    expect(s.text()).toBe("P/E 35.2x\n");
  });
});

describe("sourceLink", () => {
  it("reads the markdown link a checked row carries", () => {
    expect(sourceLink("[SEC EDGAR balance sheet](https://www.sec.gov/x?a=1&b=2)")).toEqual({ label: "SEC EDGAR balance sheet", href: "https://www.sec.gov/x?a=1&b=2" });
  });

  it("is plain text without a link, or with a link that isn't http(s)", () => {
    expect(sourceLink("Finnhub quote")).toEqual({ label: "Finnhub quote" });
    expect(sourceLink("[x](javascript:alert(1))")).toEqual({ label: "x" });
  });
});
