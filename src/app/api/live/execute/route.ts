// The step that acts.
//
// Everything before this formed a view and then checked it against the rails.
// This step is the only place in the system where a decision becomes an order,
// and it is built so that its failure mode is always "did not trade" and never
// "traded without a record".
//
// Three things make that true:
//
//   1. The intent is written to the ledger BEFORE the broker is called. An order
//      that is placed but whose response is lost is still recoverable, because
//      the record of what we meant to do already exists.
//   2. Every order carries a deterministic client id derived from the decision
//      it executes. A replayed run submits the same id, Alpaca rejects the
//      duplicate, and we resolve it to the order that already exists. There is
//      no path here that submits twice.
//   3. In paper mode it refuses to trade anything that is not in a published
//      commit. Publication is not a report on what happened; it is a
//      precondition of it happening.
//
// In shadow mode the intent is recorded and nothing is sent. The book does not
// move — reconcile reads positions from the broker, and in shadow there is
// nothing at the broker to read. A shadow run exists to let a human read the
// sizing before it becomes real, and for no other purpose.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withHarness, runStep, easternDay } from "@/lib/live/harness";
import { getRunState, getStepResult } from "@/lib/live/runState";
import { getDecisionsForDay } from "@/lib/live/ledgerRead";
import { appendOrder, appendFill, appendEvent } from "@/lib/live/ledger";
import { clientOrderId, orderQty, slippageBps } from "@/lib/live/sizing";
import { executionMode } from "@/lib/live/version";
import {
  alpacaTradingConfigured,
  getClock,
  getOrderByClientId,
  placeOrder,
  type AlpacaOrder,
} from "@/lib/alpacaTrading";
import { getAlpacaSnapshots } from "@/lib/alpaca";
import type { BookSnapshot } from "@/lib/schemas/live/snapshot";
import type { OrderIntent, FillRecord } from "@/lib/schemas/live/order";
import { apiError } from "@/lib/apiError";
import { logger } from "@/lib/logger";

const log = logger("live:execute");

export const maxDuration = 300;

const BodySchema = z.object({ runId: z.string().min(1).optional() });

/** How long to wait for a market order to reach a terminal state. */
const FILL_TIMEOUT_MS = 30_000;
const FILL_POLL_MS = 2_000;
const TERMINAL = new Set(["filled", "canceled", "expired", "rejected", "done_for_day"]);

/**
 * Poll one order to a terminal state.
 *
 * Returns whatever the last poll saw when the window expires rather than
 * throwing: an order still working is a fact to record, not an error. Tomorrow's
 * reconcile reads the real position back from the broker regardless, so the book
 * cannot drift from reality just because this loop gave up waiting.
 */
