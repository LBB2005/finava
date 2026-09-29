import { z } from "zod";
import {
  easternDate,
  shiftDate,
  validDate,
  type MarketSession,
} from "../marketCalendar";
import type { TotalReturnData } from "../investment/evaluation/outcomes";
import type { TournamentRow } from "./types";
import type { DayMark } from "./portfolio";

const DATA = "https://data.alpaca.markets";
const SOURCE =
  "Alpaca raw SIP daily regular-session eligible close; primary-market Q official open; explicit split/share and ex-date cash adjustments. Corporate actions: all published qualities/types, process-date search padded 366 days each side; provider publication delays and events outside this bounded process range are not guaranteed.";
const PRIMARY: Record<string, string> = {
  NASDAQ: "Q",
  NYSE: "N",
  ARCA: "P",
  NYSEARCA: "P",
  AMEX: "A",
  NYSEAMERICAN: "A",
  BATS: "Z",
};
const RecordSchema = z.record(z.string(), z.unknown());
const PageSchema = z
  .object({ next_page_token: z.string().nullable().optional() })
  .passthrough();
const BarSchema = z.object({
  t: z.iso.datetime({ offset: true }),
  c: z.number().positive().finite(),
});
const TradeSchema = z.object({
  t: z.iso.datetime({ offset: true }),
  p: z.number().positive().finite(),
  x: z.string(),
  c: z.array(z.string()),
  i: z.union([z.number(), z.string()]).optional(),
});
type Split = { date: string; factor: number };
type Cash = {
  date: string;
  amount: number;
  kind: "cash_dividend" | "special_dividend" | "return_of_capital";
};
type ActionIssue = {
  date: string | null;
  reason: string;
  affectsHistory: boolean;
};
type Actions = { splits: Split[]; cash: Cash[]; issues: ActionIssue[] };
function number(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim()))
    return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function date(value: unknown): string | null {
  return typeof value === "string" && validDate(value) ? value : null;
}
function range(ticker: string, start: string, end: string) {
  if (
    !/^[A-Z0-9.-]+$/.test(ticker) ||
    !validDate(start) ||
    !validDate(end) ||
    start > end
  )
    throw new Error("Invalid market evidence range");
}
function issues(
  actions: Actions,
  start: string,
  end: string,
  includeStart = true,
  history = false,
) {
  return actions.issues
    .filter(
      (i) =>
        (!history || i.affectsHistory) &&
        (i.date === null ||
          ((includeStart ? i.date >= start : i.date > start) && i.date <= end)),
    )
    .map((i) => i.reason);
}

/** Read-only adapter. Injected requester owns credentials, raw-response archival,
 * rate limiting and 429 handling. A fresh adapter is used for each collection.
 * Successful empty CA responses mean no published events within the documented
 * search bound, not a guarantee that Alpaca has received every issuer event.
 */
