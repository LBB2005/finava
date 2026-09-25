import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentEvent } from "@/types/chat";
import { SCOUT_NO_MATCHES_LABEL } from "./scout-fallback";

// ── Boundary mocks ───────────────────────────────────────────────────────────
const generate = vi.fn();
vi.mock("@/lib/llm", () => ({ generate: (o: unknown) => generate(o) }));
vi.mock("@/agents/skills", () => ({ getSkillsPrompt: () => "skill prompt" }));

const getFactorUniverse = vi.fn();
vi.mock("@/lib/factorUniverse", () => ({ getFactorUniverse: () => getFactorUniverse() }));

const ranked = vi.fn();
vi.mock("@/lib/research", () => ({ ranked: (...a: unknown[]) => ranked(...a) }));

const coerceFilter = vi.fn();
const applyScreen = vi.fn();
vi.mock("@/lib/screen", () => ({
  coerceFilter: (raw: unknown) => coerceFilter(raw),
  applyScreen: (...a: unknown[]) => applyScreen(...a),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────
type Stock = {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  chg: number;
  f: { mom: number; growth: number; quality: number; analyst: number; value: number; health: number };
  mv: Record<string, number>;
  marketCap?: number | null;
  pe?: number | null;
  score: number;
  grade: string;
  rank: number;
};

function stock(over: Partial<Stock> & { ticker: string; score: number }): Stock {
  return {
    name: `${over.ticker} Inc`,
    sector: "Technology",
    price: 100,
    chg: 0,
    f: { mom: 50, growth: 50, quality: 50, analyst: 50, value: 50, health: 50 },
    mv: { week: 0, month: 0, year: 0 },
    marketCap: 5e9,
    pe: 20,
    grade: "B",
    rank: 1,
    ...over,
  } as Stock;
}

const POOL: Stock[] = [
  stock({ ticker: "ABC", score: 80, grade: "A", name: "Abacus Co", sector: "Healthcare", price: 40, marketCap: 8e9, pe: 15 }),
  stock({ ticker: "DEF", score: 60, grade: "B", name: "Delta Co", sector: "Energy", price: 25, marketCap: 3e9 }),
  stock({ ticker: "GHI", score: 30, grade: "D", name: "Gamma Co", sector: "Technology", price: 200, marketCap: 1.2e12, pe: 0 }),
  stock({ ticker: "JKL", score: 50, grade: "C", name: "Juno Co", sector: "Financials", price: 75 }),
];

function universe(stocks: Stock[] = POOL) {
  return {
    stocks,
    asOf: "2026-06-16",
    coverage: { total: stocks.length, fundamentals: stocks.length, analyst: stocks.length, momentum: stocks.length, priced: stocks.length },
  };
}

function collect() {
  const events: AgentEvent[] = [];
  return { emit: (e: AgentEvent) => events.push(e), events };
}

beforeEach(() => {
  generate.mockReset();
  getFactorUniverse.mockReset().mockResolvedValue(universe());
  ranked.mockReset().mockImplementation((_h: string, stocks: Stock[]) => stocks);
  coerceFilter.mockReset().mockReturnValue({});
  applyScreen.mockReset().mockReturnValue([]);
  // Default LLM behaviour: screenParse returns no filter, scoutSelect picks ABC+DEF.
  generate.mockImplementation(async (o: { agent: string }) => {
    if (o.agent === "screenParse") return JSON.stringify({ filter: {}, interpretation: "Looking for tech value." });
    return JSON.stringify({
      layout: "tiers",
      picks: [
        { ticker: "ABC", conviction: "high", reason: "cheap healthcare leader" },
        { ticker: "DEF", conviction: "wildcard", reason: "under-followed energy" },
      ],
    });
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("runScoutAgent — clarify gate", () => {
  it("emits discover_clarify for an empty query and returns a clarify instruction", async () => {
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    const out = await runScoutAgent({ query: "" }, emit);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("discover_clarify");
    const { questions } = events[0] as { questions: { header: string; options: { label: string; description?: string }[] }[] };
    expect(questions).toHaveLength(1);
    expect(questions[0].options.length).toBeGreaterThanOrEqual(2);
    // Every option says what picking it means.
    expect(questions[0].options.every((o) => !!o.description)).toBe(true);
    expect(out).toContain("clarifying question");
    // No universe scan / LLM ranking happened.
    expect(getFactorUniverse).not.toHaveBeenCalled();
  });

  it("clarifies a short signal-less query", async () => {
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "what should I buy" }, emit);
    expect(events[0].type).toBe("discover_clarify");
  });

  it("does NOT clarify when the query carries a sector/style signal", async () => {
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "cheap energy" }, emit);
    expect(events.some((e) => e.type === "discover_clarify")).toBe(false);
    expect(events.some((e) => e.type === "scout_complete")).toBe(true);
  });
});

describe("runScoutAgent — quick tier ranking", () => {
  it("emits scout_complete with validated, ordered picks and returns a recommendation string", async () => {
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    const out = await runScoutAgent({ query: "cheap value names", tier: "quick" }, emit);

    const ev = events.find((e) => e.type === "scout_complete") as
      | { type: "scout_complete"; picks: Array<{ ticker: string; fitRank: number; conviction: string }>; interpretation: string; layout: string }
      | undefined;
    expect(ev).toBeTruthy();
    expect(ev!.picks.map((p) => p.ticker)).toEqual(["ABC", "DEF"]);
    expect(ev!.picks[0].fitRank).toBe(1);
    expect(ev!.picks[1].fitRank).toBe(2);
    expect(ev!.picks[0].conviction).toBe("high");
    expect(ev!.picks[1].conviction).toBe("wildcard");
    expect(ev!.interpretation).toBe("Looking for tech value.");
    expect(ev!.layout).toBe("tiers");

    expect(out).toContain("ABC");
    expect(out).toContain("DEF");
    expect(out).toContain("chart"); // bar-chart instruction
  });

  it("drops unknown tickers and de-dupes repeats from the LLM", async () => {
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: {} });
      return JSON.stringify({
        layout: "tiers",
        picks: [
          { ticker: "ABC", conviction: "high", reason: "x" },
          { ticker: "ZZZ", conviction: "high", reason: "not in universe" },
          { ticker: "abc", conviction: "look", reason: "dupe lowercase" },
        ],
      });
    });
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "value energy", tier: "quick" }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as { picks: Array<{ ticker: string }> };
    expect(ev.picks.map((p) => p.ticker)).toEqual(["ABC"]);
  });

  it("derives conviction from score when the LLM omits/invalidates it", async () => {
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: {} });
      return JSON.stringify({
        layout: "tiers",
        picks: [
          { ticker: "ABC", reason: "no conviction field" }, // score 80 → high
          { ticker: "JKL", conviction: "bogus", reason: "bad band" }, // score 50 → look
          { ticker: "GHI", reason: "low" }, // score 30 → wildcard
        ],
      });
    });
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "growth tech", tier: "quick" }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as { picks: Array<{ ticker: string; conviction: string }> };
    const byTicker = Object.fromEntries(ev.picks.map((p) => [p.ticker, p.conviction]));
    expect(byTicker.ABC).toBe("high");
    expect(byTicker.JKL).toBe("look");
    expect(byTicker.GHI).toBe("wildcard");
  });

  it("caps picks at the conviction ceiling (limit)", async () => {
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: {} });
      return JSON.stringify({
        layout: "tiers",
        picks: POOL.map((s) => ({ ticker: s.ticker, conviction: "look", reason: "r" })),
      });
    });
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "value names", tier: "quick", limit: 2 }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as { picks: unknown[] };
    expect(ev.picks).toHaveLength(2);
  });
});

