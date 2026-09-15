import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  cacheDocs: new Map<string, Record<string, unknown>>(),
  memoryDocs: [] as Array<Record<string, unknown>>,
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDelete: vi.fn(),
  batchSet: vi.fn(),
  batchDelete: vi.fn(),
  batchCommit: vi.fn(),
  autoId: 0,
}));

// firebase-admin: only firestore.Timestamp is used by agentMemory (for the TTL
// field written to agentCache). Provide a minimal Timestamp stand-in.
vi.mock("firebase-admin", () => {
  class Timestamp {
    constructor(public _ms: number) {}
    static fromDate(d: Date) {
      return new Timestamp(d.getTime());
    }
    toDate() {
      return new Date(this._ms);
    }
  }
  return { firestore: { Timestamp } };
});

// In-memory tickerMemory query builder supporting where(==/in) + orderBy + limit
// + get + count, plus collection.doc() for batched writes.
function makeTickerQuery(filter: { in?: string[]; eq?: string; userIdEq?: string }) {
  const matching = () =>
    deps.memoryDocs
      .map((data, idx) => ({ data, idx }))
      .filter(({ data }) => {
        if (filter.userIdEq != null && data.userId !== filter.userIdEq) return false;
        const t = data.ticker as string;
        if (filter.eq != null) return t === filter.eq;
        if (filter.in != null) return filter.in.includes(t);
        return true;
      });

  const snapshot = (dir: "asc" | "desc", limitN?: number) => {
    const sorted = matching().sort((a, b) => {
      const av = String(a.data.createdAt);
      const bv = String(b.data.createdAt);
      return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    const sliced = limitN == null ? sorted : sorted.slice(0, limitN);
    return {
      size: sliced.length,
      docs: sliced.map(({ data, idx }) => ({
        id: `mem_${idx}`,
        data: () => data,
        ref: { id: `mem_${idx}` },
      })),
    };
  };

  return {
    where: (field: string, op: string, val: string | string[]) => {
      if (field === "userId") return makeTickerQuery({ ...filter, userIdEq: val as string });
      return op === "in"
        ? makeTickerQuery({ ...filter, in: val as string[] })
        : makeTickerQuery({ ...filter, eq: val as string });
    },
    orderBy: (_field: string, dir: "asc" | "desc") => ({
      limit: (n: number) => ({ get: vi.fn(async () => snapshot(dir, n)) }),
      get: vi.fn(async () => snapshot(dir)),
    }),
    count: () => ({
      get: vi.fn(async () => ({ data: () => ({ count: matching().length }) })),
    }),
    doc: vi.fn(() => ({ id: `mem_new_${deps.autoId++}` })),
  };
}

vi.mock("@/lib/firebase-admin", () => ({
  db: {
    batch: vi.fn(() => ({
      set: deps.batchSet,
      delete: deps.batchDelete,
      commit: deps.batchCommit,
    })),
    collection: vi.fn((name: string) => {
      if (name === "agentCache") {
        return {
          doc: vi.fn((key: string) => ({
            get: deps.cacheGet.mockImplementation(async () => {
              const row = deps.cacheDocs.get(key);
              return { exists: !!row, data: () => row };
            }),
            set: deps.cacheSet.mockImplementation(async (row) => {
              deps.cacheDocs.set(key, row);
            }),
            delete: deps.cacheDelete.mockResolvedValue(undefined),
          })),
        };
      }
      if (name === "tickerMemory") {
        return makeTickerQuery({});
      }
      throw new Error(`unexpected collection ${name}`);
    }),
  },
}));

import {
  checkCache,
  extractTickers,
  getTickerMemory,
  isCacheableResult,
  saveCache,
  saveTickerMemory,
} from "./agentMemory";
import { withAsOfScope, currentAsOf } from "./asOfScope";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  vi.clearAllMocks();
  deps.cacheDocs = new Map();
  deps.memoryDocs = [];
  deps.autoId = 0;
  deps.batchCommit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agent result cache", () => {
  it("builds stable cache keys independent of object key and array order", async () => {
    await saveCache("run_dcf_agent", { tickers: ["MSFT", "AAPL"], nested: { b: 2, a: 1 } }, "first");
    const savedKey = [...deps.cacheDocs.keys()][0];
    deps.cacheDocs.set(savedKey, {
      result: "cached",
      expiresAt: "2026-06-15T13:00:00.000Z",
    });

    await expect(
      checkCache("run_dcf_agent", { nested: { a: 1, b: 2 }, tickers: ["AAPL", "MSFT"] })
    ).resolves.toBe("cached");
  });

  it("uses agent-specific TTLs and default TTLs, storing expiresAt as a Timestamp", async () => {
    await saveCache("run_dcf_agent", { ticker: "AAPL" }, "dcf");
    await saveCache("custom_agent", { ticker: "AAPL" }, "custom");

    const rows = [...deps.cacheDocs.values()];
    const iso = (v: unknown) => (v as { toDate: () => Date }).toDate().toISOString();

    expect(rows[0]).toMatchObject({ agentName: "run_dcf_agent", result: "dcf" });
    // 48h TTL for the DCF agent.
    expect(iso(rows[0].expiresAt)).toBe("2026-06-17T12:00:00.000Z");
    expect(iso(rows[0].createdAt)).toBe("2026-06-15T12:00:00.000Z");

    expect(rows[1]).toMatchObject({ agentName: "custom_agent", result: "custom" });
    // 6h default TTL for unknown agents.
    expect(iso(rows[1].expiresAt)).toBe("2026-06-15T18:00:00.000Z");
  });

  it("treats expired cache entries as a miss without deleting, and swallows Firestore errors", async () => {
    await saveCache("run_news_agent", { ticker: "AAPL" }, "old");
    const savedKey = [...deps.cacheDocs.keys()][0];
    deps.cacheDocs.set(savedKey, { result: "old", expiresAt: "2026-06-15T11:59:59.000Z" });

    await expect(checkCache("run_news_agent", { ticker: "AAPL" })).resolves.toBeNull();
    // Native TTL reclaims expired rows — no application-side delete write.
    expect(deps.cacheDelete).not.toHaveBeenCalled();

    deps.cacheGet.mockRejectedValueOnce(new Error("firestore down"));
    await expect(checkCache("run_news_agent", { ticker: "AAPL" })).resolves.toBeNull();
  });
});

