import { describe, it, expect } from "vitest";
import { LiveMarkets } from "./liveMarkets";
import type { TournamentRow } from "./types";

const dates = ["2026-09-17", "2026-09-18", "2026-09-21"];
const sessions = dates.map((date) => ({
  date,
  open: `${date}T13:30:00.000Z`,
  close: `${date}T20:00:00.000Z`,
}));
const row = {
  prediction: {
    ticker: "AAA",
    benchmark: "SPY",
    targetDate: dates[2],
    evaluationWindow: {
      entryAt: sessions[0].open,
      targetAt: sessions[2].close,
    },
  },
} as TournamentRow;
const dividend = {
  id: "div",
  symbol: "AAA",
  ex_date: dates[1],
  process_date: "2026-10-30",
  rate: 1,
  special: false,
  foreign: false,
};
function setup(
  options: {
    actions?: Record<string, unknown[]>;
    trades?: unknown[];
    exchange?: string;
    secondActions?: Record<string, unknown[]>;
    failActions?: boolean;
  } = {},
) {
  const urls: string[] = [];
  const get = async (address: string): Promise<unknown> => {
    urls.push(address);
    const url = new URL(address),
      ticker = url.pathname.split("/")[3];
    if (url.pathname.includes("/assets/"))
      return {
        symbol: ticker,
        exchange: options.exchange ?? "NASDAQ",
        class: "us_equity",
      };
    if (url.pathname.endsWith("/trades"))
      return {
        symbol: ticker,
        trades: options.trades ?? [
          { t: url.searchParams.get("start"), x: "Q", p: 100, c: ["Q"], i: 1 },
        ],
        next_page_token: null,
      };
    if (url.pathname.endsWith("/bars"))
      return {
        symbol: ticker,
        bars: dates
          .filter(
            (d) =>
              d >= url.searchParams.get("start")!.slice(0, 10) &&
              d <= url.searchParams.get("end")!.slice(0, 10),
          )
          .map((d) => ({
            t: `${d}T04:00:00Z`,
            o: 999,
            c: d === dates[2] ? 30 : 100,
          })),
        next_page_token: null,
      };
    if (url.pathname.endsWith("/corporate-actions")) {
      if (options.failActions) throw new Error("Alpaca 429; no retries");
      if (url.searchParams.get("symbols") === "SPY")
        return { corporate_actions: {}, next_page_token: null };
      if (url.searchParams.has("page_token"))
        return {
          corporate_actions: options.secondActions ?? {},
          next_page_token: null,
        };
      return {
        corporate_actions: options.actions ?? {},
        next_page_token: options.secondActions ? "next" : null,
      };
    }
    throw new Error(`Unexpected URL ${url.pathname}`);
  };
  return {
    markets: new LiveMarkets({
      get,
      calendar: {
        range: async (start, end) =>
          sessions.filter((s) => s.date >= start && s.date <= end),
      },
    }),
    urls,
  };
}