async function awaitFill(
  clientId: string,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<AlpacaOrder | null> {
  const deadline = now() + FILL_TIMEOUT_MS;
  let last: AlpacaOrder | null = null;
  for (;;) {
    last = await getOrderByClientId(clientId);
    if (last && TERMINAL.has(last.status)) return last;
    if (now() >= deadline) return last;
    await sleep(FILL_POLL_MS);
  }
}

export const POST = withHarness(async (req) => {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return apiError("validation_error", "Invalid body", 400, z.flattenError(parsed.error));
  }
  if (!alpacaTradingConfigured()) {
    return apiError("not_configured", "Alpaca paper trading is not configured", 503);
  }

  const tradingDay = easternDay();
  const runId = parsed.data.runId ?? tradingDay;
  // Orders only ever go out for TODAY's decisions: a past run's decisions would
  // be executed at today's prices, which is not what was published pre-open.
  if (runId !== tradingDay) {
    return apiError("invalid_run", "Only today's run can be executed", 400);
  }
  const mode = executionMode();

  const state = await getRunState(runId);
  if (!state) return apiError("out_of_order", "No such run — open a session first", 409);

  const decide = state.steps.decide as { done?: boolean } | undefined;
  if (!decide?.done) {
    return apiError("out_of_order", "Run the decide step before executing", 409);
  }

  const reconcile = state.steps.reconcile as
    | { done?: boolean; result?: { snapshot: BookSnapshot } }
    | undefined;
  if (!reconcile?.done || !reconcile.result) {
    return apiError("out_of_order", "Run the reconcile step before executing", 409);
  }
  const snapshot = reconcile.result.snapshot;

  // Paper mode only: refuse anything that is not already public, and refuse to
  // trade a closed market. Shadow skips both — it sends nothing, and a dry run
  // has to be reviewable at whatever hour the reviewer is awake.
  if (mode === "paper") {
    const publication = await getStepResult<{ commit: string; contentHash: string }>(
      runId,
      "publish"
    );
    if (!publication?.commit) {
      return apiError(
        "not_published",
        "This run has not been published. Finava Live does not trade a decision that is " +
          "not already in a public commit — publication is what makes the record " +
          "falsifiable, so it precedes execution rather than describing it.",
        409
      );
    }
    const clock = await getClock();
    if (!clock.isOpen) {
      return apiError("market_closed", `The market is closed; next open ${clock.nextOpen}`, 409);
    }
  }

  const decisions = (await getDecisionsForDay(runId)).filter(
    (d) => d.kind === "entry" || d.kind === "exit"
  );

  const { result, replayed } = await runStep(runId, "execute", async () => {
    const placed: OrderIntent[] = [];
    const fills: FillRecord[] = [];
    const skipped: { ticker: string; reason: string }[] = [];

    const tickers = [...new Set(decisions.map((d) => d.ticker.toUpperCase()))];
    const snapshots = tickers.length
      ? await getAlpacaSnapshots(tickers).catch((err) => {
          log.warn("snapshot fetch failed; every order will be skipped for want of a price", {
            err: err instanceof Error ? err.message : String(err),
          });
          return new Map<string, never>();
        })
      : new Map<string, never>();

    for (const decision of decisions) {
      const ticker = decision.ticker.toUpperCase();
      const side = decision.kind === "entry" ? "buy" : "sell";
      const quote = snapshots.get(ticker) ?? null;
      const price = quote?.price ?? null;

      // An exit sells what is actually held, not what a weight implies — the
      // position is a fact, and deriving it from a percentage would leave a
      // remainder behind on every rounding difference.
      const held = snapshot.positions.find((p) => p.ticker === ticker);
      const qty =
        side === "sell"
          ? (held?.qty ?? null)
          : orderQty(decision.targetWeightPct, snapshot.equity, price);

      if (qty === null) {
        const reason =
          side === "sell" ? "no open position to sell" : "no tradable price for sizing";
        skipped.push({ ticker, reason });
        await appendEvent({
          eventId: `${runId}-${ticker}-execution_skipped`,
          tradingDay,
          kind: "execution_skipped",
          message: `${ticker}: ${reason}`,
          detail: { runId, ticker, side, reason },
          createdAt: new Date().toISOString(),
        });
        continue;
      }
      if (qty <= 0) {
        skipped.push({ ticker, reason: "sized to zero" });
        continue;
      }

      const clientId = clientOrderId(decision.decisionId);
      const intent: OrderIntent = {
        intentId: clientId,
        decisionId: decision.decisionId,
        runId,
        tradingDay,
        ticker,
        side,
        qty,
        notionalPctOfEquity: decision.targetWeightPct,
        type: "market",
        timeInForce: "day",
        shadow: mode !== "paper",
        clientOrderId: clientId,
        createdAt: new Date().toISOString(),
      };

      // Ledger first, broker second. The order of these two lines is the whole
      // recoverability argument.
      await appendOrder(intent);
      placed.push(intent);

      if (mode !== "paper") continue;

      const order = await placeOrder({
        symbol: ticker,
        side,
        qty,
        timeInForce: "day",
        clientOrderId: clientId,
      });
      const settled = await awaitFill(clientId);
      const filledAvgPrice = settled?.filledAvgPrice ?? null;
      const officialOpen = quote?.open ?? null;

      const fill: FillRecord = {
        fillId: `${clientId}-fill`,
        intentId: clientId,
        runId,
        tradingDay,
        ticker,
        side,
        filledQty: settled?.filledQty ?? 0,
        filledAvgPrice,
        officialOpen,
        slippageBps: slippageBps(side, filledAvgPrice, officialOpen),
        synthetic: false,
        brokerOrderId: settled?.id ?? order.id,
        status: settled?.status ?? order.status,
        submittedAt: settled?.submittedAt ?? order.submittedAt,
        filledAt: settled?.filledAt ?? null,
        createdAt: new Date().toISOString(),
      };
      await appendFill(fill);
      fills.push(fill);
    }

    return {
      runId,
      tradingDay,
      mode,
      orders: placed.length,
      fills: fills.length,
      skipped,
      intents: placed,
    };
  });

  return NextResponse.json({ ...result, replayed });
});
