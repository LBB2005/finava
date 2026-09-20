import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadAlpaca() {
  vi.resetModules();
  return import("./alpaca");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  delete process.env.ALPACA_API_KEY;
  delete process.env.ALPACA_API_SECRET;
  delete process.env.ALPACA_DATA_FEED;
  delete process.env.ALPACA_BASE_URL;
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Alpaca host and config guards", () => {
  it("detects paper trading hosts and data credential availability", async () => {
    let mod = await loadAlpaca();
    expect(mod.ALPACA_TRADING_BASE).toBe("https://paper-api.alpaca.markets");
    expect(mod.isPaperTradingHost()).toBe(true);
    expect(mod.isPaperTradingHost("https://api.alpaca.markets")).toBe(false);
    // Regression: the check was a substring match, so a LIVE host with the paper
    // hostname anywhere in the URL passed as "paper".
    expect(mod.isPaperTradingHost("https://api.alpaca.markets/?paper-api.alpaca.markets")).toBe(false);
    expect(mod.isPaperTradingHost("https://paper-api.alpaca.markets.evil.example")).toBe(false);
    expect(mod.isPaperTradingHost("https://paper-api.alpaca.markets/v2")).toBe(true);
    expect(mod.isPaperTradingHost("not a url")).toBe(false);
    expect(mod.hasAlpacaData()).toBe(false);

    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    process.env.ALPACA_BASE_URL = "https://api.alpaca.markets";
    mod = await loadAlpaca();
    expect(mod.ALPACA_TRADING_BASE).toBe("https://api.alpaca.markets");
    expect(mod.hasAlpacaData()).toBe(true);
  });
});

describe("getAlpacaBars", () => {
  it("returns no_data when credentials are absent", async () => {
    const { getAlpacaBars } = await loadAlpaca();

    await expect(getAlpacaBars("AAPL", "D", 1, 2)).resolves.toEqual({
      s: "no_data",
      c: [],
      o: [],
      h: [],
      l: [],
      v: [],
      t: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("paginates bars and reshapes them into Finnhub candle format", async () => {
    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    process.env.ALPACA_DATA_FEED = "sip";
    const { getAlpacaBars } = await loadAlpaca();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          bars: [{ t: "2026-06-15T10:00:00.000Z", o: 1, h: 3, l: 0.5, c: 2, v: 100 }],
          next_page_token: "next",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          bars: [{ t: "2026-06-15T10:05:00.000Z", o: 2, h: 4, l: 1.5, c: 3, v: 150 }],
        })
      );

    await expect(getAlpacaBars("AAPL", "5", 1_800_000_000, 1_800_000_600)).resolves.toEqual({
      s: "ok",
      c: [2, 3],
      o: [1, 2],
      h: [3, 4],
      l: [0.5, 1.5],
      v: [100, 150],
      t: [1781517600, 1781517900],
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/v2/stocks/AAPL/bars?"),
      expect.objectContaining({
        headers: {
          "APCA-API-KEY-ID": "key",
          "APCA-API-SECRET-KEY": "secret",
        },
        next: { revalidate: 30 },
      })
    );
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("timeframe=5Min");
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("feed=sip");
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain("page_token=next");
  });

  it("returns no_data for an empty bar set and throws on provider errors", async () => {
    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    const { getAlpacaBars } = await loadAlpaca();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ bars: [] }));

    await expect(getAlpacaBars("AAPL", "D", 1, 2)).resolves.toMatchObject({ s: "no_data" });

    vi.mocked(fetch).mockResolvedValueOnce(new Response("bad", { status: 500 }));
    await expect(getAlpacaBars("AAPL", "D", 1, 2)).rejects.toThrow("Alpaca bars 500: AAPL");
  });
});

describe("Alpaca multi-symbol endpoints", () => {
  it("normalizes latest snapshots with price fallbacks and change percent", async () => {
    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    const { getAlpacaSnapshots } = await loadAlpaca();
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        AAPL: {
          latestTrade: { p: 210 },
          dailyBar: { c: 209, v: 1234 },
          prevDailyBar: { c: 200 },
        },
        MSFT: {
          dailyBar: { c: 0, v: 999 },
          prevDailyBar: { c: 0 },
        },
      })
    );

    const out = await getAlpacaSnapshots(["AAPL", "MSFT"]);

    expect(out.get("AAPL")).toEqual({
      price: 210,
      prevClose: 200,
      changePct: 5,
      dayVolume: 1234,
      // No dailyBar.o in this fixture: null, never a stand-in price. The
      // executor measures slippage against this, so a fabricated open would
      // read as "executed perfectly".
      open: null,
    });
    expect(out.get("MSFT")).toEqual({
      price: null,
      prevClose: 0,
      changePct: null,
      dayVolume: 999,
      open: null,
    });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("symbols=AAPL%2CMSFT");
  });

  it("returns empty maps when multi-symbol inputs or credentials are absent", async () => {
    const { getAlpacaSnapshots, getAlpacaAvgVolumes, getAlpacaCloseHistory } = await loadAlpaca();

    await expect(getAlpacaSnapshots(["AAPL"])).resolves.toEqual(new Map());
    await expect(getAlpacaAvgVolumes(["AAPL"])).resolves.toEqual(new Map());
    await expect(getAlpacaCloseHistory(["AAPL"])).resolves.toEqual(new Map());

    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    const mod = await loadAlpaca();
    await expect(mod.getAlpacaSnapshots([])).resolves.toEqual(new Map());
    await expect(mod.getAlpacaAvgVolumes([])).resolves.toEqual(new Map());
    await expect(mod.getAlpacaCloseHistory([])).resolves.toEqual(new Map());
  });

  it("averages prior sessions for relative-volume baselines", async () => {
    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    const { getAlpacaAvgVolumes } = await loadAlpaca();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          bars: {
            AAPL: [{ v: 100 }, { v: 200 }],
            MSFT: [{ v: 10 }],
          },
          next_page_token: "p2",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          bars: {
            AAPL: [{ v: 300 }, { v: 999 }],
            MSFT: [{ v: 20 }, { v: 30 }],
          },
        })
      );

    const out = await getAlpacaAvgVolumes(["AAPL", "MSFT"], 2);

    expect(out.get("AAPL")).toBe(250);
    expect(out.get("MSFT")).toBe(15);
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain("page_token=p2");
  });

  it("sorts adjusted close history across pages", async () => {
    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    const { getAlpacaCloseHistory } = await loadAlpaca();
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          bars: {
            AAPL: [{ t: "2026-06-16T00:00:00.000Z", c: 202 }],
          },
          next_page_token: "p2",
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          bars: {
            AAPL: [{ t: "2026-06-15T00:00:00.000Z", c: 200 }],
          },
        })
      );

    await expect(getAlpacaCloseHistory(["AAPL"], 30)).resolves.toEqual(
      new Map([["AAPL", [
        { t: 1781481600, c: 200 },
        { t: 1781568000, c: 202 },
      ]]])
    );
  });
});