describe("runScoutAgent — deep tier", () => {
  it("emits deep_shortlist and returns a deep-dive instruction listing the tickers", async () => {
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    const out = await runScoutAgent({ query: "quality compounders in tech", tier: "deep" }, emit);
    const ev = events.find((e) => e.type === "deep_shortlist") as
      | { type: "deep_shortlist"; picks: Array<{ ticker: string }>; query: string }
      | undefined;
    expect(ev).toBeTruthy();
    expect(ev!.query).toBe("quality compounders in tech");
    expect(ev!.picks.map((p) => p.ticker)).toEqual(["ABC", "DEF"]);
    expect(out).toContain("deep-diving");
    expect(out).toContain("ABC");
    // no scout_complete on deep
    expect(events.some((e) => e.type === "scout_complete")).toBe(false);
  });
});

describe("runScoutAgent — hard screen filter", () => {
  it("applies a hard sector/price screen and forces the ranked layout", async () => {
    coerceFilter.mockReturnValue({ sectors: ["Healthcare"], maxPrice: 50 });
    const survivors = [POOL[0]]; // ABC survives
    applyScreen.mockReturnValue(survivors);
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse")
        return JSON.stringify({ filter: { sectors: ["Healthcare"], maxPrice: 50 }, interpretation: "Healthcare under $50." });
      // LLM omits a layout → falls back to the hadHardConstraints default ("ranked").
      return JSON.stringify({ picks: [{ ticker: "ABC", conviction: "high", reason: "fits screen" }] });
    });
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "healthcare under $50", tier: "quick" }, emit);

    expect(applyScreen).toHaveBeenCalled();
    const passedFilter = applyScreen.mock.calls[0][1] as { sectors: string[]; maxPrice: number };
    expect(passedFilter.sectors).toContain("Healthcare");
    expect(passedFilter.maxPrice).toBe(50);

    const ev = events.find((e) => e.type === "scout_complete") as { layout: string; picks: Array<{ ticker: string }> };
    expect(ev.layout).toBe("ranked");
    expect(ev.picks.map((p) => p.ticker)).toEqual(["ABC"]);
  });

  it("merges the explicit sector arg into the hard constraints", async () => {
    coerceFilter.mockReturnValue({});
    applyScreen.mockReturnValue([POOL[1]]);
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: {} });
      return JSON.stringify({ picks: [{ ticker: "DEF", conviction: "look", reason: "r" }] });
    });
    const { emit } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "best energy ideas", sector: "Energy", tier: "quick" }, emit);
    const passedFilter = applyScreen.mock.calls[0][1] as { sectors: string[] };
    expect(passedFilter.sectors).toContain("Energy");
  });

  it("returns no names — not the whole universe — when a hard filter matches nothing", async () => {
    coerceFilter.mockReturnValue({ sectors: ["Utilities"] });
    applyScreen.mockReturnValue([]); // nothing in the universe is a Utility
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    const out = await runScoutAgent({ query: "defensive utilities", tier: "quick" }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as {
      picks: Array<{ ticker: string }>;
      interpretation: string;
    };
    // The old behaviour surfaced ABC (Healthcare) and DEF (Energy) here.
    expect(ev.picks).toEqual([]);
    expect(ev.interpretation).toBe(SCOUT_NO_MATCHES_LABEL);
    // The narrator must not be handed a ticker it could present as a match.
    for (const t of ["ABC", "DEF", "GHI", "JKL"]) expect(out).not.toContain(t);
  });
});

