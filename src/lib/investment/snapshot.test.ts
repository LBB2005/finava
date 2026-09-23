import { describe, it, expect, vi } from "vitest";

// snapshot.ts reuses live/transcripts.ts's chunking and live/ledger.ts's canonical
// JSON, both of which import firebase-admin at module load. The handle snapshot.ts
// actually writes through is INJECTED (`SnapshotDb`), and the fake below is the only
// database any test here touches.
vi.mock("@/lib/firebase-admin", () => ({ db: {} }));

import {
  REQUIRED_INPUTS,
  buildResearchSnapshot,
  computeCoverage,
  isOutage,
  notCoveredGap,
  outageGap,
  readSourceExcerpt,
  snapshotContentHash,
  sourceDocId,
  writeSourceExcerpt,
  type CollectedSources,
  type SnapshotBatch,
  type SnapshotCollectionRef,
  type SnapshotDb,
  type SnapshotDocRef,
  type SourceChunkDoc,
} from "./snapshot";
import { ResearchSnapshotSchema, type ResearchMandate } from "./contracts";
import { fixtureCallTranscripts, unavailableCallTranscripts } from "./callTranscripts";
import type { EvidenceDraft } from "./evidence";

// ── An in-memory Firestore, just deep enough ─────────────────────────────────

class FakeDb implements SnapshotDb {
  readonly docs = new Map<string, Record<string, unknown>>();
  collection(name: string): SnapshotCollectionRef {
    return new FakeCollection(this, name);
  }
  batch(): SnapshotBatch {
    return new FakeBatch(this);
  }
}

class FakeCollection implements SnapshotCollectionRef {
  constructor(
    private readonly db: FakeDb,
    private readonly path: string
  ) {}
  doc(id: string): SnapshotDocRef {
    return new FakeDoc(this.db, `${this.path}/${id}`);
  }
  async get(): Promise<{ docs: SourceChunkDoc[] }> {
    const prefix = `${this.path}/`;
    const docs: SourceChunkDoc[] = [];
    for (const [path, data] of this.db.docs) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/")) continue;
      docs.push({ id: rest, get: (field: string) => data[field] });
    }
    // Deliberately reversed: real Firestore promises no order, and the reader is
    // the thing that must sort. A fake that hands back insertion order would hide
    // exactly the bug the zero-padded ids exist to prevent.
    return { docs: docs.reverse() };
  }
}

class FakeDoc implements SnapshotDocRef {
  constructor(
    private readonly db: FakeDb,
    readonly path: string
  ) {}
  set(data: Record<string, unknown>): unknown {
    this.db.docs.set(this.path, { ...data });
    return undefined;
  }
  async get(): Promise<{ exists: boolean }> {
    return { exists: this.db.docs.has(this.path) };
  }
  collection(name: string): SnapshotCollectionRef {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }
}

class FakeBatch implements SnapshotBatch {
  private readonly ops: (() => void)[] = [];
  constructor(private readonly db: FakeDb) {}
  set(ref: SnapshotDocRef, data: Record<string, unknown>): unknown {
    this.ops.push(() => this.db.docs.set((ref as FakeDoc).path, { ...data }));
    return undefined;
  }
  delete(ref: SnapshotDocRef): unknown {
    this.ops.push(() => this.db.docs.delete((ref as FakeDoc).path));
    return undefined;
  }
  async commit(): Promise<unknown> {
    for (const op of this.ops) op();
    this.ops.length = 0;
    return undefined;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AS_OF = "2026-09-22T12:00:00.000Z";

const MANDATE: ResearchMandate = {
  mode: "analyze",
  query: "is TEST a buy over the next year",
  ticker: "TEST",
  horizon: {
    count: 12,
    unit: "calendar_months",
    assumed: false,
    targetDate: "2027-09-22",
    yearFraction: 1,
    note: null,
  },
  benchmark: "SPY",
  universeVersion: "u1",
  hardFilter: null,
  qualitativeCriteria: [],
};

function priceDraft(over: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    ticker: "TEST",
    field: "price",
    kind: "price",
    source: "polygon",
    url: null,
    publishedAt: "2026-09-22T00:00:00.000Z",
    period: "2026-09-22",
    value: 100,
    unit: "usd_per_share",
    text: "close 100.00",
    ...over,
  };
}

function fcfDraft(over: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    ticker: "TEST",
    field: "freeCashFlow",
    kind: "financial",
    source: "sec_edgar",
    url: "https://example.test/10k",
    publishedAt: "2026-02-14T00:00:00.000Z",
    period: "FY2025",
    value: 1_000_000_000,
    unit: "usd",
    text: "Net cash provided by operating activities less purchases of property and equipment",
    ...over,
  };
}

