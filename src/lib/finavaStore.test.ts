import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  authFetch: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@/lib/authFetch", () => ({
  authFetch: deps.authFetch,
}));
vi.mock("swr", () => ({ mutate: deps.mutate }));

import { getEntry, resetFinava, runFinava, subscribe } from "./finavaStore";

function streamResponse(chunks: string[], ok = true) {
  const encoder = new TextEncoder();
  return {
    ok,
    status: ok ? 200 : 500,
    body: ok
      ? new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        })
      : null,
    json: vi.fn(async () => ({ error: "bad response" })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFinava("AAPL");
  resetFinava("MSFT");
});

describe("finavaStore", () => {
  it("returns a stable idle entry and notifies subscribers on reset", () => {
    const idle = getEntry("NEVER");
    expect(getEntry("NEVER")).toBe(idle);
    const listener = vi.fn();
    const unsubscribe = subscribe("AAPL", listener);

    resetFinava("AAPL");
    unsubscribe();
    resetFinava("AAPL");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getEntry("AAPL")).toMatchObject({ status: "idle", error: null });
  });

  it("parses SSE signals and verdicts into ordered analysis state", async () => {
    deps.authFetch.mockResolvedValueOnce(
      streamResponse([
        'data: {"type":"signal","signal":{"key":"sentiment","label":"Sentiment","score":60,"stance":"bullish","headline":"Good","detail":"ok"}}\n\n',
        'data: {"type":"signal","signal":{"key":"fundamentals","label":"Fundamentals","score":80,"stance":"bullish","headline":"Strong","detail":"ok"}}\n\n',
        'data: {"type":"verdict","verdict":{"score":75,"stance":"Bullish","confidence":"High","fairValue":220,"upsidePct":10,"take":"Good","catalysts":[],"risks":[],"comparison":{},"model":"m"}}\n\n',
      ])
    );

    await runFinava("aapl");

    expect(deps.authFetch).toHaveBeenCalledWith("/api/stock/AAPL/finava-analysis", { method: "POST" });
    expect(getEntry("AAPL")).toMatchObject({
      status: "done",
      error: null,
      analysis: {
        signals: [
          expect.objectContaining({ key: "fundamentals" }),
          expect.objectContaining({ key: "sentiment" }),
        ],
        verdict: expect.objectContaining({ score: 75 }),
      },
    });
  });

  it("records stream errors and allows retry after failures", async () => {
    deps.authFetch.mockResolvedValueOnce(
      streamResponse([
        'data: {"type":"error","message":"Synthesis failed"}\n\n',
      ])
    ).mockResolvedValueOnce(
      streamResponse([
        'data: {"type":"error","message":"Still failed"}\n\n',
      ])
    );

    await runFinava("MSFT");
    await runFinava("MSFT");

    expect(deps.authFetch).toHaveBeenCalledTimes(2);
    expect(getEntry("MSFT")).toMatchObject({ status: "error", error: "Still failed" });
  });

  it("does not rerun completed analyses", async () => {
    deps.authFetch.mockResolvedValueOnce(
      streamResponse([
        'data: {"type":"verdict","verdict":{"score":75,"stance":"Bullish","confidence":"High","fairValue":220,"upsidePct":10,"take":"Good","catalysts":[],"risks":[],"comparison":{},"model":"m"}}\n\n',
      ])
    );

    await runFinava("MSFT");
    await runFinava("MSFT");

    expect(deps.authFetch).toHaveBeenCalledTimes(1);
    expect(getEntry("MSFT")).toMatchObject({ status: "done" });
  });

  it("sets errors for bad HTTP responses, malformed frames, and streams ending without verdict", async () => {
    deps.authFetch.mockResolvedValueOnce(streamResponse([], false));
    await runFinava("AAPL");
    expect(getEntry("AAPL")).toMatchObject({ status: "error", error: "bad response" });

    resetFinava("AAPL");
    deps.authFetch.mockResolvedValueOnce(streamResponse(["data: {not json}\n\n"]));
    await runFinava("AAPL");
    expect(getEntry("AAPL")).toMatchObject({
      status: "error",
      error: "The analysis ended unexpectedly.",
    });

    resetFinava("AAPL");
    deps.authFetch.mockRejectedValueOnce(new Error("network down"));
    await runFinava("AAPL");
    expect(getEntry("AAPL")).toMatchObject({ status: "error", error: "network down" });
  });
  it("revalidates the ticker's facts once a run delivers its verdict", async () => {
    deps.authFetch.mockResolvedValueOnce(
      streamResponse([`data: ${JSON.stringify({ type: "verdict", verdict: { score: 60, stance: "Neutral", confidence: "High", fairValue: null, upsidePct: null, peerPremiumPct: null, take: "t", catalysts: [], risks: [], comparison: { finava: null, street: null, dcf: null } } })}\n\n`])
    );
    await runFinava("AAPL");
    expect(deps.mutate).toHaveBeenCalledTimes(1);
    const matcher = deps.mutate.mock.calls[0][0] as (k: unknown) => boolean;
    expect(matcher("/api/facts/AAPL")).toBe(true);
    expect(matcher("/api/facts/AAPL?cachedOnly=1")).toBe(true);
    expect(matcher("/api/facts/AAPLX")).toBe(false);
    expect(matcher("/api/facts?tickers=AAPL,MSFT")).toBe(true);
    expect(matcher("/api/facts?tickers=AAPLX")).toBe(false);
    expect(matcher("/api/stock/AAPL/verdict")).toBe(false);
    expect(matcher(42)).toBe(false);
  });
});