describe("live market outcome collection", () => {
  it("uses the primary Q auction, never the daily bar open, and caches repeated arm lookups", async () => {
    const { markets, urls } = setup();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => markets.returns(row)),
    );
    expect(results[0].subject.startPrice).toBe(100);
    expect(results[0].subject.corporateActionAdjusted).toBe(true);
    expect(urls.filter((u) => u.includes("/AAA/trades"))).toHaveLength(1);
    expect(urls.some((u) => u.includes("feed=sip"))).toBe(true);
  });
  it("keeps absent, wrong-market and ambiguous auctions unknown", async () => {
    for (const trades of [
      [],
      [{ t: sessions[0].open, x: "P", p: 80, c: ["Q"] }],
      [{ t: sessions[0].open, x: "Q", p: 80, c: ["O"] }],
      [
        { t: sessions[0].open, x: "Q", p: 80, c: ["Q"], i: 1 },
        { t: sessions[0].open, x: "Q", p: 90, c: ["Q"], i: 2 },
      ],
    ]) {
      const { markets } = setup({ trades });
      expect((await markets.mark("AAA", dates[0])).open).toBeNull();
    }
  });
  it("retrieves dividends processed after the holding window, paginates and filters on ex date", async () => {
    const { markets, urls } = setup({
      actions: {
        cash_dividends: [{ ...dividend, id: "outside", ex_date: "2026-09-22" }],
      },
      secondActions: { cash_dividends: [dividend] },
    });
    const result = await markets.returns(row);
    expect(result.subject.distributions).toEqual([
      { exDate: dates[1], amountPerShare: 1, kind: "cash_dividend" },
    ]);
    const request = new URL(urls.find((u) => u.includes("corporate-actions"))!);
    expect(request.searchParams.get("end")! >= "2026-10-30").toBe(true);
    expect(request.searchParams.get("data_quality")).toBe("all");
    expect(urls.some((u) => u.includes("page_token=next"))).toBe(true);
  });
  it("tracks forward and reverse splits and distribution amounts per entry share", async () => {
    const { markets } = setup({
      actions: {
        forward_splits: [
          {
            id: "s1",
            symbol: "AAA",
            ex_date: dates[1],
            new_rate: 4,
            old_rate: 1,
          },
        ],
        reverse_splits: [
          {
            id: "s2",
            symbol: "AAA",
            ex_date: dates[2],
            new_rate: 1,
            old_rate: 2,
          },
        ],
        cash_dividends: [{ ...dividend, ex_date: dates[2] }],
      },
    });
    // Split and dividend on the same ex date have ambiguous provider share basis.
    expect((await markets.returns(row)).subject.corporateActionAdjusted).toBe(
      false,
    );
    const onlySplits = setup({
      actions: {
        forward_splits: [
          {
            id: "s1",
            symbol: "AAA",
            ex_date: dates[1],
            new_rate: 4,
            old_rate: 1,
          },
        ],
        reverse_splits: [
          {
            id: "s2",
            symbol: "AAA",
            ex_date: dates[2],
            new_rate: 1,
            old_rate: 2,
          },
        ],
      },
    });
    expect((await onlySplits.markets.mark("AAA", dates[1])).splitFactor).toBe(
      4,
    );
    expect((await onlySplits.markets.mark("AAA", dates[2])).splitFactor).toBe(
      0.5,
    );
    expect(
      (await onlySplits.markets.mark("AAA", dates[2])).cashPerPreviousShare,
    ).toBe(0);
    expect(
      (await onlySplits.markets.mark("AAA", dates[2])).actionsComplete,
    ).toBe(true);
    expect((await onlySplits.markets.mark("AAA", dates[2])).reason).toBeNull();
    expect((await onlySplits.markets.returns(row)).subject.endPrice).toBe(60);
    const paid = setup({
      actions: {
        forward_splits: [
          {
            id: "s1",
            symbol: "AAA",
            ex_date: dates[1],
            new_rate: 4,
            old_rate: 1,
          },
        ],
        cash_dividends: [{ ...dividend, ex_date: dates[2] }],
      },
    });
    expect(
      (await paid.markets.mark("AAA", dates[2])).cashPerPreviousShare,
    ).toBe(1);
    expect(
      (await paid.markets.returns(row)).subject.distributions[0].amountPerShare,
    ).toBe(4);
  });
  it("does not award an entry-day distribution or apply an entry-day split again", async () => {
    const { markets } = setup({
      actions: {
        cash_dividends: [{ ...dividend, ex_date: dates[0] }],
        forward_splits: [
          {
            id: "split",
            symbol: "AAA",
            ex_date: dates[0],
            new_rate: 4,
            old_rate: 1,
          },
        ],
      },
    });
    const result = await markets.returns(row);
    expect(result.subject.distributions).toEqual([]);
    expect(result.subject.endPrice).toBe(30);
    expect(result.subject.corporateActionAdjusted).toBe(true);
  });
  it("retains incomplete and unsupported corporate actions as unknown instead of zero", async () => {
    const cases: Record<string, unknown[]>[] = [
      { cash_dividends: [{ ...dividend, ex_date: null }] },
      { cash_dividends: [{ ...dividend, rate: null }] },
      { spin_offs: [{ id: "spin", source_symbol: "AAA", ex_date: dates[1] }] },
      {
        cash_mergers: [
          {
            id: "merger",
            acquiree_symbol: "AAA",
            effective_date: dates[1],
            rate: null,
          },
        ],
      },
      { new_provider_type: [{ symbol: "AAA", ex_date: dates[1] }] },
    ];
    for (const actions of cases) {
      const { markets } = setup({ actions });
      const mark = await markets.mark("AAA", dates[1]);
      expect(mark.actionsComplete).toBe(false);
      expect(mark.cashPerPreviousShare).toBeNull();
      expect(mark.reason).toBeTruthy();
      expect((await markets.returns(row)).subject.corporateActionAdjusted).toBe(
        false,
      );
    }
  });
  it("returns raw history and split events for the caller's deterministic price adjustments", async () => {
    const { markets } = setup({
      actions: {
        forward_splits: [
          {
            id: "s",
            symbol: "AAA",
            ex_date: dates[1],
            new_rate: 4,
            old_rate: 1,
          },
        ],
      },
    });
    expect(await markets.history("AAA", dates[0], dates[2])).toEqual({
      bars: [
        { date: dates[0], close: 100 },
        { date: dates[1], close: 100 },
        { date: dates[2], close: 30 },
      ],
      splits: [{ date: dates[1], factor: 4 }],
      reasons: [],
    });
  });
  it("propagates provider failures without retrying or certifying zero actions", async () => {
    const { markets, urls } = setup({ failActions: true });
    await expect(markets.returns(row)).rejects.toThrow(/429/);
    await expect(markets.returns(row)).rejects.toThrow(/429/);
    expect(urls.filter((u) => u.includes("symbols=AAA"))).toHaveLength(1);
  });
});