function collector(sources: CollectedSources): {
  fn: (ctx: { ticker: string; asOf: string; mandate: ResearchMandate }) => Promise<CollectedSources>;
  calls: { ticker: string; asOf: string }[];
} {
  const calls: { ticker: string; asOf: string }[] = [];
  return {
    calls,
    fn: async (ctx) => {
      calls.push({ ticker: ctx.ticker, asOf: ctx.asOf });
      return { drafts: [...sources.drafts], gaps: [...sources.gaps] };
    },
  };
}

function deps(
  sources: CollectedSources,
  over: Partial<Parameters<typeof buildResearchSnapshot>[2]> = {}
): Parameters<typeof buildResearchSnapshot>[2] {
  return {
    ownerUid: "uid-1",
    collect: collector(sources).fn,
    db: null,
    asOf: AS_OF,
    now: () => new Date(AS_OF),
    ...over,
  };
}

// ── One as-of ────────────────────────────────────────────────────────────────

describe("one as-of per run", () => {
  it("hands the same instant to the collector that it stamps on the snapshot", async () => {
    const c = collector({ drafts: [priceDraft()], gaps: [] });
    const snap = await buildResearchSnapshot(
      MANDATE,
      "test",
      deps({ drafts: [], gaps: [] }, { collect: c.fn })
    );
    expect(c.calls).toEqual([{ ticker: "TEST", asOf: AS_OF }]);
    expect(snap.asOf).toBe(AS_OF);
  });

  it("reuses a supplied as-of rather than minting a new one, so a replay matches", async () => {
    const replay = "2026-01-01T00:00:00.000Z";
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [priceDraft({ publishedAt: "2025-12-31T00:00:00.000Z" })], gaps: [] }, {
        asOf: replay,
      })
    );
    expect(snap.asOf).toBe(replay);
  });

  it("validates against the frozen contract", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [priceDraft(), fcfDraft()], gaps: [] })
    );
    expect(ResearchSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.ownerUid).toBe("uid-1");
    expect(snap.ticker).toBe("TEST");
  });
});

// ── The content hash ─────────────────────────────────────────────────────────

describe("contentHash", () => {
  it("does not depend on the order sources came back in", async () => {
    const a = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [priceDraft(), fcfDraft()], gaps: [] })
    );
    const b = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [fcfDraft(), priceDraft()], gaps: [] })
    );
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.id).toBe(a.id);
  });

  it("does not depend on the order gaps were recorded in", async () => {
    const g1 = outageGap("polygon", "price", "429");
    const g2 = notCoveredGap("sec_edgar", "netDebt", "no debt disclosed");
    const a = await buildResearchSnapshot(MANDATE, "TEST", deps({ drafts: [], gaps: [g1, g2] }));
    const b = await buildResearchSnapshot(MANDATE, "TEST", deps({ drafts: [], gaps: [g2, g1] }));
    expect(b.contentHash).toBe(a.contentHash);
  });

  it("is blind to when we did the reading", async () => {
    const a = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [fcfDraft({ observedAt: "2026-09-22T09:00:00.000Z" })], gaps: [] })
    );
    const b = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [fcfDraft({ observedAt: "2026-09-22T11:59:00.000Z" })], gaps: [] })
    );
    expect(b.contentHash).toBe(a.contentHash);
  });

  it("changes when a new filing joins the information set", async () => {
    const a = await buildResearchSnapshot(MANDATE, "TEST", deps({ drafts: [fcfDraft()], gaps: [] }));
    const b = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [fcfDraft(), priceDraft()], gaps: [] })
    );
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it("changes when the mandate changes, so a 24-month answer cannot serve a 12-month question", () => {
    const base = { ticker: "TEST", evidence: [], gaps: [], coverage: {} };
    const other: ResearchMandate = {
      ...MANDATE,
      horizon: { ...MANDATE.horizon, count: 24, yearFraction: 2 },
    };
    expect(snapshotContentHash({ ...base, mandate: MANDATE })).not.toBe(
      snapshotContentHash({ ...base, mandate: other })
    );
  });

  it("drops a duplicate reading of the same figure instead of counting it twice", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [fcfDraft(), fcfDraft()], gaps: [] })
    );
    expect(snap.evidence).toHaveLength(1);
  });
});