describe("runScoutAgent — hard constraints are non-negotiable", () => {
  // The scout validated LLM picks against the FULL universe, so a model pick
  // outside the screened pool was accepted and shown as a match.
  it("rejects an LLM pick that is outside the eligible pool", async () => {
    coerceFilter.mockReturnValue({ sectors: ["Healthcare"], maxPrice: 50 });
    applyScreen.mockReturnValue([POOL[0]]); // only ABC is eligible
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse")
        return JSON.stringify({ filter: { sectors: ["Healthcare"], maxPrice: 50 } });
      // DEF is Energy at $25 — it fails the sector filter.
      return JSON.stringify({
        picks: [
          { ticker: "DEF", conviction: "high", reason: "out of pool" },
          { ticker: "ABC", conviction: "look", reason: "fits screen" },
        ],
      });
    });
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "healthcare under $50", tier: "quick" }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as { picks: Array<{ ticker: string }> };
    expect(ev.picks.map((p) => p.ticker)).toEqual(["ABC"]);
  });

  it("honours a 3-survivor screen instead of reverting to the full universe", async () => {
    // poolFloor was min(QUICK_MAX, 4) = 4, so three survivors silently lost the filter.
    const survivors = [POOL[0], POOL[1], POOL[3]];
    coerceFilter.mockReturnValue({ minMarketCap: 1e9 });
    applyScreen.mockReturnValue(survivors);
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: { minMarketCap: 1e9 } });
      // GHI is in the universe but NOT among the survivors.
      return JSON.stringify({ picks: [{ ticker: "GHI", conviction: "high", reason: "mega cap" }] });
    });
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "large caps over $1B", tier: "quick" }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as { picks: Array<{ ticker: string }> };
    expect(ev.picks.map((p) => p.ticker)).not.toContain("GHI");
  });

  it("does not truncate the eligible pool below the universe size", async () => {
    // A hard-coded limit of 200 silently dropped names from a 537-symbol universe
    // before eligibility was even known.
    // A 250-name universe exceeds the old hard-coded limit of 200.
    const big = Array.from({ length: 250 }, (_, i) =>
      stock({ ticker: `T${i}`, score: 50, sector: "Healthcare" })
    );
    getFactorUniverse.mockResolvedValue(universe(big));
    coerceFilter.mockReturnValue({ sectors: ["Healthcare"] });
    applyScreen.mockReturnValue([big[0]]);
    const { emit } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "healthcare names", tier: "quick" }, emit);
    const passed = applyScreen.mock.calls[0][1] as { limit?: number };
    expect(passed.limit ?? 0).toBeGreaterThanOrEqual(big.length);
  });

  it("keeps the deterministic fallback inside the eligible pool", async () => {
    coerceFilter.mockReturnValue({ sectors: ["Healthcare"], maxPrice: 50 });
    applyScreen.mockReturnValue([POOL[0]]); // ABC only
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse")
        return JSON.stringify({ filter: { sectors: ["Healthcare"], maxPrice: 50 } });
      throw new Error("scoutSelect down");
    });
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "healthcare under $50", tier: "quick" }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as { picks: Array<{ ticker: string }> };
    expect(ev.picks.map((p) => p.ticker)).toEqual(["ABC"]);
  });
});

