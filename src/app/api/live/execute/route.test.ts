// The executor is the only code in the system that can move money, so its tests
// are weighted toward the ways it must REFUSE. A bug that stops a trade costs a
// day; a bug that places one twice, or places one that was never published,
// costs the record.

import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  runStepFn: vi.fn(),
  getRunState: vi.fn(),
  getStepResult: vi.fn(),
  getDecisionsForDay: vi.fn(),
  appendOrder: vi.fn(),
  appendFill: vi.fn(),
  appendEvent: vi.fn(),
  executionMode: vi.fn(),
  alpacaTradingConfigured: vi.fn(() => true),
  getClock: vi.fn(),
  getOrderByClientId: vi.fn(),
  placeOrder: vi.fn(),
  getAlpacaSnapshots: vi.fn(),
}));

vi.mock("@/lib/live/harness", () => ({
  withHarness: (h: (req: Request) => Promise<Response>) => h,
  easternDay: () => "2026-09-02",
  runStep: async (_runId: string, _step: string, fn: () => Promise<unknown>) => {
    const replayed = await deps.runStepFn();
    if (replayed) return { result: replayed, replayed: true };
    return { result: await fn(), replayed: false };
  },
}));
vi.mock("@/lib/live/runState", () => ({
  getRunState: deps.getRunState,
  getStepResult: deps.getStepResult,
}));
vi.mock("@/lib/live/ledgerRead", () => ({ getDecisionsForDay: deps.getDecisionsForDay }));
vi.mock("@/lib/live/ledger", () => ({
  appendOrder: deps.appendOrder,
  appendFill: deps.appendFill,
  appendEvent: deps.appendEvent,
}));
vi.mock("@/lib/live/version", () => ({ executionMode: deps.executionMode }));
vi.mock("@/lib/alpacaTrading", () => ({
  alpacaTradingConfigured: deps.alpacaTradingConfigured,
  getClock: deps.getClock,
  getOrderByClientId: deps.getOrderByClientId,
  placeOrder: deps.placeOrder,
}));
vi.mock("@/lib/alpaca", () => ({ getAlpacaSnapshots: deps.getAlpacaSnapshots }));

import { POST } from "./route";

const SNAPSHOT = {
  tradingDay: "2026-09-02",
  equity: 10_000,
  cashPct: 100,
  positions: [] as { ticker: string; qty: number }[],
  entriesFrozen: false,
};

function decision(over: Record<string, unknown> = {}) {
  return {
    decisionId: "2026-09-02-ACGL-entry",
    ticker: "ACGL",
    kind: "entry",
    targetWeightPct: 8,
    ...over,
  };
}

async function execute(body: Record<string, unknown> = {}) {
  const res = await POST(
    new Request("http://x/api/live/execute", { method: "POST", body: JSON.stringify(body) })
  );
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.runStepFn.mockResolvedValue(null);
  deps.executionMode.mockReturnValue("shadow");
  deps.alpacaTradingConfigured.mockReturnValue(true);
  deps.getRunState.mockResolvedValue({
    creditsSpent: 0,
    steps: { decide: { done: true }, reconcile: { done: true, result: { snapshot: SNAPSHOT } } },
  });
  deps.getStepResult.mockResolvedValue(null);
  deps.getDecisionsForDay.mockResolvedValue([decision()]);
  deps.getAlpacaSnapshots.mockResolvedValue(new Map([["ACGL", { price: 100, open: 99 }]]));
  deps.getClock.mockResolvedValue({ isOpen: true, nextOpen: "2026-09-03T13:30:00Z" });
  deps.placeOrder.mockResolvedValue({ id: "brk-1", status: "accepted", submittedAt: "t0" });
  deps.getOrderByClientId.mockResolvedValue({
    id: "brk-1",
    status: "filled",
    filledQty: 8,
    filledAvgPrice: 101,
    submittedAt: "t0",
    filledAt: "t1",
  });
});