// ── Gaps ─────────────────────────────────────────────────────────────────────

describe("gaps keep an outage apart from an absence", () => {
  it("classifies the two differently", () => {
    expect(isOutage(outageGap("polygon", "price", "429", "rate_limited"))).toBe(true);
    expect(isOutage(outageGap("sec_edgar", "netDebt", "500"))).toBe(true);
    expect(isOutage(notCoveredGap("sec_edgar", "netDebt", "no debt disclosed"))).toBe(false);
  });

  it("carries both onto the snapshot without merging them", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({
        drafts: [],
        gaps: [
          outageGap("polygon", "price", "rate limited by provider", "rate_limited"),
          notCoveredGap("sec_edgar", "dividendPerShare", "company pays no dividend"),
        ],
      })
    );
    const reasons = snap.gaps.map((g) => g.reason).sort();
    expect(reasons).toEqual(["not_covered", "rate_limited"]);
    expect(snap.gaps.filter(isOutage)).toHaveLength(1);
  });

  it("records a rejected draft as a gap rather than dropping it silently", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      // A financial figure with no period cannot support a claim about a period.
      deps({ drafts: [fcfDraft({ period: null })], gaps: [] })
    );
    expect(snap.evidence).toEqual([]);
    expect(snap.gaps).toHaveLength(1);
    expect(snap.gaps[0].detail).toMatch(/evidence rejected/);
  });

  it("deduplicates identical gaps so a retry loop cannot inflate them", async () => {
    const gap = outageGap("polygon", "price", "429", "rate_limited");
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [], gaps: [gap, { ...gap }] })
    );
    expect(snap.gaps).toHaveLength(1);
  });
});

// ── Look-ahead ───────────────────────────────────────────────────────────────

describe("post-as-of evidence", () => {
  it("is withheld from the information set and recorded as a gap", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({
        drafts: [fcfDraft(), priceDraft({ publishedAt: "2026-09-23T00:00:00.000Z" })],
        gaps: [],
      })
    );
    expect(snap.evidence.map((e) => e.kind)).toEqual(["financial"]);
    expect(snap.gaps.some((g) => /withheld to prevent look-ahead/.test(g.detail))).toBe(true);
    // Not "stale" — it is from after the cutoff, which is the opposite problem.
    expect(snap.gaps.every((g) => g.reason !== "stale")).toBe(true);
  });

  it("does not count withheld evidence toward coverage", async () => {
    const withheld = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [priceDraft({ publishedAt: "2026-09-30T00:00:00.000Z" })], gaps: [] })
    );
    expect(withheld.coverage.forward_multiple).toBe(0);
  });

  it("keeps undated evidence in the set, flagged rather than discarded", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [fcfDraft({ publishedAt: null })], gaps: [] })
    );
    expect(snap.evidence).toHaveLength(1);
    expect(snap.evidence[0].standing).toBe("undated");
  });
});

// ── Transcripts ──────────────────────────────────────────────────────────────

describe("earnings-call transcripts", () => {
  it("stay missing, as not_covered, with no provider configured", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [], gaps: [] }, {
        transcripts: unavailableCallTranscripts(),
        callPeriods: ["Q2 2026"],
      })
    );
    expect(snap.evidence).toEqual([]);
    expect(snap.gaps).toHaveLength(1);
    expect(snap.gaps[0].reason).toBe("not_covered");
    expect(snap.gaps[0].field).toBe("earningsCallTranscript:Q2 2026");
  });

  it("records a throwing provider as an outage, not as a company with no calls", async () => {
    const broken = {
      name: "flaky_provider",
      async fetchCall(): Promise<never> {
        throw new Error("socket hang up");
      },
    };
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [], gaps: [] }, { transcripts: broken, callPeriods: ["Q2 2026"] })
    );
    expect(snap.gaps[0].reason).toBe("unavailable");
    expect(isOutage(snap.gaps[0])).toBe(true);
    expect(snap.gaps[0].detail).toMatch(/socket hang up/);
  });

  it("admits a transcript that was actually obtained", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [], gaps: [] }, {
        transcripts: fixtureCallTranscripts([
          {
            ticker: "TEST",
            period: "Q2 2026",
            heldAt: "2026-07-24T21:00:00.000Z",
            source: "fixture_transcript",
            url: null,
            text: "CFO: free cash flow was 1.2 billion",
          },
        ]),
        callPeriods: ["Q2 2026"],
      })
    );
    expect(snap.evidence.map((e) => e.kind)).toEqual(["transcript"]);
    expect(snap.gaps).toEqual([]);
  });
});