describe("never cache failures", () => {
  // A swallowed provider failure used to be cached for 4–48h and served to every
  // user as if it were the analysis. Only a real, non-empty result may be written.
  it.each([
    ["empty", ""],
    ["whitespace", "   \n "],
    ["an Error: string from the wave runner", "Error: [llm:news] request failed (status 402)"],
    ["the news agent's no-data line", "NEWS DATA UNAVAILABLE for AAPL (last 7 days): Finnhub returned no articles and web research was unavailable."],
    ["the hype agent's fetch failure", "HYPE SCORE: N/A\n\nError fetching hype data: Perplexity 401"],
    ["a missing key", "HYPE SCORE: N/A\n\nPerplexity API key not configured. Add PERPLEXITY_API_KEY to .env.local"],
    ["the sentiment search failure", "Perplexity search unavailable: Perplexity 429: rate limited"],
    ["the fundamentals retrieval failure", "Unable to retrieve multi-year fundamental data for XYZ. The company may not file with SEC EDGAR or data may be unavailable."],
    ["a raw vendor billing error", "402 Insufficient credits. Add more using https://openrouter.ai/settings/credits"],
  ])("does not write %s", async (_label, result) => {
    await saveCache("run_news_agent", { ticker: "AAPL" }, result);
    expect(deps.cacheSet).not.toHaveBeenCalled();
    expect(isCacheableResult(result)).toBe(false);
  });

  it("still writes a real result that mentions an Unavailable metric", async () => {
    // DATA_ACCURACY_RULE tells agents to write "Unavailable" for a missing field,
    // so that word alone must not block an otherwise-good result.
    const good = "## Valuation\n| Metric | Value |\n| Forward P/E | Unavailable |\n| P/S | 12.4 |";
    await saveCache("run_dcf_agent", { ticker: "AAPL" }, good);
    expect(deps.cacheSet).toHaveBeenCalledOnce();
  });

  it("does not cache when the provider fetch itself failed (handler rejected)", async () => {
    // The call-site contract (ceo.ts / discovery.ts / briefing): saveCache only
    // runs after the handler resolves. Model that here end to end.
    const failingFetch = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const run = async () => {
      const result = await failingFetch();
      await saveCache("run_news_agent", { ticker: "AAPL" }, result);
    };
    await expect(run()).rejects.toThrow("fetch failed");
    expect(deps.cacheSet).not.toHaveBeenCalled();
  });
});

