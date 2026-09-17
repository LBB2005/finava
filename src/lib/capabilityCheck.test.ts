import { describe, expect, it } from "vitest";
import {
  requiredData,
  checkCapabilities,
  capabilityPromptBlock,
  cantAnswerResponse,
  isFundQuestion,
  fundDiscoverResponse,
  FUND_ANSWER_RULE,
  DEFAULT_AVAILABILITY,
  wantsInsider,
  wantsPortfolio,
} from "./capabilityCheck";

describe("requiredData: question → the data it needs", () => {
  it.each([
    ["what's the implied volatility on NVDA?", ["options"]],
    ["is the put/call ratio on TSLA bearish", ["options"]],
    ["show me the options chain for AAPL calls expiring friday", ["options"]],
    ["what is the duration of TLT and how rate sensitive is it", ["bondDuration"]],
    ["what are the top holdings of QQQ", ["fundHoldings"]],
    ["how much NVDA is inside VOO", ["fundHoldings"]],
    ["what's the expense ratio on QQQ", ["fundFees"]],
    ["what's the analyst price target for AMD", ["priceTargets"]],
    ["is AMD a buy right now?", []],
    ["full analysis of NVDA", []],
    ["what does a DCF do", []],
  ])("%s", (q, needs) => {
    expect(requiredData(q)).toEqual(needs);
  });
});

describe("checkCapabilities", () => {
  it("flags a question whose core data we can't get", () => {
    const r = checkCapabilities("what's the implied volatility on NVDA?");
    expect(r.coreMissing).toBe(true);
    expect(r.missing.map((m) => m.key)).toEqual(["options"]);
    expect(r.missing[0].label).toMatch(/options/i);
  });

  it("does not stop a broad analysis that merely mentions the gap", () => {
    const r = checkCapabilities("full analysis of NVDA including options flow");
    expect(r.missing.map((m) => m.key)).toEqual(["options"]);
    expect(r.coreMissing).toBe(false);
  });

  it("treats price targets as available when this ticker has one", () => {
    expect(checkCapabilities("AMD price target?", { ...DEFAULT_AVAILABILITY, priceTargets: true }).missing).toEqual([]);
    expect(checkCapabilities("AMD price target?").coreMissing).toBe(true);
  });

  it("finds nothing missing for an ordinary question", () => {
    expect(checkCapabilities("is AMD a buy right now?")).toMatchObject({ missing: [], coreMissing: false });
  });

  it("has no options, bond or fund-holdings data by default", () => {
    expect(DEFAULT_AVAILABILITY).toMatchObject({ options: false, bondDuration: false, fundHoldings: false, fundFees: false });
  });
});

describe("what the reader is told", () => {
  it("opens the fast answer with what we can't get, then what we can", () => {
    const block = capabilityPromptBlock(checkCapabilities("implied volatility on NVDA?"), "NVDA");
    expect(block).toMatch(/I can't get options/i);
    expect(block).toMatch(/NVDA/);
    expect(block).toMatch(/here's what I can tell you/i);
  });

  it("is empty when nothing is missing", () => {
    expect(capabilityPromptBlock(checkCapabilities("is AMD a buy?"), "AMD")).toBe("");
  });

  it("answers a crew request fast instead of running four minutes toward 'go check your broker'", () => {
    const r = cantAnswerResponse(checkCapabilities("what's the implied volatility on NVDA?"), "NVDA");
    expect(r.markdown).toMatch(/^## Answer\n/);
    expect(r.markdown).toMatch(/I can't get options/i);
    expect(r.markdown).toMatch(/## Confidence & gaps/);
    expect(r.followups.length).toBeGreaterThan(0);
    // The offer must not re-trigger the same check.
    for (const f of r.followups) expect(checkCapabilities(f).coreMissing).toBe(false);
  });
});

// Priya (beta tester #3): "which etf should i even look at", clarified with
// "Just tell me what's best for $100/month", got CVNA/HST/IBKR/CPRT from the stock scout.
const PRIYA_ORIGINAL =
  "ok that actually makes sense lol thank you. so if i only have like $100 to put in a month which etf should i even look at, is there like one thats good for beginners? and do i need way more money than that to actually start";
const PRIYA_COMBINED = `${PRIYA_ORIGINAL}\n\n[User clarification]: Just tell me what's best for $100/month`;

describe("isFundQuestion", () => {
  it.each([
    PRIYA_ORIGINAL,
    PRIYA_COMBINED,
    "best index funds for a Roth IRA",
    "compare VOO and VTI",
    "which ETFs track the S&P 500",
    "is a mutual fund better than an etf",
    "good dividend ETFs",
  ])("recognises %s", (q) => {
    expect(isFundQuestion(q)).toBe(true);
  });

  it.each([
    "find me undervalued energy stocks",
    "what should I buy with $5,000",
    "is NVDA a buy",
    "stocks that pay dividends",
    "Just tell me what's best for $100/month",
  ])("leaves %s to the stock scout", (q) => {
    expect(isFundQuestion(q)).toBe(false);
  });

  it("reads earlier user turns when the last one is only a clarification", () => {
    expect(isFundQuestion("Just tell me what's best for $100/month", [PRIYA_ORIGINAL])).toBe(true);
  });
});

describe("fund answers never become stock picks", () => {
  it("Discover says it screens individual stocks, and names no tickers", () => {
    const md = fundDiscoverResponse();
    expect(md).toMatch(/Discover screens individual stocks/);
    expect(md).toMatch(/expense ratio/i);
    expect(md).not.toMatch(/\b[A-Z]{2,5}\b(?<!ETF|ETFs|IRA)/);
  });

  it("the fast lane is told not to answer with individual stocks or fees from memory", () => {
    expect(FUND_ANSWER_RULE).toMatch(/Discover screens individual stocks/);
    expect(FUND_ANSWER_RULE).toMatch(/never .*individual stocks/i);
    expect(FUND_ANSWER_RULE).toMatch(/Unavailable/);
  });
});

describe("which extra facts a question needs", () => {
  it.each([
    ["did Pfizer's CEO buy shares recently", true],
    ["any insider buying at PFE?", true],
    ["show me Form 4 filings for NVDA", true],
    ["are executives selling AMD", true],
    ["is AMD a buy", false],
  ])("insider: %s", (q, expected) => {
    expect(wantsInsider(q)).toBe(expected);
  });

  it.each([
    ["how exposed is my portfolio to a tech selloff", true],
    ["what's my downside on GOOGL if it drops 20%", true],
    ["how much of my holdings is NVDA", true],
    ["should I trim my position in AAPL", true],
    ["is AMD a buy", false],
  ])("portfolio: %s", (q, expected) => {
    expect(wantsPortfolio(q)).toBe(expected);
  });
});
