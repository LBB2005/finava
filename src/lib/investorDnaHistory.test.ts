import { describe, expect, it, vi } from "vitest";
import { resolvePositionHistory, SECTOR_ETF } from "./investorDnaHistory";
import type { FactorScores, Stock } from "./research";
import { SP500_SECTORS } from "./sp500";

const F: FactorScores = { mom: 50, growth: 50, quality: 50, analyst: 50, value: 50, health: 50 };
const stock = (ticker: string, sector: string): Stock =>
  ({ ticker, name: ticker, sector, price: 999, chg: 0, f: F, mv: { week: 0, month: 0, year: 0 } });

const day = (iso: string) => Date.parse(iso) / 1000;
/** Daily series: [isoDate, close][] */
const series = (rows: [string, number][]) => ({ t: rows.map(([d]) => day(d)), c: rows.map(([, c]) => c) });

const NOW = new Date("2026-09-16T20:00:00Z");

describe("resolvePositionHistory", () => {
  const closes = vi.fn(async (ticker: string) => {
    const table: Record<string, [string, number][]> = {
      AAPL: [["2026-03-02", 100], ["2026-03-03", 110], ["2026-09-15", 150]],
      SPY: [["2026-03-02", 500], ["2026-03-03", 505], ["2026-09-15", 550]],
      XLK: [["2026-03-02", 200], ["2026-03-03", 202], ["2026-09-15", 230]],
      JPM: [],
    };
    return series(table[ticker] ?? []);
  });

  it("uses the real purchase date and avg cost when acquiredAt exists, benchmarked on the same window", async () => {
    const out = await resolvePositionHistory(
      [{ ticker: "AAPL", shares: 1, avgCost: 120, acquiredAt: "2026-03-02T15:00:00Z", createdAt: "2026-09-01T00:00:00Z" }],
      [stock("AAPL", "Information Technology")],
      { dailyCloses: closes, now: NOW },
    );
    expect(out.AAPL).toEqual({
      windowStart: "2026-03-02T15:00:00Z",
      basis: "purchase",
      returnPct: 25, // 120 → 150
      spyReturnPct: 10, // 500 → 550
      sectorEtf: "XLK",
      sectorReturnPct: 15, // 200 → 230
      entryFactors: null, // no point-in-time factor store exists
    });
  });

  it("falls back to the date added to Finava and prices the stock from that day, not avg cost", async () => {
    const out = await resolvePositionHistory(
      [{ ticker: "AAPL", shares: 1, avgCost: 1, createdAt: "2026-03-03T18:00:00Z" }],
      [stock("AAPL", "Information Technology")],
      { dailyCloses: closes, now: NOW },
    );
    expect(out.AAPL.basis).toBe("added");
    expect(out.AAPL.returnPct).toBeCloseTo(36.36, 1); // 110 → 150
    expect(out.AAPL.spyReturnPct).toBeCloseTo(8.91, 1); // 505 → 550
  });

  it("leaves returns null rather than inventing them when price history is missing", async () => {
    const out = await resolvePositionHistory(
      [{ ticker: "JPM", shares: 1, avgCost: 100, createdAt: "2026-03-03T18:00:00Z" }],
      [stock("JPM", "Financials")],
      { dailyCloses: closes, now: NOW },
    );
    expect(out.JPM.returnPct).toBeNull();
    expect(out.JPM.sectorEtf).toBe("XLF");
    expect(out.JPM.sectorReturnPct).toBeNull();
    expect(out.JPM.spyReturnPct).toBeCloseTo(8.91, 1);
  });

  it("skips holdings with no usable date, ETFs and tickers outside the universe", async () => {
    const out = await resolvePositionHistory(
      [
        { ticker: "AAPL", shares: 1, avgCost: 100 },
        { ticker: "VOO", shares: 1, avgCost: 100, createdAt: "2026-03-03T00:00:00Z" },
      ],
      [stock("AAPL", "Information Technology")],
      { dailyCloses: closes, now: NOW },
    );
    expect(out).toEqual({});
  });

  it("fetches each symbol once and survives a failing fetch", async () => {
    const flaky = vi.fn(async (ticker: string) => {
      if (ticker === "XLK") throw new Error("boom");
      return closes(ticker);
    });
    const out = await resolvePositionHistory(
      [
        { ticker: "AAPL", shares: 1, avgCost: 120, acquiredAt: "2026-03-02T15:00:00Z" },
        { ticker: "BRK.B", shares: 1, avgCost: 120, acquiredAt: "2026-03-02T15:00:00Z" },
      ],
      [stock("AAPL", "Information Technology"), stock("BRK.B", "Information Technology")],
      { dailyCloses: flaky, now: NOW },
    );
    expect(out.AAPL.sectorReturnPct).toBeNull();
    expect(flaky.mock.calls.filter(([t]) => t === "SPY")).toHaveLength(1);
    expect(flaky.mock.calls.filter(([t]) => t === "XLK")).toHaveLength(1);
  });

  it("maps every GICS sector to a SPDR sector ETF", () => {
    expect(Object.keys(SECTOR_ETF)).toHaveLength(11);
    for (const sector of SP500_SECTORS) expect(SECTOR_ETF[sector], sector).toBeTruthy();
  });
});
