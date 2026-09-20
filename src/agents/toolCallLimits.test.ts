import { describe, expect, it } from "vitest";
import {
  MAX_PEERS_PER_CALL,
  MAX_RISK_TICKERS,
  MAX_TICKERS_PER_CALL,
  clampToolInput,
  duplicateToolCalls,
} from "./toolCallLimits";

const many = (n: number) => Array.from({ length: n }, (_, i) => `T${i}`);

describe("clampToolInput", () => {
  it("clamps an analyst's ticker fan-out", () => {
    const out = clampToolInput("run_technical_agent", { tickers: many(150), timeframe: "1Y" }) as {
      tickers: string[];
      timeframe: string;
    };
    expect(out.tickers).toHaveLength(MAX_TICKERS_PER_CALL);
    expect(out.timeframe).toBe("1Y");
  });

  it("lets the risk agent cover a real portfolio, up to a hard ceiling", () => {
    const sixty = clampToolInput("run_risk_agent", { tickers: many(60) }, 60) as { tickers: string[] };
    expect(sixty.tickers).toHaveLength(60);
    const huge = clampToolInput("run_risk_agent", { tickers: many(500) }, 500) as { tickers: string[] };
    expect(huge.tickers).toHaveLength(MAX_RISK_TICKERS);
    const noBook = clampToolInput("run_risk_agent", { tickers: many(150) }, 0) as { tickers: string[] };
    expect(noBook.tickers).toHaveLength(MAX_TICKERS_PER_CALL);
  });

  it("clamps peer lists", () => {
    const out = clampToolInput("run_comparables_agent", { ticker: "AAPL", peers: many(40) }) as { peers: string[] };
    expect(out.peers).toHaveLength(MAX_PEERS_PER_CALL);
  });

  it("passes non-object input through and never mutates the original", () => {
    expect(clampToolInput("x", null)).toBeNull();
    expect(clampToolInput("x", "str")).toBe("str");
    const input = { tickers: many(30) };
    clampToolInput("run_news_agent", input);
    expect(input.tickers).toHaveLength(30);
  });
});

describe("duplicateToolCalls", () => {
  it("runs the first call to each analyst and flags the rest", () => {
    const blocks = [
      { id: "a", name: "run_risk_agent" },
      { id: "b", name: "run_news_agent" },
      { id: "c", name: "run_risk_agent" },
      { id: "d", name: "run_risk_agent" },
    ];
    expect([...duplicateToolCalls(blocks)]).toEqual(["c", "d"]);
  });

  it("is empty for a normal round", () => {
    expect(duplicateToolCalls([{ id: "a", name: "x" }, { id: "b", name: "y" }]).size).toBe(0);
  });
});
