import type {
  PaperPosition,
  PaperSnapshot,
  TournamentLedger,
  TournamentRow,
  Arm,
} from "./types";
import { DETERMINISTIC_ARMS } from "./types";
import type { MarketSession } from "../marketCalendar";
export interface Book {
  cash: number;
  positions: PaperPosition[];
}
export function rebalance(
  before: Book,
  targets: string[],
  opens: Record<string, number | null>,
): Book & { nav: number | null; costUsd: number | null; reasons: string[] } {
  const names = [
    ...new Set([...before.positions.map((p) => p.ticker), ...targets]),
  ];
  if (new Set(targets).size !== targets.length || targets.length > 10)
    throw new Error("Invalid portfolio targets");
  if (before.cash < 0 || before.positions.some((p) => p.shares < 0))
    throw new Error("No leverage or shorting");
  if (
    names.some(
      (t) => opens[t] == null || !Number.isFinite(opens[t]) || opens[t]! <= 0,
    )
  )
    return {
      ...before,
      nav: null,
      costUsd: null,
      reasons: ["Missing official open: rebalance withheld; holdings retained"],
    };
  const held = Object.fromEntries(
    before.positions.map((p) => [p.ticker, p.shares * opens[p.ticker]!]),
  );
  const equity = before.cash + Object.values(held).reduce((a, b) => a + b, 0);
  const cost = (invested: number) =>
    names.reduce(
      (sum, t) =>
        sum +
        Math.abs(
          (targets.includes(t) ? invested / targets.length : 0) -
            (held[t] ?? 0),
        ) *
          0.001,
      0,
    );
  let lo = 0,
    hi = equity;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (mid + cost(mid) > equity) hi = mid;
    else lo = mid;
  }
  const invested = targets.length ? lo : 0,
    costUsd = cost(invested),
    cash = equity - invested - costUsd;
  return {
    cash: Math.max(0, cash),
    positions: targets.map((ticker) => ({
      ticker,
      shares: invested / targets.length / opens[ticker]!,
    })),
    nav: equity - costUsd,
    costUsd,
    reasons: [],
  };
}
export interface DayMark {
  open: number | null;
  close: number | null;
  splitFactor: number | null;
  cashPerPreviousShare: number | null;
  actionsComplete: boolean;
  reason: string | null;
}
export type MarkProvider = (
  ticker: string,
  session: MarketSession,
) => Promise<DayMark>;
export async function markPortfolios(
  ledger: TournamentLedger,
  rows: TournamentRow[],
  sessions: MarketSession[],
  provider: MarkProvider,
  now: Date,
) {
  const existing = await ledger.portfolios();
  let count = 0;
  for (const session of sessions.filter(
    (s) => Date.parse(s.close) <= now.getTime(),
  ))
    for (const arm of [
      ...DETERMINISTIC_ARMS,
      "ensemble",
      "jev",
      "spy",
    ] as const) {
      const id = `${arm}_${session.date}`;
      if (existing.some((p) => p.id === id)) continue;
      const dayRows = rows.filter(
        (r) =>
          r.prediction.horizonCount === 1 &&
          r.prediction.evaluationWindow?.entryAt === session.open &&
          (arm === "spy" || r.arm === arm),
      );
      const previous = existing
        .filter((p) => p.arm === arm && p.date < session.date)
        .sort((a, b) => a.date.localeCompare(b.date))
        .at(-1);
      if (!previous && !dayRows.length) continue;
      let book: Book = {
        cash: previous?.cash ?? 100000,
        positions: previous?.positions ?? [],
      };
      let costUsd: number | null = 0,
        nav: number | null = null;
      const reasons: string[] = [];
      const targets =
        arm === "spy"
          ? ["SPY"]
          : dayRows.length
            ? dayRows
                .filter((r) => r.disposition === "long")
                .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
                .slice(0, 10)
                .map((r) => r.prediction.ticker)
            : book.positions.map((p) => p.ticker);
      const names = [
        ...new Set([...book.positions.map((p) => p.ticker), ...targets]),
      ];
      const marks: Record<string, DayMark> = {};
      for (const ticker of names)
        marks[ticker] = await provider(ticker, session);
      if (previous?.nav === null)
        reasons.push(
          "Prior portfolio unresolved; cannot advance holdings without a corrected evidence series",
        );
      if (
        names.some(
          (t) =>
            !marks[t].actionsComplete ||
            marks[t].splitFactor == null ||
            marks[t].cashPerPreviousShare == null,
        )
      )
        reasons.push(
          "Corporate action coverage incomplete; no fabricated mark or rebalance",
        );
      if (!reasons.length) {
        book = {
          cash:
            book.cash +
            book.positions.reduce(
              (sum, p) =>
                sum + p.shares * marks[p.ticker].cashPerPreviousShare!,
              0,
            ),
          positions: book.positions.map((p) => ({
            ticker: p.ticker,
            shares: p.shares * marks[p.ticker].splitFactor!,
          })),
        };
        if ((arm !== "spy" && dayRows.length) || !previous) {
          const traded = rebalance(
            book,
            targets,
            Object.fromEntries(names.map((t) => [t, marks[t].open])),
          );
          book = traded;
          costUsd = traded.costUsd;
          reasons.push(...traded.reasons);
        }
        if (book.positions.some((p) => marks[p.ticker].close == null))
          reasons.push("Missing close or terminated listing; NAV unavailable");
        if (!reasons.length)
          nav =
            book.cash +
            book.positions.reduce(
              (s, p) => s + p.shares * marks[p.ticker].close!,
              0,
            );
      } else costUsd = null;
      const result: PaperSnapshot = {
        id,
        date: session.date,
        arm: arm as Arm | "spy",
        ...book,
        nav,
        costUsd,
        reasons,
        createdAt: now.toISOString(),
      };
      await ledger.appendPortfolio(result);
      existing.push(result);
      count++;
    }
  return count;
}