describe("runScoutAgent — fallback / guard branches", () => {
  it("falls back to the highest factor scores when scoutSelect throws, labelled honestly", async () => {
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: {} });
      throw new Error("402 Insufficient credits");
    });
    const { emit, events } = collect();
    const { runScoutAgent, SCOUT_UNAVAILABLE_LABEL } = await import("./scout-agent");
    await runScoutAgent({ query: "value tech names", tier: "quick", limit: 3 }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as {
      picks: Array<{ ticker: string; reason: string }>;
      interpretation: string;
    };
    // Highest overall score first (ABC 80, DEF 60, JKL 50) — not pool order — so
    // the label's claim is literally true.
    expect(ev.picks.map((p) => p.ticker)).toEqual(["ABC", "DEF", "JKL"]);
    expect(SCOUT_UNAVAILABLE_LABEL).toBe(
      "Scout unavailable — showing today's highest overall factor scores, not a match for your request",
    );
    for (const pick of ev.picks) expect(pick.reason).toBe(SCOUT_UNAVAILABLE_LABEL);
    expect(ev.interpretation).toBe(SCOUT_UNAVAILABLE_LABEL);
    expect(JSON.stringify(events)).not.toMatch(/Top factor fit|402|credits/);
  });

  it("tells the narrator exactly that the picks are a fallback, not a selection", async () => {
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: {} });
      throw new Error("LLM down");
    });
    const { emit } = collect();
    const { runScoutAgent, SCOUT_UNAVAILABLE_LABEL } = await import("./scout-agent");
    const out = await runScoutAgent({ query: "value tech names", tier: "quick", limit: 2 }, emit);

    expect(out).not.toMatch(/selected EXACTLY/);
    expect(out).not.toMatch(/fit:/);
    expect(out).toContain(`${SCOUT_UNAVAILABLE_LABEL}.`);
    expect(out).toContain("Say this plainly");
    expect(out).toContain("1. ABC");
    expect(out).toContain("2. DEF");
  });

  it("labels a deep-tier fallback shortlist the same way", async () => {
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: {} });
      throw new Error("LLM down");
    });
    const { emit, events } = collect();
    const { runScoutAgent, SCOUT_UNAVAILABLE_LABEL } = await import("./scout-agent");
    const out = await runScoutAgent({ query: "quality compounders in tech", tier: "deep", limit: 2 }, emit);
    const ev = events.find((e) => e.type === "deep_shortlist") as { picks: Array<{ reason: string }> };
    expect(ev.picks[0].reason).toBe(SCOUT_UNAVAILABLE_LABEL);
    expect(out).toContain(SCOUT_UNAVAILABLE_LABEL);
  });

  it("says so when the fallback honoured the user's hard limits", async () => {
    coerceFilter.mockReturnValue({ sectors: ["Healthcare"] });
    applyScreen.mockReturnValue([POOL[3], POOL[0]]); // survivors, unsorted
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: { sectors: ["Healthcare"] } });
      throw new Error("LLM down");
    });
    const { emit, events } = collect();
    const { runScoutAgent, SCOUT_UNAVAILABLE_FILTERED_LABEL } = await import("./scout-agent");
    await runScoutAgent({ query: "healthcare names", tier: "quick", limit: 2 }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as { picks: Array<{ ticker: string; reason: string }> };
    expect(ev.picks.map((p) => p.ticker)).toEqual(["ABC", "JKL"]);
    expect(ev.picks[0].reason).toBe(SCOUT_UNAVAILABLE_FILTERED_LABEL);
  });

  it("falls back when the LLM returns unparseable JSON", async () => {
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") return JSON.stringify({ filter: {} });
      return "not json at all";
    });
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "value tech names", tier: "quick", limit: 2 }, emit);
    const ev = events.find((e) => e.type === "scout_complete") as { picks: Array<{ ticker: string }> };
    expect(ev.picks.map((p) => p.ticker)).toEqual(["ABC", "DEF"]);
  });

  it("recovers from a screenParse failure and still ranks the full universe", async () => {
    generate.mockImplementation(async (o: { agent: string }) => {
      if (o.agent === "screenParse") throw new Error("screen parse failed");
      return JSON.stringify({ layout: "tiers", picks: [{ ticker: "ABC", conviction: "high", reason: "r" }] });
    });
    const { emit, events } = collect();
    const { runScoutAgent } = await import("./scout-agent");
    await runScoutAgent({ query: "growth tech names", tier: "quick" }, emit);
    expect(applyScreen).not.toHaveBeenCalled();
    const ev = events.find((e) => e.type === "scout_complete") as { picks: Array<{ ticker: string }> };
    expect(ev.picks.map((p) => p.ticker)).toEqual(["ABC"]);
  });
});
