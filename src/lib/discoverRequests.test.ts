import { describe, expect, it } from "vitest";
import { SYNTH_LIMITS, sanitizeSynthesizeRequest, sanitizeWaveRequest } from "./discoverRequests";

const pick = (ticker: string, extra: Record<string, unknown> = {}) => ({
  ticker,
  name: `${ticker} Inc`,
  sector: "Tech",
  score: 71,
  grade: "B",
  fitRank: 1,
  f: { val: 60, mom: 70 },
  reason: "fits",
  ...extra,
});

describe("sanitizeSynthesizeRequest", () => {
  it("passes a real funnel payload through intact", () => {
    const raw = {
      synthesize: true,
      query: "cheap cloud names",
      picks: [pick("NET", { conviction: "high", pe: 40, marketCap: 3e10, price: 90 }), pick("BRK.B")],
      evidence: {
        waves: [{ waveIndex: 0, tickers: ["NET"], valuationTickers: ["NET"], batch: { risk: "low" }, valuation: { NET: { dcf: "fair" } } }],
        valuation: { NET: { dcf: "fair" } },
      },
    };
    expect(sanitizeSynthesizeRequest(raw)).toEqual(raw);
  });

  it("clamps every attacker-sized string and list", () => {
    const huge = "x".repeat(1_000_000);
    const out = sanitizeSynthesizeRequest({
      synthesize: true,
      query: huge,
      picks: Array.from({ length: 500 }, () => pick("AAPL", { reason: huge, name: huge, sector: huge })),
      evidence: {
        waves: Array.from({ length: 50 }, (_, i) => ({
          waveIndex: i,
          tickers: ["AAPL"],
          valuationTickers: [],
          batch: Object.fromEntries(Array.from({ length: 50 }, (_, j) => [`agent${j}`, huge])),
          valuation: {},
        })),
        valuation: {},
      },
    })!;
    expect(out.query.length).toBe(SYNTH_LIMITS.query);
    expect(out.picks.length).toBe(SYNTH_LIMITS.picks);
    expect(out.picks[0].reason.length).toBe(SYNTH_LIMITS.reason);
    expect(out.evidence.waves.length).toBe(SYNTH_LIMITS.waves);
    const evidenceChars = out.evidence.waves
      .flatMap((w) => Object.values(w.batch))
      .reduce((n, s) => n + s.length, 0);
    expect(evidenceChars).toBeLessThanOrEqual(SYNTH_LIMITS.evidenceTotal);
  });

  // Regression: `valuation: { X: null }` made synthesis throw after the draft,
  // skipping the (metered) skeptic pass.
  it("normalises malformed evidence maps instead of letting them crash synthesis", () => {
    const out = sanitizeSynthesizeRequest({
      synthesize: true,
      query: "q",
      picks: [pick("AAPL")],
      evidence: { waves: [null, { waveIndex: "x" }, { waveIndex: 0, batch: null }], valuation: { ZZZ: null, "bad key!": { a: "b" } } },
    })!;
    expect(out.evidence.valuation).toEqual({ ZZZ: {} });
    expect(out.evidence.waves).toEqual([{ waveIndex: 0, tickers: [], valuationTickers: [], batch: {}, valuation: {} }]);
  });

  it("drops picks without a valid ticker and rejects a request with nothing to rank", () => {
    expect(sanitizeSynthesizeRequest({ synthesize: true, query: "q", picks: [pick("../x"), { ticker: 5 }] })).toBeNull();
    expect(sanitizeSynthesizeRequest({ synthesize: true, query: "", picks: [pick("AAPL")] })).toBeNull();
    expect(sanitizeSynthesizeRequest({ query: "q", picks: [pick("AAPL")] })).toBeNull();
  });
});

describe("sanitizeWaveRequest", () => {
  const wave = { tickers: ["AAPL", "MSFT"], sectors: ["Tech"], waveIndex: 0, totalWaves: 2, valuationTickers: ["AAPL"] };

  it("keeps a real wave and never forwards a client-chosen crew", () => {
    const out = sanitizeWaveRequest({ ...wave, agents: { batch: Array(100).fill("risk"), valuation: ["dcf"] } });
    expect(out).toEqual(wave);
    expect(out).not.toHaveProperty("agents");
  });

  it("rejects an oversized or malformed wave rather than truncating it", () => {
    expect(sanitizeWaveRequest({ ...wave, tickers: ["A", "B", "C", "D", "E", "F"] })).toBeNull();
    expect(sanitizeWaveRequest({ ...wave, tickers: [] })).toBeNull();
    expect(sanitizeWaveRequest({ ...wave, waveIndex: -1 })).toBeNull();
    expect(sanitizeWaveRequest({ ...wave, totalWaves: 0 })).toBeNull();
    expect(sanitizeWaveRequest({ ...wave, synthesize: true })).toBeNull();
  });

  it("caps valuation tickers and sector strings", () => {
    const out = sanitizeWaveRequest({ ...wave, valuationTickers: ["A", "B", "C", "D"], sectors: ["x".repeat(500)] })!;
    expect(out.valuationTickers).toHaveLength(3);
    expect(out.sectors[0].length).toBe(SYNTH_LIMITS.sector);
  });
});