it("does not hide entry-day spinoffs or mergers when excluding entry-day dividends", async () => {
  const { markets } = setup({
    actions: {
      spin_offs: [
        { id: "spin-entry", source_symbol: "AAA", ex_date: dates[0] },
      ],
    },
  });
  expect((await markets.returns(row)).subject.corporateActionAdjusted).toBe(
    false,
  );
});
it("refuses malformed action coverage and repeated pagination tokens", async () => {
  for (const response of [
    {},
    { corporate_actions: { cash_dividends: null } },
    { corporate_actions: {}, next_page_token: "loop" },
  ]) {
    const markets = new LiveMarkets({
      get: async () => response,
      calendar: { range: async () => sessions },
    });
    await expect(markets.mark("AAA", dates[0])).rejects.toThrow();
  }
});
it("keeps nonfinite split-adjusted values unknown", async () => {
  const { markets } = setup({
    actions: {
      forward_splits: [
        {
          id: "huge",
          symbol: "AAA",
          ex_date: dates[1],
          new_rate: 1e308,
          old_rate: 1,
        },
      ],
    },
  });
  const result = await markets.returns(row);
  expect(result.subject.corporateActionAdjusted).toBe(false);
  expect(result.subject.endPrice).toBeNull();
});

it("ends daily bar retrieval at the official close instead of future UTC midnight", async () => {
  const { markets, urls } = setup();
  await markets.history("AAA", dates[0], dates[2]);
  const barUrl = new URL(urls.find((url) => url.includes("/AAA/bars"))!);
  expect(barUrl.searchParams.get("end")).toBe(sessions[2].close);
  // At a 20:16 collection the entire query is at least 15 minutes old.
  const collectionAt = Date.parse(`${dates[2]}T20:16:00.000Z`);
  expect(
    collectionAt - Date.parse(barUrl.searchParams.get("end")!),
  ).toBeGreaterThanOrEqual(15 * 60_000);
});

it("treats a same-security stock dividend as additional shares on its ex-date", async () => {
  const { markets } = setup({
    actions: {
      stock_dividends: [
        {
          id: "stock-div",
          symbol: "AAA",
          cusip: "123456789",
          ex_date: dates[1],
          rate: 0.05,
        },
      ],
      cash_dividends: [{ ...dividend, ex_date: dates[2] }],
    },
  });
  expect((await markets.history("AAA", dates[0], dates[2])).splits).toEqual([
    { date: dates[1], factor: 1.05 },
  ]);
  const mark = await markets.mark("AAA", dates[1]);
  expect(mark).toMatchObject({
    splitFactor: 1.05,
    actionsComplete: true,
    cashPerPreviousShare: 0,
  });
  const result = await markets.returns(row);
  expect(result.subject.corporateActionAdjusted).toBe(true);
  expect(result.subject.endPrice).toBeCloseTo(31.5);
  expect(result.subject.distributions[0].amountPerShare).toBeCloseTo(1.05);
});

it("keeps missing stock-dividend ratios and simultaneous cash entitlement unresolved", async () => {
  const cases: Record<string, unknown[]>[] = [
    { stock_dividends: [{ symbol: "AAA", ex_date: dates[1], rate: null }] },
    { stock_dividends: [{ symbol: "AAA", ex_date: dates[1], rate: -0.05 }] },
    {
      stock_dividends: [{ symbol: "AAA", ex_date: dates[1], rate: 0.05 }],
      cash_dividends: [dividend],
    },
  ];
  for (const actions of cases) {
    const { markets } = setup({ actions });
    expect((await markets.mark("AAA", dates[1])).actionsComplete).toBe(false);
    expect((await markets.returns(row)).subject.corporateActionAdjusted).toBe(
      false,
    );
  }
});

