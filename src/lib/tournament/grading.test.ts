import { it, expect } from "vitest";
import { rebalance } from "./portfolio";
import { neweyWest, buildReport } from "./report";
it("charges both sides on turnover without leverage and leaves identical holdings alone", () => {
  const book = rebalance({ cash: 100000, positions: [] }, ["A", "B"], {
    A: 100,
    B: 200,
  });
  expect(book.costUsd).toBeCloseTo(100000 - 100000 / 1.001);
  expect(book.cash).toBeGreaterThanOrEqual(0);
  expect(
    book.positions.find((p) => p.ticker === "A")!.shares * 100,
  ).toBeCloseTo(100000 / 1.001 / 2);
  const same = rebalance(book, ["A", "B"], { A: 100, B: 200 });
  expect(same.costUsd).toBeCloseTo(0);
  const swapped = rebalance(book, ["C"], { A: 100, B: 200, C: 100 });
  expect(swapped.costUsd).toBeGreaterThan(190);
  expect(swapped.cash).toBeGreaterThanOrEqual(0);
});
it("refuses missing held prices instead of inventing losses", () => {
  const before = { cash: 100, positions: [{ ticker: "A", shares: 10 }] };
  const result = rebalance(before, ["B"], { B: 20 });
  expect(result.nav).toBeNull();
  expect(result.positions).toEqual(before.positions);
  expect(result.cash).toBe(100);
});
it("withholds HAC below the daily observation floor and never implies significance", () => {
  expect(neweyWest([0.1, 0.2], 19).tStatistic).toBeNull();
  const nw = neweyWest(
    Array.from({ length: 40 }, (_, i) => ((i % 5) - 2) / 100 + 0.001),
    19,
  );
  expect(nw.tStatistic).not.toBeNull();
  expect(nw.observations).toBe(40);
  const report = buildReport([], [], [], "tournament_dryrun");
  expect(report.leaderboard).toHaveLength(8);
  expect(report.leaderboard.every((r) => r.primaryMean === null)).toBe(true);
});

it("realizes known cash/zero proceeds and successor shares instead of freezing delisted holdings", async () => {
  const { applyPortfolioActions } = await import("./portfolio");
  const base = {
    open: null,
    close: null,
    splitFactor: 1,
    cashPerPreviousShare: 0,
    actionsComplete: true,
    reason: null,
  };
  const book = { cash: 10, positions: [{ ticker: "A", shares: 5 }] };
  expect(
    applyPortfolioActions(
      book,
      {
        A: {
          ...base,
          termination: {
            at: "before_open",
            cashPerPreviousShare: 120,
            successor: null,
          },
        },
      },
      "before_open",
    ),
  ).toEqual({ cash: 610, positions: [] });
  expect(
    applyPortfolioActions(
      book,
      {
        A: {
          ...base,
          termination: {
            at: "before_open",
            cashPerPreviousShare: 0,
            successor: null,
          },
        },
      },
      "before_open",
    ),
  ).toEqual({ cash: 10, positions: [] });
  expect(
    applyPortfolioActions(
      book,
      {
        A: {
          ...base,
          termination: {
            at: "before_open",
            cashPerPreviousShare: 0,
            successor: { ticker: "B", sharesPerPreviousShare: 2 },
          },
        },
      },
      "before_open",
    ),
  ).toEqual({ cash: 10, positions: [{ ticker: "B", shares: 10 }] });
  expect(
    applyPortfolioActions(
      book,
      {
        A: {
          ...base,
          termination: {
            at: "before_open",
            cashPerPreviousShare: null,
            successor: null,
          },
        },
      },
      "before_open",
    ),
  ).toBeNull();
});
