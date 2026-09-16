// The single DCF input path, on real (trimmed) SEC filings.
import { describe, expect, it, vi } from "vitest";

// grok → usage → firebase-admin validates env at import.
vi.mock("@/lib/sentiment/grok", () => ({ getGrokSentiment: vi.fn() }));
import aapl from "@/lib/__fixtures__/sec/aapl.json";
import jpm from "@/lib/__fixtures__/sec/jpm.json";
import { extractDcfBase, finishDcfInputs } from "@/lib/finavaInputs";
import { extractFinancialMetrics, extractCurrentSharesOutstanding } from "@/lib/edgar";
import { suggestedWaccFromBeta } from "@/lib/dcf";

describe("extractDcfBase", () => {
  it("builds FCF from operating cash flow minus capex, and flags no proxy", () => {
    const mm = extractFinancialMetrics(aapl);
    const base = extractDcfBase(aapl);
    expect(base.baseFcf).toBe((mm.operatingCashFlow as number) - (mm.capex as number));
    expect(base.fcfIsProxy).toBe(false);
  });

  it("uses the cover-page share count (split-safe), with its date", () => {
    const cur = extractCurrentSharesOutstanding(aapl)!;
    const base = extractDcfBase(aapl);
    expect(base.sharesEdgar).toBe(cur.shares);
    expect(base.sharesAsOf).toBe(cur.asOf);
  });

  it("computes net debt from debt and cash, treating a missing side as zero", () => {
    const mm = extractFinancialMetrics(aapl);
    expect(extractDcfBase(aapl).netDebt).toBe(((mm.totalDebt as number) ?? 0) - ((mm.cash as number) ?? 0));
  });

  it("returns an all-null base for no filings", () => {
    expect(extractDcfBase(null)).toEqual({
      baseFcf: null, fcfIsProxy: true, sharesEdgar: null, sharesAsOf: null, netDebt: 0,
      historicalGrowth: null, fcfConversion: null, revenueCagr3y: null,
    });
  });

  it("does not throw on a bank's filings", () => {
    expect(() => extractDcfBase(jpm)).not.toThrow();
  });
});

describe("finishDcfInputs", () => {
  const base = {
    baseFcf: 100e9, fcfIsProxy: false, sharesEdgar: 15e9, sharesAsOf: "2026-07-18", netDebt: -30e9,
    historicalGrowth: 0.06, fcfConversion: 1.02, revenueCagr3y: 0.04,
  };

  it("uses the beta-tuned WACC, never a flat default", () => {
    const i = finishDcfInputs(base, { price: 230, beta: 1.3, marketCapMillions: null, currency: "USD" });
    expect(i.suggestedWacc).toBe(suggestedWaccFromBeta(1.3));
    expect(i.sharesOutstanding).toBe(15e9);
    expect(i.currentPrice).toBe(230);
  });

  it("falls back to market cap ÷ price for shares only when filings have none", () => {
    const i = finishDcfInputs({ ...base, sharesEdgar: null }, { price: 200, beta: null, marketCapMillions: 3_000_000, currency: null });
    expect(i.sharesOutstanding).toBe(15e9);
    expect(i.currency).toBe("USD");
  });

  it("leaves shares null when neither source has them", () => {
    const i = finishDcfInputs({ ...base, sharesEdgar: null }, { price: null, beta: null, marketCapMillions: 3_000_000, currency: "USD" });
    expect(i.sharesOutstanding).toBeNull();
  });
});
