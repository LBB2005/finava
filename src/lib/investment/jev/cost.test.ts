import { describe, it, expect } from "vitest";
import {
  createJevBudget,
  emptyJevLedger,
  jevCallCostUsd,
  jevSpendAllowed,
  rateFor,
  JEV_INPUT_USD_PER_TOKEN,
  JEV_PRICE_TABLE,
  type JevPriceTable,
  type JevSpendCaps,
} from "./cost";

const MILLION = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe("rateFor", () => {
  it("prices the alias we request", () => {
    expect(rateFor("jev-latest")?.inputUsdPerToken).toBe(JEV_INPUT_USD_PER_TOKEN);
  });

  it("prices a dated build through its major-version family", () => {
    // The vendor resolves jev-latest to builds we cannot enumerate in advance.
    expect(rateFor("jev-1.13.0")).toEqual(JEV_PRICE_TABLE["jev-1"]);
    expect(rateFor("jev-1.2")).toEqual(JEV_PRICE_TABLE["jev-1"]);
  });

  it("refuses to price a new MAJOR version — a new rate card nobody has read", () => {
    expect(rateFor("jev-2.0.0")).toBeNull();
  });

  it("returns null for a model that is not in the table at all", () => {
    expect(rateFor("some-other-model")).toBeNull();
  });
});

describe("jevCallCostUsd", () => {
  it("charges the verified $0.042 per million input tokens", () => {
    expect(jevCallCostUsd("jev-1.13.0", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(
      0.042,
      12
    );
  });

  it("charges nothing for output tokens, because the verified rate IS zero", () => {
    const inputOnly = jevCallCostUsd("jev-1.13.0", { input_tokens: 120, output_tokens: 0 });
    const withOutput = jevCallCostUsd("jev-1.13.0", { input_tokens: 120, output_tokens: 100_000 });
    expect(withOutput).toBe(inputOnly);
    expect(withOutput).toBeCloseTo(120 * 0.000000042, 15);
  });

  it("returns NULL for an unpriced model — never 0, which would read as free", () => {
    const cost = jevCallCostUsd("jev-2.0.0", MILLION);
    expect(cost).toBeNull();
    expect(cost).not.toBe(0);
  });

  it("takes a configurable table", () => {
    const table: JevPriceTable = { "house-model": { inputUsdPerToken: 1e-6, outputUsdPerToken: 2e-6 } };
    expect(jevCallCostUsd("house-model", { input_tokens: 10, output_tokens: 5 }, table)).toBeCloseTo(
      2e-5,
      12
    );
    // The default table is not consulted as a backstop.
    expect(jevCallCostUsd("jev-latest", MILLION, table)).toBeNull();
  });
});

describe("the ledger", () => {
  it("starts at a known zero — no calls have happened, so $0 is a fact", () => {
    expect(emptyJevLedger()).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      unpricedModels: [],
    });
  });

  it("accumulates priced calls", () => {
    const b = createJevBudget();
    b.reserve();
    b.record("jev-1.13.0", { input_tokens: 1000, output_tokens: 10 });
    b.reserve();
    b.record("jev-1.13.0", { input_tokens: 2000, output_tokens: 20 });

    const l = b.ledger();
    expect(l.calls).toBe(2);
    expect(l.inputTokens).toBe(3000);
    expect(l.outputTokens).toBe(30);
    expect(l.usd).toBeCloseTo(3000 * JEV_INPUT_USD_PER_TOKEN, 15);
    expect(l.unpricedModels).toEqual([]);
  });

  it("goes permanently UNKNOWN once an unpriced call lands, and names the model", () => {
    const b = createJevBudget();
    b.reserve();
    b.record("jev-1.13.0", { input_tokens: 1000, output_tokens: 0 });
    b.reserve();
    b.record("jev-2.0.0", { input_tokens: 5000, output_tokens: 0 });
    b.reserve();
    b.record("jev-1.13.0", { input_tokens: 1000, output_tokens: 0 });

    const l = b.ledger();
    // A total that omits the unpriced call is not this run's total.
    expect(l.usd).toBeNull();
    expect(l.unpricedModels).toEqual(["jev-2.0.0"]);
    // Token accounting keeps working, which is what the caps then rely on.
    expect(l.inputTokens).toBe(7000);
    expect(l.calls).toBe(3);
  });

  it("hands out snapshots, so a caller cannot edit the run's spend", () => {
    const b = createJevBudget();
    const first = b.ledger();
    first.calls = 99;
    first.unpricedModels.push("nonsense");
    expect(b.ledger().calls).toBe(0);
    expect(b.ledger().unpricedModels).toEqual([]);
  });
});

describe("caps", () => {
  const caps: JevSpendCaps = { maxCalls: 3, maxInputTokens: 10_000, maxUsd: 0.001 };

  it("refuses once the request cap is reached", () => {
    const ledger = { ...emptyJevLedger(), calls: 3 };
    const d = jevSpendAllowed(ledger, caps);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("request cap");
  });

  it("refuses once the input-token cap is reached", () => {
    const d = jevSpendAllowed({ ...emptyJevLedger(), inputTokens: 10_000 }, caps);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("input-token cap");
  });

  it("refuses once the dollar cap is reached", () => {
    const d = jevSpendAllowed({ ...emptyJevLedger(), usd: 0.001 }, caps);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("spend cap");
  });

  it("keeps the token and request caps binding while the COST is unknown", () => {
    // usd: null means the dollar cap cannot be evaluated. The run is still bounded.
    const unknownButCheap = { ...emptyJevLedger(), usd: null, calls: 1, inputTokens: 500 };
    expect(jevSpendAllowed(unknownButCheap, caps).ok).toBe(true);

    const unknownAndOverTokens = { ...unknownButCheap, inputTokens: 10_001 };
    const d = jevSpendAllowed(unknownAndOverTokens, caps);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("input-token cap");

    const unknownAndOverCalls = { ...unknownButCheap, calls: 3 };
    expect(jevSpendAllowed(unknownAndOverCalls, caps).ok).toBe(false);
  });

  it("ignores a dollar cap that is not set", () => {
    const d = jevSpendAllowed({ ...emptyJevLedger(), usd: 999 }, { ...caps, maxUsd: null });
    expect(d.ok).toBe(true);
  });

  it("reserves a slot before the call, so concurrent workers cannot share the last one", () => {
    const b = createJevBudget({ maxCalls: 1, maxInputTokens: 10_000, maxUsd: null });
    expect(b.reserve().ok).toBe(true);
    // No tokens have been recorded yet — the second worker is still refused.
    const second = b.reserve();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain("1/1 calls");
    expect(b.ledger().calls).toBe(1);
  });
});