it("preserves USD return-of-capital classification and rejects unsupported cash currency or subtype", async () => {
  const supported = setup({
    actions: {
      cash_dividends: [
        { ...dividend, currency: "USD", sub_type: "return_of_capital" },
      ],
    },
  });
  const data = await supported.markets.returns(row);
  expect(data.subject.corporateActionAdjusted).toBe(true);
  expect(data.subject.distributions).toEqual([
    { exDate: dates[1], amountPerShare: 1, kind: "return_of_capital" },
  ]);
  for (const fields of [
    { currency: "EUR" },
    { currency: null },
    { sub_type: "interest" },
    { sub_type: "future_type" },
    { sub_type: null },
  ]) {
    const { markets } = setup({
      actions: { cash_dividends: [{ ...dividend, ...fields }] },
    });
    const mark = await markets.mark("AAA", dates[1]);
    expect(mark.actionsComplete).toBe(false);
    expect(mark.cashPerPreviousShare).toBeNull();
    expect((await markets.returns(row)).subject.corporateActionAdjusted).toBe(
      false,
    );
  }
});

it("ignores only name-change events whose ticker and nonempty CUSIP are both unchanged", async () => {
  const same = {
    id: "name",
    old_symbol: "AAA",
    new_symbol: "AAA",
    old_cusip: "123456789",
    new_cusip: "123456789",
    process_date: dates[1],
  };
  const unchanged = setup({ actions: { name_changes: [same] } });
  expect(
    (await unchanged.markets.history("AAA", dates[0], dates[2])).reasons,
  ).toEqual([]);
  expect((await unchanged.markets.mark("AAA", dates[1])).actionsComplete).toBe(
    true,
  );
  for (const patch of [
    { old_cusip: "", new_cusip: "" },
    { new_cusip: "987654321" },
    { new_symbol: "NEW" },
    { old_cusip: null },
  ]) {
    const { markets } = setup({
      actions: { name_changes: [{ ...same, ...patch }] },
    });
    expect(
      (await markets.history("AAA", dates[0], dates[2])).reasons.length,
    ).toBeGreaterThan(0);
    expect((await markets.mark("AAA", dates[1])).actionsComplete).toBe(false);
  }
});

it("uses only current-symbol history across a verified same-CUSIP incoming rename while keeping outcomes unresolved", async () => {
  const { markets, urls } = setup({
    actions: {
      name_changes: [
        {
          id: "incoming",
          old_symbol: "OLD",
          new_symbol: "AAA",
          old_cusip: "123456789",
          new_cusip: "123456789",
          process_date: dates[1],
        },
      ],
    },
  });
  const history = await markets.history("AAA", dates[0], dates[2]);
  expect(history.reasons).toEqual([]);
  expect(history.bars).toHaveLength(3);
  const barUrls = urls.filter((url) => url.includes("/bars"));
  expect(barUrls).toHaveLength(1);
  expect(new URL(barUrls[0]).pathname).toBe("/v2/stocks/AAA/bars");
  expect(new URL(barUrls[0]).searchParams.get("asof")).toBe("-");
  expect(urls.some((url) => url.includes("/OLD/"))).toBe(false);
  expect((await markets.mark("AAA", dates[1])).actionsComplete).toBe(false);
  expect((await markets.returns(row)).subject.corporateActionAdjusted).toBe(
    false,
  );
});

it("does not extend the history-only rename exception to changed, missing or mismatched identities", async () => {
  const rename = {
    id: "incoming",
    old_symbol: "OLD",
    new_symbol: "AAA",
    old_cusip: "123456789",
    new_cusip: "123456789",
    process_date: dates[1],
  };
  for (const patch of [
    { new_cusip: "987654321" },
    { old_cusip: "", new_cusip: "" },
    { old_cusip: null },
    { new_symbol: "OTHER" },
    { old_symbol: null },
  ]) {
    const { markets } = setup({
      actions: { name_changes: [{ ...rename, ...patch }] },
    });
    expect(
      (await markets.history("AAA", dates[0], dates[2])).reasons.length,
    ).toBeGreaterThan(0);
  }
});