// ── Coverage ─────────────────────────────────────────────────────────────────

describe("coverage", () => {
  it("is a fraction of an enumerated denominator per method", () => {
    const coverage = computeCoverage(["price", "sharesOutstanding"]);
    expect(coverage.forward_multiple).toBe(0.5);
    expect(coverage.fcff_dcf).toBeCloseTo(2 / 9, 4);
    expect(coverage.historical_range).toBeCloseTo(1 / 3, 4);
  });

  it("does not credit a field no method asked for", () => {
    expect(computeCoverage(["someFieldNobodyNeeds"])).toEqual(
      computeCoverage([])
    );
  });

  it("reaches 1 only when every enumerated input is present", () => {
    expect(computeCoverage(REQUIRED_INPUTS.forward_multiple).forward_multiple).toBe(1);
  });

  it("is computed from the evidence that survived", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [priceDraft(), fcfDraft()], gaps: [] })
    );
    expect(snap.coverage.forward_multiple).toBe(0.25);
    expect(snap.coverage.fcff_dcf).toBeCloseTo(2 / 9, 4);
  });
});

// ── Freezing ─────────────────────────────────────────────────────────────────

describe("the snapshot is frozen", () => {
  it("refuses a later stage's attempt to add evidence to it", async () => {
    const snap = await buildResearchSnapshot(MANDATE, "TEST", deps({ drafts: [fcfDraft()], gaps: [] }));
    expect(() => (snap.evidence as unknown as unknown[]).push({})).toThrow();
    expect(() => {
      (snap as { contentHash: string }).contentHash = "tampered";
    }).toThrow();
    expect(snap.evidence).toHaveLength(1);
  });
});

// ── Chunked source storage ───────────────────────────────────────────────────

describe("chunked source excerpts", () => {
  it("round-trips text far larger than a Firestore document", async () => {
    const db = new FakeDb();
    // 450k characters — comfortably past the 1 MiB document ceiling once encoded,
    // which is the write that was rejected on 2026-09-02 and cost a paid step.
    const text = "abcde".repeat(90_000);
    const meta = await writeSourceExcerpt(db, "snap_1", "freeCashFlow__financial__abc", text);
    expect(meta.chunks).toBe(3);
    expect(meta.chars).toBe(text.length);
    expect(await readSourceExcerpt(db, "snap_1", "freeCashFlow__financial__abc")).toBe(text);
  });

  it("keeps chunk order past chunk 9, where lexicographic order would otherwise break", async () => {
    const db = new FakeDb();
    const text = Array.from({ length: 12 }, (_, i) => String.fromCharCode(97 + i).repeat(10)).join("");
    const meta = await writeSourceExcerpt(db, "snap_1", "e1", text, { size: 10 });
    expect(meta.chunks).toBe(12);
    // Unpadded ids would sort "10" before "2" and silently reorder the source.
    expect(await readSourceExcerpt(db, "snap_1", "e1")).toBe(text);
  });

  it("returns null when nothing was stored for that evidence", async () => {
    expect(await readSourceExcerpt(new FakeDb(), "snap_1", "nope")).toBeNull();
  });

  it("drops the tail of a longer previous write", async () => {
    const db = new FakeDb();
    await writeSourceExcerpt(db, "snap_1", "e1", "x".repeat(50), { size: 10 });
    const meta = await writeSourceExcerpt(db, "snap_1", "e1", "y".repeat(15), { size: 10 });
    expect(meta.chunks).toBe(2);
    expect(await readSourceExcerpt(db, "snap_1", "e1")).toBe("y".repeat(15));
  });

  it("stores each source under the snapshot and keeps the snapshot itself short", async () => {
    const db = new FakeDb();
    const long = "z".repeat(5_000);
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [fcfDraft({ text: long })], gaps: [] }, { db })
    );
    const id = snap.evidence[0].id;
    expect(snap.evidence[0].excerpt.length).toBeLessThan(long.length);
    expect(db.docs.has(`investmentSnapshotSources/${sourceDocId(snap.id, id)}`)).toBe(true);
    expect(await readSourceExcerpt(db, snap.id, id)).toBe(long);
  });

  it("persists nothing when no database is injected", async () => {
    const snap = await buildResearchSnapshot(
      MANDATE,
      "TEST",
      deps({ drafts: [fcfDraft()], gaps: [] }, { db: null })
    );
    expect(snap.evidence).toHaveLength(1);
  });
});