describe("ordering of operations", () => {
  it("records the intent in the ledger before calling the broker", async () => {
    // The recoverability argument in one assertion: an order that is placed but
    // whose response is lost must still have left a record of what we meant.
    deps.executionMode.mockReturnValue("paper");
    deps.getStepResult.mockResolvedValue({ commit: "abc", contentHash: "h" });
    await execute();
    const orderCall = deps.appendOrder.mock.invocationCallOrder[0];
    const placeCall = deps.placeOrder.mock.invocationCallOrder[0];
    expect(orderCall).toBeLessThan(placeCall);
  });

  it("derives the client order id from the decision, so a replay cannot double-fill", async () => {
    deps.executionMode.mockReturnValue("paper");
    deps.getStepResult.mockResolvedValue({ commit: "abc", contentHash: "h" });
    await execute();
    expect(deps.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderId: "2026-09-02-ACGL-entry" })
    );
  });
});

describe("paper mode refuses", () => {
  beforeEach(() => deps.executionMode.mockReturnValue("paper"));

  it("an unpublished run", async () => {
    deps.getStepResult.mockResolvedValue(null);
    const { status, json } = await execute();
    expect(status).toBe(409);
    expect(json.error.code).toBe("not_published");
    expect(deps.placeOrder).not.toHaveBeenCalled();
  });

  it("a closed market", async () => {
    deps.getStepResult.mockResolvedValue({ commit: "abc", contentHash: "h" });
    deps.getClock.mockResolvedValue({ isOpen: false, nextOpen: "2026-09-03T13:30:00Z" });
    const { status, json } = await execute();
    expect(status).toBe(409);
    expect(json.error.code).toBe("market_closed");
    expect(deps.placeOrder).not.toHaveBeenCalled();
  });

  it("a run that has not decided anything yet", async () => {
    deps.getRunState.mockResolvedValue({ creditsSpent: 0, steps: {} });
    const { status, json } = await execute();
    expect(status).toBe(409);
    expect(json.error.code).toBe("out_of_order");
    expect(deps.placeOrder).not.toHaveBeenCalled();
  });

  it("an unconfigured broker", async () => {
    deps.alpacaTradingConfigured.mockReturnValue(false);
    const { status } = await execute();
    expect(status).toBe(503);
    expect(deps.placeOrder).not.toHaveBeenCalled();
  });
});

describe("shadow mode", () => {
  it("records the intent and sends nothing", async () => {
    const { status, json } = await execute();
    expect(status).toBe(200);
    expect(json.mode).toBe("shadow");
    expect(json.orders).toBe(1);
    expect(json.fills).toBe(0);
    expect(deps.appendOrder).toHaveBeenCalledWith(expect.objectContaining({ shadow: true }));
    expect(deps.placeOrder).not.toHaveBeenCalled();
  });

  it("does not require publication or an open market", async () => {
    deps.getStepResult.mockResolvedValue(null);
    deps.getClock.mockResolvedValue({ isOpen: false, nextOpen: "later" });
    const { status } = await execute();
    expect(status).toBe(200);
  });

  it("sizes the order against the book's equity", async () => {
    await execute();
    // 8% of $10,000 at $100 is 8 shares.
    expect(deps.appendOrder).toHaveBeenCalledWith(expect.objectContaining({ qty: 8 }));
  });
});

describe("when it cannot size an order", () => {
  it("skips and records the reason rather than guessing a price", async () => {
    deps.getAlpacaSnapshots.mockResolvedValue(new Map([["ACGL", { price: null, open: null }]]));
    const { json } = await execute();
    expect(json.orders).toBe(0);
    expect(json.skipped).toEqual([{ ticker: "ACGL", reason: "no tradable price for sizing" }]);
    expect(deps.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "execution_skipped" })
    );
  });

  it("skips an exit with no open position", async () => {
    deps.getDecisionsForDay.mockResolvedValue([
      decision({ decisionId: "2026-09-02-NEM-exit", ticker: "NEM", kind: "exit" }),
    ]);
    deps.getAlpacaSnapshots.mockResolvedValue(new Map([["NEM", { price: 100, open: 99 }]]));
    const { json } = await execute();
    expect(json.skipped).toEqual([{ ticker: "NEM", reason: "no open position to sell" }]);
  });
});