export class LiveMarkets {
  private requests = new Map<string, Promise<unknown>>();
  private calendars = new Map<string, Promise<MarketSession[]>>();
  constructor(
    private deps: {
      get: (url: string) => Promise<unknown>;
      calendar: { range(start: string, end: string): Promise<MarketSession[]> };
    },
  ) {}
  private get(url: string): Promise<unknown> {
    let pending = this.requests.get(url);
    if (!pending) {
      pending = this.deps.get(url);
      this.requests.set(url, pending);
    }
    return pending;
  }
  private calendar(start: string, end: string) {
    const key = `${start}_${end}`;
    let pending = this.calendars.get(key);
    if (!pending) {
      pending = this.deps.calendar.range(start, end);
      this.calendars.set(key, pending);
    }
    return pending;
  }
  private async pages(
    path: string,
    params: Record<string, string>,
    maxPages = 100,
  ) {
    const results: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    for (let n = 0; n < maxPages; n++) {
      const query = new URLSearchParams({
        ...params,
        ...(token ? { page_token: token } : {}),
      });
      const page = PageSchema.parse(await this.get(`${DATA}${path}?${query}`));
      results.push(page);
      if (!page.next_page_token) return results;
      if (seen.has(page.next_page_token))
        throw new Error(
          "Alpaca pagination repeated token; coverage incomplete",
        );
      token = page.next_page_token;
      seen.add(token);
    }
    throw new Error("Alpaca pagination bound exceeded; coverage incomplete");
  }
  private async bars(ticker: string, start: string, end: string) {
    // Historical SIP on the basic plan rejects end times newer than 15 minutes.
    // The caller collects after close plus that delay; never expand its query
    // to a future UTC midnight. Daily bars are timestamped before this close.
    let lastSession = (await this.calendar(end, end)).find(
      (s) => s.date === end,
    );
    if (!lastSession)
      lastSession = (await this.calendar(start, end))
        .filter((s) => s.date >= start && s.date <= end)
        .sort((a, b) => a.date.localeCompare(b.date))
        .at(-1);
    if (!lastSession) return [];
    const pages = await this.pages(
      `/v2/stocks/${encodeURIComponent(ticker)}/bars`,
      {
        start,
        end: lastSession.close,
        timeframe: "1Day",
        adjustment: "raw",
        feed: "sip",
        asof: "-",
        limit: "10000",
        sort: "asc",
      },
    );
    const result = new Map<string, number>();
    for (const page of pages) {
      if (page.symbol !== ticker) throw new Error("Alpaca bar symbol mismatch");
      if (!("bars" in page)) throw new Error("Alpaca bar collection absent");
      for (const raw of z.array(BarSchema).parse(page.bars ?? [])) {
        const day = easternDate(new Date(raw.t));
        if (day < start || day > end) continue;
        if (result.has(day) && result.get(day) !== raw.c)
          throw new Error("Conflicting daily closes");
        result.set(day, raw.c);
      }
    }
    return [...result]
      .map(([date, close]) => ({ date, close }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  private async actions(
    ticker: string,
    start: string,
    end: string,
  ): Promise<Actions> {
    // API start/end constrain PROCESS date, NOT ex/effective date. A 42-day
    // SPY ex/pay lag is ordinary; a same-holding-window query silently loses it.
    const pages = await this.pages("/v1/corporate-actions", {
      symbols: ticker,
      start: shiftDate(start, -366),
      end: shiftDate(end, 366),
      data_quality: "all",
      limit: "1000",
      sort: "asc",
    });
    const result: Actions = { splits: [], cash: [], issues: [] };
    const seen = new Map<string, string>();
    for (const page of pages) {
      const groups = RecordSchema.parse(page.corporate_actions);
      for (const [kind, rawEvents] of Object.entries(groups)) {
        for (const event of z.array(RecordSchema).parse(rawEvents)) {
          const key =
            typeof event.id === "string"
              ? `${kind}:${event.id}`
              : JSON.stringify([kind, event]);
          const encoded = JSON.stringify(event);
          if (seen.has(key)) {
            if (seen.get(key) !== encoded)
              result.issues.push({
                date: null,
                reason: `Conflicting ${kind} versions`,
                affectsHistory: true,
              });
            continue;
          }
          seen.set(key, encoded);
          const effective = date(event.ex_date) ?? date(event.effective_date);
          if (effective && (effective < start || effective > end)) continue;
          const issue = (reason: string, affectsHistory = true) =>
            result.issues.push({ date: effective, reason, affectsHistory });
          // Exact identity fields are defined in Alpaca's current OpenAPI:
          // https://docs.alpaca.markets/us/reference/corporateactions-1.md
          // Name changes only expose process_date, not an effective date.
          // Ignore the no-op identity case; never use process_date as an
          // effective date or infer continuity across a CUSIP change.
          if (kind === "name_changes") {
            if (
              event.old_symbol === ticker &&
              event.new_symbol === ticker &&
              typeof event.old_cusip === "string" &&
              event.old_cusip.trim() &&
              event.old_cusip === event.new_cusip
            )
              continue;
            // History is already queried with asof=-: Alpaca returns only the
            // requested symbol and does not stitch earlier ticker names.
            // https://docs.alpaca.markets/us/docs/market-data-faq
            // An incoming rename with the exact same known CUSIP cannot change
            // this same-security current-symbol-only price basis. This exemption
            // is limited to history: unknown effective dates still block outcome
            // returns and portfolio actions. Never request the old ticker here.
            const sameSecurityIncoming =
              event.new_symbol === ticker &&
              typeof event.old_symbol === "string" &&
              /^[A-Z0-9.-]+$/.test(event.old_symbol) &&
              event.old_symbol !== ticker &&
              typeof event.old_cusip === "string" &&
              event.old_cusip.trim().length > 0 &&
              event.old_cusip === event.new_cusip;
            issue(
              "Name change identity or effective date unknown; continuity unresolved",
              !sameSecurityIncoming,
            );
            continue;
          }
          // An event returned for a merger acquirer is not the acquired shares.
          const affected =
            event.symbol ??
            event.source_symbol ??
            event.acquiree_symbol ??
            event.old_symbol;
          if (typeof affected === "string" && affected !== ticker) {
            if (
              [
                event.acquirer_symbol,
                event.new_symbol,
                event.alternate_symbol,
              ].includes(ticker)
            )
              continue;
            issue(`Corporate action symbol mismatch: ${kind}`);
            continue;
          }
          if (typeof affected !== "string") {
            issue(`Corporate action affected symbol unknown: ${kind}`);
            continue;
          }
          if (!effective) {
            issue(
              `Corporate action ex/effective date unknown: ${kind}`,
              kind !== "cash_dividends",
            );
            continue;
          }
          if (kind === "forward_splits" || kind === "reverse_splits") {
            const old = number(event.old_rate),
              next = number(event.new_rate);
            if (
              old === null ||
              next === null ||
              old <= 0 ||
              next <= 0 ||
              !Number.isFinite(next / old)
            ) {
              issue(`Invalid ${kind} ratio`);
              continue;
            }
            result.splits.push({ date: effective, factor: next / old });
          } else if (kind === "stock_dividends") {
            // The OpenAPI's MSBC example has rate 0.05, matching the issuer's
            // 2023 five-percent stock dividend (1.05 shares per prior share):
            // https://ir.missionbank.bank/stock-info/dividend-history/default.aspx
            const rate = number(event.rate);
            if (rate === null || rate < 0 || !Number.isFinite(1 + rate)) {
              issue("Stock dividend ratio unknown");
              continue;
            }
            result.splits.push({ date: effective, factor: 1 + rate });
          } else if (kind === "cash_dividends") {
            const amount = number(event.rate);
            if (
              amount === null ||
              amount < 0 ||
              typeof event.special !== "boolean" ||
              typeof event.foreign !== "boolean" ||
              event.foreign ||
              (event.currency !== undefined && event.currency !== "USD") ||
              (event.sub_type !== undefined &&
                event.sub_type !== "return_of_capital") ||
              event.due_bill_on_date ||
              event.due_bill_off_date
            ) {
              issue(
                "Cash dividend amount, currency, subtype or entitlement basis unknown",
                false,
              );
              continue;
            }
            result.cash.push({
              date: effective,
              amount,
              // OpenAPI sub_type distinguishes return of capital from interest.
              // Unsupported interest or future subtypes are withheld above.
              kind:
                event.sub_type === "return_of_capital"
                  ? "return_of_capital"
                  : event.special
                    ? "special_dividend"
                    : "cash_dividend",
            });
          } else
            issue(
              `Unsupported corporate action: ${kind}; consideration unresolved`,
            );
        }
      }
    }
    for (const cash of result.cash)
      if (result.splits.some((split) => split.date === cash.date))
        result.issues.push({
          date: cash.date,
          reason: "Same-day split and dividend share basis unknown",
          affectsHistory: false,
        });
    result.splits.sort((a, b) => a.date.localeCompare(b.date));
    return result;
  }
  private async officialOpen(
    ticker: string,
    day: string,
  ): Promise<{ price: number | null; reason: string | null }> {
    const session = (await this.calendar(day, day)).find((s) => s.date === day);
    if (!session) return { price: null, reason: "Exchange session absent" };
    const asset = RecordSchema.parse(
      await this.get(
        `https://paper-api.alpaca.markets/v2/assets/${encodeURIComponent(ticker)}`,
      ),
    );
    const primary =
      typeof asset.exchange === "string" ? PRIMARY[asset.exchange] : undefined;
    if (asset.symbol !== ticker || asset.class !== "us_equity" || !primary)
      return { price: null, reason: "Primary listing exchange unknown" };
    // Delayed auctions beyond this bounded first minute remain unknown. No
    // first-trade or daily-open fallback is permitted by the entry contract.
    const end = new Date(Date.parse(session.open) + 60_000).toISOString();
    const pages = await this.pages(
      `/v2/stocks/${encodeURIComponent(ticker)}/trades`,
      {
        start: session.open,
        end,
        feed: "sip",
        asof: "-",
        limit: "10000",
        sort: "asc",
      },
      20,
    );
    const auctions = new Map<string, number>();
    for (const page of pages) {
      if (page.symbol !== ticker)
        throw new Error("Alpaca trade symbol mismatch");
      if (!("trades" in page))
        throw new Error("Alpaca trade collection absent");
      for (const trade of z.array(TradeSchema).parse(page.trades ?? [])) {
        if (
          trade.x !== primary ||
          !trade.c.includes("Q") ||
          Date.parse(trade.t) < Date.parse(session.open) ||
          Date.parse(trade.t) > Date.parse(end)
        )
          continue;
        auctions.set(
          JSON.stringify([trade.i ?? null, trade.t, trade.p]),
          trade.p,
        );
      }
    }
    if (auctions.size !== 1)
      return {
        price: null,
        reason: auctions.size
          ? "Ambiguous primary official opening auction"
          : "Primary official opening auction absent within first minute",
      };
    return { price: [...auctions.values()][0], reason: null };
  }
  async history(
    ticker: string,
    start: string,
    end: string,
  ): Promise<{
    bars: { date: string; close: number }[];
    splits: Split[];
    reasons: string[];
  }> {
    range(ticker, start, end);
    const bars = await this.bars(ticker, start, end);
    const actions = await this.actions(ticker, start, end);
    return {
      bars,
      splits: actions.splits,
      reasons: issues(actions, start, end, true, true),
    };
  }
  private async series(
    ticker: string,
    start: string,
    end: string,
  ): Promise<TotalReturnData["subject"]> {
    range(ticker, start, end);
    const actions = await this.actions(ticker, start, end);
    const open = await this.officialOpen(ticker, start);
    const bars = await this.bars(ticker, end, end);
    const heldSplits = actions.splits.filter(
      (s) => s.date > start && s.date <= end,
    );
    const factor = heldSplits.reduce((n, s) => n * s.factor, 1);
    const reasons = issues(actions, start, end, false);
    reasons.push(
      ...actions.issues
        .filter((i) => i.date === start && i.affectsHistory)
        .map((i) => i.reason),
    );
    if (!Number.isFinite(factor)) reasons.push("Split product overflow");
    const close = bars.find((b) => b.date === end)?.close ?? null;
    const endValue = close === null ? null : close * factor;
    const distributions = actions.cash
      .filter((c) => c.date > start && c.date <= end)
      .map((c) => ({
        exDate: c.date,
        amountPerShare:
          c.amount *
          heldSplits
            .filter((s) => s.date <= c.date)
            .reduce((n, s) => n * s.factor, 1),
        kind: c.kind,
      }));
    if (
      (endValue !== null && !Number.isFinite(endValue)) ||
      distributions.some((d) => !Number.isFinite(d.amountPerShare))
    )
      reasons.push("Split-adjusted value overflow");
    return {
      symbol: ticker,
      windowStart: start,
      windowEnd: end,
      startPrice: open.price,
      endPrice:
        endValue !== null && Number.isFinite(endValue) ? endValue : null,
      distributions: distributions.filter((d) =>
        Number.isFinite(d.amountPerShare),
      ),
      corporateActionAdjusted: reasons.length === 0,
      adjustmentSource: [
        SOURCE,
        ...reasons,
        ...(open.reason ? [open.reason] : []),
      ].join("; "),
    };
  }
  async returns(row: TournamentRow): Promise<TotalReturnData> {
    const window = row.prediction.evaluationWindow;
    if (!window)
      throw new Error("Recorded next-session evaluation window missing");
    const start = window.entryAt.slice(0, 10),
      end = row.prediction.targetDate;
    const session = (await this.calendar(start, start)).find(
      (s) => s.date === start,
    );
    if (!session || Date.parse(session.open) !== Date.parse(window.entryAt))
      throw new Error("Entry timestamp does not match official calendar open");
    const subject = await this.series(row.prediction.ticker, start, end);
    const benchmark = await this.series(row.prediction.benchmark, start, end);
    return {
      subject,
      benchmark,
      corporateAction: null,
      invalidationObservations: [],
    };
  }
  async mark(ticker: string, day: string): Promise<DayMark> {
    range(ticker, day, day);
    const actions = await this.actions(ticker, day, day);
    const open = await this.officialOpen(ticker, day);
    const bars = await this.bars(ticker, day, day);
    const reasons = issues(actions, day, day);
    const split = actions.splits.reduce((n, s) => n * s.factor, 1);
    if (!Number.isFinite(split)) reasons.push("Split product overflow");
    const close = bars.find((b) => b.date === day)?.close ?? null;
    return {
      open: open.price,
      close,
      splitFactor: reasons.length ? null : split,
      cashPerPreviousShare: reasons.length
        ? null
        : actions.cash.reduce((n, c) => n + c.amount, 0),
      actionsComplete: reasons.length === 0,
      reason:
        [
          ...reasons,
          ...(open.reason ? [open.reason] : []),
          ...(close === null ? ["Regular-session daily close absent"] : []),
        ].join("; ") || null,
    };
  }
}
