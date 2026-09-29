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
  /** Explicit cash/stock consideration per share held before today's split.
   * Null cash means unknown consideration, including an unknown stock ratio. */
  termination?: {
    at: "before_open" | "after_open";
    cashPerPreviousShare: number | null;
    successor: { ticker: string; sharesPerPreviousShare: number } | null;
  } | null;
}
export type MarkProvider = (
  ticker: string,
  session: MarketSession,
) => Promise<DayMark>;
export function applyPortfolioActions(
  book: Book,
  marks: Record<string, DayMark>,
  phase: "before_open" | "after_open",
): Book | null {
  if (
    book.positions.some((p) => {
      const m = marks[p.ticker];
      return (
        !m?.actionsComplete ||
        m.splitFactor == null ||
        m.cashPerPreviousShare == null ||
        (m.termination?.at === phase &&
          m.termination.cashPerPreviousShare === null)
      );
    })
  )
    return null;
  let cash = book.cash;
  const positions = new Map<string, number>();
  const add = (ticker: string, shares: number) =>
    positions.set(ticker, (positions.get(ticker) ?? 0) + shares);
  for (const p of book.positions) {
    const m = marks[p.ticker],
      terminal = m.termination;
    if (phase === "before_open") cash += p.shares * m.cashPerPreviousShare!;
    if (terminal?.at === phase) {
      const originalShares =
        phase === "before_open" ? p.shares : p.shares / m.splitFactor!;
      cash += originalShares * terminal.cashPerPreviousShare!;
      if (terminal.successor)
        add(
          terminal.successor.ticker,
          originalShares * terminal.successor.sharesPerPreviousShare,
        );
    } else
      add(p.ticker, p.shares * (phase === "before_open" ? m.splitFactor! : 1));
  }
  return {
    cash,
    positions: [...positions]
      .filter(([, shares]) => shares > 0)
      .map(([ticker, shares]) => ({ ticker, shares })),
  };
}
export async function markPortfolios(
  ledger: TournamentLedger,
  rows: TournamentRow[],
  sessions: MarketSession[],
  provider: MarkProvider,
  now: Date,
) {
  const existing = await ledger.portfolios();
  let count = 0;
  for (const session of [...sessions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((s) => Date.parse(s.close) <= now.getTime())) {
    const marks: Record<string, DayMark> = {};
    const load = async (ticker: string) => {
      if (!marks[ticker]) marks[ticker] = await provider(ticker, session);
    };
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
        nav: number | null = null,
        holdingsKnown = previous?.holdingsKnown ?? previous?.nav !== null;
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
            : [];
      const names = [
        ...new Set([...book.positions.map((p) => p.ticker), ...targets]),
      ];
      for (const ticker of names) await load(ticker);
      // Successor consideration is an exchange of shares, not a fictitious sale.
      for (const ticker of names) {
        const successor = marks[ticker].termination?.successor;
        if (successor) await load(successor.ticker);
      }
      if (!holdingsKnown)
        reasons.push(
          "Prior holdings unresolved; no silent recovery across unknown corporate actions",
        );
      if (holdingsKnown) {
        const adjusted = applyPortfolioActions(book, marks, "before_open");
        if (!adjusted) {
          holdingsKnown = false;
          reasons.push("Corporate action consideration or coverage unknown");
        } else book = adjusted;
      }
      if (holdingsKnown) {
        const targetActionsKnown = targets.every(
          (t) =>
            marks[t].actionsComplete &&
            !(marks[t].termination?.at === "before_open"),
        );
        if (
          ((arm !== "spy" && dayRows.length) || !previous) &&
          targetActionsKnown
        ) {
          const traded = rebalance(
            book,
            targets,
            Object.fromEntries(
              Object.keys(marks).map((t) => [t, marks[t].open]),
            ),
          );
          book = { cash: traded.cash, positions: traded.positions };
          costUsd = traded.costUsd ?? 0;
          reasons.push(...traded.reasons);
        } else if (!targetActionsKnown)
          reasons.push(
            "Rebalance withheld: target actions or entry listing unavailable",
          );
        const adjusted = applyPortfolioActions(book, marks, "after_open");
        if (!adjusted) {
          holdingsKnown = false;
          reasons.push("Intraday termination consideration unknown");
        } else book = adjusted;
      }
      if (holdingsKnown) {
        if (book.positions.some((p) => marks[p.ticker]?.close == null))
          reasons.push(
            "Missing close: NAV unavailable; known holdings retained",
          );
        else
          nav =
            book.cash +
            book.positions.reduce(
              (n, p) => n + p.shares * marks[p.ticker].close!,
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
        holdingsKnown,
        reasons,
        createdAt: now.toISOString(),
      };
      await ledger.appendPortfolio(result);
      existing.push(result);
      count++;
    }
  }
  return count;
}