describe("what it acts on", () => {
  it("ignores rejections and holds — only entries and exits become orders", async () => {
    deps.getDecisionsForDay.mockResolvedValue([
      decision(),
      decision({ decisionId: "2026-09-02-CF-reject", ticker: "CF", kind: "reject" }),
      decision({ decisionId: "2026-09-02-EIX-hold", ticker: "EIX", kind: "hold" }),
    ]);
    const { json } = await execute();
    expect(json.orders).toBe(1);
    expect(deps.appendOrder).toHaveBeenCalledTimes(1);
  });

  it("sells the position actually held, not a weight-implied quantity", async () => {
    deps.executionMode.mockReturnValue("paper");
    deps.getStepResult.mockResolvedValue({ commit: "abc", contentHash: "h" });
    deps.getRunState.mockResolvedValue({
      creditsSpent: 0,
      steps: {
        decide: { done: true },
        reconcile: {
          done: true,
          result: { snapshot: { ...SNAPSHOT, positions: [{ ticker: "NEM", qty: 3.75 }] } },
        },
      },
    });
    deps.getDecisionsForDay.mockResolvedValue([
      decision({ decisionId: "2026-09-02-NEM-exit", ticker: "NEM", kind: "exit" }),
    ]);
    deps.getAlpacaSnapshots.mockResolvedValue(new Map([["NEM", { price: 100, open: 99 }]]));
    await execute();
    expect(deps.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell", qty: 3.75 })
    );
  });
});

describe("fills", () => {
  beforeEach(() => {
    deps.executionMode.mockReturnValue("paper");
    deps.getStepResult.mockResolvedValue({ commit: "abc", contentHash: "h" });
  });

  it("measures slippage against the official open rather than asserting it", async () => {
    // Filled at 101 against a 99 open on a buy: 202.02 bps of adverse slippage.
    await execute();
    expect(deps.appendFill).toHaveBeenCalledWith(
      expect.objectContaining({ filledAvgPrice: 101, officialOpen: 99, slippageBps: 202.02 })
    );
  });

  it("records a still-working order with no price rather than inventing one", async () => {
    // An order that never reaches a terminal state inside the window is a fact
    // to record, not an error — and never a fabricated fill price. Fake timers
    // so the real 30-second wait does not become a 30-second test.
    deps.getOrderByClientId.mockResolvedValue({
      id: "brk-1",
      status: "accepted",
      filledQty: 0,
      filledAvgPrice: null,
      submittedAt: "t0",
      filledAt: null,
    });
    vi.useFakeTimers();
    try {
      const pending = execute();
      await vi.advanceTimersByTimeAsync(35_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(deps.appendFill).toHaveBeenCalledWith(
      expect.objectContaining({ filledAvgPrice: null, slippageBps: null, status: "accepted" })
    );
  });
});

describe("which run can be executed", () => {
  // Regression: any runId was accepted, so a past day's decisions could be
  // executed at today's prices — not what was published before that open.
  it("refuses a run other than today's before touching the broker", async () => {
    const { status, json } = await execute({ runId: "2026-08-28" });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid_run");
    expect(deps.placeOrder).not.toHaveBeenCalled();
    expect(deps.getRunState).not.toHaveBeenCalled();
  });

  it("accepts today's run explicitly or by default", async () => {
    expect((await execute({ runId: "2026-09-02" })).status).not.toBe(400);
    expect((await execute({})).status).not.toBe(400);
  });
});