describe("ticker memory", () => {
  it("extracts likely tickers while filtering finance and common-word blocklist terms", () => {
    expect(
      extractTickers("Compare $AAPL and MSFT versus ETF exposure, CPI, DCF, and CEO commentary.")
    ).toEqual(["AAPL", "MSFT"]);
  });

  it("formats recent ticker insights for CEO prompt injection", async () => {
    deps.memoryDocs = [
      {
        userId: "u1",
        ticker: "AAPL",
        insight: "AAPL trades above the last DCF range.",
        source: "ceo",
        createdAt: "2026-06-10T00:00:00.000Z",
      },
      {
        userId: "u1",
        ticker: "MSFT",
        insight: "MSFT margins remain resilient.",
        createdAt: { toDate: () => new Date("2026-06-12T00:00:00.000Z") },
      },
    ];

    await expect(getTickerMemory("u1", ["aapl", "MSFT"])).resolves.toContain(
      "[AAPL · 2026-06-10 · ceo] AAPL trades above the last DCF range."
    );
    await expect(getTickerMemory("u1", ["aapl", "MSFT"])).resolves.toContain(
      "[MSFT · 2026-06-12] MSFT margins remain resilient."
    );
    await expect(getTickerMemory("u1", [])).resolves.toBe("");
  });

  it("withholds insights written after the recall cutoff", async () => {
    // The look-ahead case: replaying 2026-06-11 must not surface an insight
    // written on the 12th, however true it turned out to be.
    deps.memoryDocs = [
      {
        userId: "u1",
        ticker: "AAPL",
        insight: "Known before the decision.",
        createdAt: "2026-06-10T00:00:00.000Z",
      },
      {
        userId: "u1",
        ticker: "AAPL",
        insight: "Written the day after.",
        createdAt: "2026-06-12T00:00:00.000Z",
      },
    ];

    const recalled = await withAsOfScope("2026-06-11T00:00:00.000Z", () =>
      getTickerMemory("u1", ["AAPL"])
    );
    expect(recalled).toContain("Known before the decision.");
    expect(recalled).not.toContain("Written the day after.");
  });

  it("keeps an insight written exactly at the cutoff", async () => {
    deps.memoryDocs = [
      {
        userId: "u1",
        ticker: "AAPL",
        insight: "Right on the boundary.",
        createdAt: "2026-06-11T00:00:00.000Z",
      },
    ];
    const recalled = await withAsOfScope("2026-06-11T00:00:00.000Z", () =>
      getTickerMemory("u1", ["AAPL"])
    );
    expect(recalled).toContain("Right on the boundary.");
  });

  it("recalls everything outside a scoped run — a chat has no future to leak from", async () => {
    deps.memoryDocs = [
      {
        userId: "u1",
        ticker: "AAPL",
        insight: "Written the day after.",
        createdAt: "2026-06-12T00:00:00.000Z",
      },
    ];
    expect(currentAsOf()).toBeNull();
    await expect(getTickerMemory("u1", ["AAPL"])).resolves.toContain(
      "Written the day after."
    );
  });

  it("withholds a row whose createdAt cannot be read at all", async () => {
    // An undatable row cannot be shown to predate the cutoff. Losing a row beats
    // a decision citing one it could not have known.
    deps.memoryDocs = [
      { userId: "u1", ticker: "AAPL", insight: "Undatable.", createdAt: 12345 },
    ];
    const recalled = await withAsOfScope("2026-06-11T00:00:00.000Z", () =>
      getTickerMemory("u1", ["AAPL"])
    );
    expect(recalled).toBe("");
  });

  it("saves parsed insights in one batch and prunes the oldest beyond the cap", async () => {
    deps.memoryDocs = Array.from({ length: 15 }, (_, i) => ({
      userId: "u1",
      ticker: "AAPL",
      insight: `old ${i}`,
      createdAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    const anthropicClient = {
      messages: {
        create: vi.fn(async () => ({
          content: [
            {
              type: "text",
              text: "AAPL: DCF fair value is still below spot.\nMSFT: Azure growth supports margins.\nTSLA: ignored",
            },
          ],
        })),
      },
    };

    await saveTickerMemory("u1", ["AAPL", "MSFT"], "analysis text", anthropicClient as never);

    // Adds go through a single batched write, not per-line add() calls, and each
    // row is stamped with the owning userId.
    expect(deps.batchSet).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      ticker: "AAPL",
      insight: "DCF fair value is still below spot.",
      source: null,
      createdAt: "2026-06-15T12:00:00.000Z",
    });
    expect(deps.batchSet).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      ticker: "MSFT",
      insight: "Azure growth supports margins.",
      source: null,
      createdAt: "2026-06-15T12:00:00.000Z",
    });
    // AAPL had 15 rows; adding 1 forces exactly one prune-delete. One commit total.
    expect(deps.batchDelete).toHaveBeenCalledTimes(1);
    expect(deps.batchCommit).toHaveBeenCalledTimes(1);
  });

  it("skips memory saves when there is no ticker or response body", async () => {
    const anthropicClient = { messages: { create: vi.fn() } };

    await saveTickerMemory("u1", [], "analysis", anthropicClient as never);
    await saveTickerMemory("u1", ["AAPL"], "", anthropicClient as never);

    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  it("scopes reads to the user — never returns another user's insights", async () => {
    deps.memoryDocs = [
      {
        userId: "u1",
        ticker: "AAPL",
        insight: "AAPL is user one's private read.",
        createdAt: "2026-06-10T00:00:00.000Z",
      },
    ];

    // Same ticker, different user → no cross-user leak (this is the fix for the
    // global-tickerMemory disclosure/prompt-injection finding).
    await expect(getTickerMemory("u2", ["AAPL"])).resolves.toBe("");
    await expect(getTickerMemory("u1", ["AAPL"])).resolves.toContain(
      "AAPL is user one's private read."
    );
  });

  it("skips reads and writes when no userId is supplied", async () => {
    const anthropicClient = { messages: { create: vi.fn() } };
    await expect(getTickerMemory("", ["AAPL"])).resolves.toBe("");
    await saveTickerMemory("", ["AAPL"], "analysis text", anthropicClient as never);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });
});
