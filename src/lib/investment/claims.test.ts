import { describe, it, expect, vi } from "vitest";

// These tests build real snapshots, and snapshot.ts reuses live/transcripts.ts's
// chunking, which imports firebase-admin. claims.ts itself touches neither a model
// nor a database: agent output is an injected argument and the snapshot is frozen.
vi.mock("@/lib/firebase-admin", () => ({ db: {} }));

import {
  MAX_REPAIR_ATTEMPTS,
  admitClaim,
  claimId,
  collectResearchClaims,
  parseAgentClaims,
  retainDissent,
  type RawClaim,
} from "./claims";
import { buildResearchSnapshot } from "./snapshot";
import type { ResearchMandate, ResearchSnapshot } from "./contracts";
import type { EvidenceDraft } from "./evidence";

const AS_OF = "2026-09-22T12:00:00.000Z";

const MANDATE: ResearchMandate = {
  mode: "analyze",
  query: "is TEST a buy",
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

const FCF: EvidenceDraft = {
  ticker: "TEST",
  field: "freeCashFlow",
  kind: "financial",
  source: "sec_edgar",
  url: null,
  publishedAt: "2026-02-14T00:00:00.000Z",
  period: "FY2025",
  value: 1_000_000_000,
  unit: "usd",
  text: "Net cash provided by operating activities less capital expenditures",
};

const NET_DEBT: EvidenceDraft = {
  ...FCF,
  field: "netDebt",
  value: 4_000_000_000,
  text: "Total debt less cash and cash equivalents",
};

async function snapshot(drafts: EvidenceDraft[] = [FCF, NET_DEBT]): Promise<ResearchSnapshot> {
  return buildResearchSnapshot(MANDATE, "TEST", {
    ownerUid: "uid-1",
    collect: async () => ({ drafts, gaps: [] }),
    db: null,
    asOf: AS_OF,
    now: () => new Date(AS_OF),
  });
}

function idFor(snap: ResearchSnapshot, field: string): string {
  const hit = snap.evidence.find((e) => e.id.startsWith(`${field}__`));
  if (!hit) throw new Error(`no evidence for ${field}`);
  return hit.id;
}

function raw(over: Partial<RawClaim> = {}): RawClaim {
  return {
    text: "Free cash flow was 1.0bn in FY2025",
    evidenceIds: [],
    kind: "observed",
    direction: "neutral",
    subject: { ticker: "TEST", period: "FY2025", fields: ["freeCashFlow"] },
    ...over,
  };
}

// ── Parsing, and the single repair ───────────────────────────────────────────

describe("parseAgentClaims", () => {
  it("accepts a bare array and an object wrapper alike", async () => {
    const one = raw({ evidenceIds: ["x"] });
    const a = await parseAgentClaims({ agent: "fundamentals", raw: [one] });
    const b = await parseAgentClaims({ agent: "fundamentals", raw: { claims: [one] } });
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
  });

  it("marks the agent unavailable when nothing can be parsed and no repair is offered", async () => {
    const parse = await parseAgentClaims({ agent: "risk", raw: "Here are my thoughts:" });
    expect(parse.status).toBe("unavailable");
    if (parse.status !== "unavailable") return;
    expect(parse.repaired).toBe(false);
    expect(parse.errors.length).toBeGreaterThan(0);
  });

  it("repairs exactly once and uses the repaired output", async () => {
    const repair = vi.fn(async () => [raw({ evidenceIds: ["x"] })]);
    const parse = await parseAgentClaims({ agent: "risk", raw: { nope: true } }, { repair });
    expect(repair).toHaveBeenCalledTimes(MAX_REPAIR_ATTEMPTS);
    expect(parse.status).toBe("ok");
    if (parse.status === "ok") expect(parse.repaired).toBe(true);
  });

  it("gives up after one failed repair instead of retrying", async () => {
    const repair = vi.fn(async () => ({ still: "wrong" }));
    const parse = await parseAgentClaims({ agent: "risk", raw: "prose" }, { repair });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(parse.status).toBe("unavailable");
    if (parse.status !== "unavailable") return;
    expect(parse.errors.some((e) => e.startsWith("after repair:"))).toBe(true);
  });

  it("treats a repair that throws as the used attempt", async () => {
    const repair = vi.fn(async () => {
      throw new Error("gateway 503");
    });
    const parse = await parseAgentClaims({ agent: "risk", raw: "prose" }, { repair });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(parse.status).toBe("unavailable");
    if (parse.status !== "unavailable") return;
    expect(parse.errors.some((e) => /gateway 503/.test(e))).toBe(true);
  });

  it("salvages nothing from a batch with one malformed claim", async () => {
    const good = raw({ evidenceIds: ["x"] });
    const parse = await parseAgentClaims({
      agent: "risk",
      raw: [good, { text: "no kind here", evidenceIds: [], direction: "bear" }],
    });
    // The half that parses is not a representative half: keeping it would drop
    // whichever side of the argument happened to be malformed.
    expect(parse.status).toBe("unavailable");
  });
});

// ── Admission ────────────────────────────────────────────────────────────────

describe("admitClaim", () => {
  it("admits a claim whose evidence exists and covers its subject", async () => {
    const snap = await snapshot();
    const id = idFor(snap, "freeCashFlow");
    const result = admitClaim("fundamentals", raw({ evidenceIds: [id] }), snap);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claim.kind).toBe("observed");
    expect(result.claim.ticker).toBe("TEST");
    expect(result.claim.evidenceIds).toEqual([id]);
  });

  it("rejects a claim citing evidence that does not exist", async () => {
    const snap = await snapshot();
    const result = admitClaim("risk", raw({ evidenceIds: ["missing"] }), snap);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected.reason).toMatch(/cites evidence not in this snapshot: missing/);
  });

  it("rejects an observed claim with no evidence at all", async () => {
    const snap = await snapshot();
    const result = admitClaim("risk", raw({ evidenceIds: [] }), snap);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected.reason).toMatch(/must cite at least one piece of evidence/);
  });

  it("rejects an unevidenced inference too — only an assumption may stand alone", async () => {
    const snap = await snapshot();
    expect(admitClaim("risk", raw({ kind: "inference", evidenceIds: [] }), snap).ok).toBe(false);
    expect(
      admitClaim(
        "risk",
        raw({ kind: "assumption", evidenceIds: [], text: "we assume no buybacks" }),
        snap
      ).ok
    ).toBe(true);
  });

  it("rejects evidence that does not cover the claim's period", async () => {
    const snap = await snapshot();
    const result = admitClaim(
      "fundamentals",
      raw({
        evidenceIds: [idFor(snap, "freeCashFlow")],
        subject: { ticker: "TEST", period: "FY2024", fields: ["freeCashFlow"] },
      }),
      snap
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected.reason).toMatch(/does not cover the claim's subject/);
  });

  it("rejects evidence about a different input, however relevant the document is", async () => {
    const snap = await snapshot();
    const result = admitClaim(
      "risk",
      raw({
        text: "Net debt rose in FY2025",
        evidenceIds: [idFor(snap, "freeCashFlow")],
        subject: { ticker: "TEST", period: "FY2025", fields: ["netDebt"] },
      }),
      snap
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a claim about another security", async () => {
    const snap = await snapshot();
    const result = admitClaim(
      "risk",
      raw({
        evidenceIds: [idFor(snap, "freeCashFlow")],
        subject: { ticker: "OTHER", period: "FY2025", fields: ["freeCashFlow"] },
      }),
      snap
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected.reason).toMatch(/OTHER but this snapshot is TEST/);
  });

  it("rejects a citation that post-dates the run as-of", async () => {
    const snap = await snapshot();
    // A snapshot built here withholds post-as-of evidence, so this can only arrive
    // from a snapshot assembled elsewhere — the guard exists because look-ahead at
    // the claim layer is invisible in the rendered report.
    const tampered: ResearchSnapshot = {
      ...snap,
      evidence: snap.evidence.map((e) => ({ ...e, standing: "post_asof" as const })),
    };
    const result = admitClaim(
      "risk",
      raw({ evidenceIds: [idFor(snap, "freeCashFlow")] }),
      tampered
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected.reason).toMatch(/post-dates the run as-of/);
  });

  it("gives a claim a content-derived id, stable across re-runs", async () => {
    const snap = await snapshot();
    const id = idFor(snap, "freeCashFlow");
    const a = admitClaim("fundamentals", raw({ evidenceIds: [id] }), snap);
    const b = admitClaim("fundamentals", raw({ evidenceIds: [id] }), snap);
    expect(a.ok && b.ok && a.claim.id === b.claim.id).toBe(true);
    // Two agents reaching the same conclusion independently stay two claims.
    expect(claimId("a", "observed", "bull", "same text", ["e1"])).not.toBe(
      claimId("b", "observed", "bull", "same text", ["e1"])
    );
  });
});

// ── Kind separation ──────────────────────────────────────────────────────────

describe("kind separation", () => {
  it("keeps observed, inference and assumption distinct on the output", async () => {
    const snap = await snapshot();
    const id = idFor(snap, "freeCashFlow");
    const set = await collectResearchClaims({
      snapshot: snap,
      outputs: [
        {
          agent: "fundamentals",
          raw: [
            raw({ text: "FCF was 1.0bn in FY2025", kind: "observed", evidenceIds: [id] }),
            raw({ text: "FCF can compound from here", kind: "inference", evidenceIds: [id] }),
            raw({ text: "we assume no buybacks", kind: "assumption", evidenceIds: [] }),
          ],
        },
      ],
    });
    expect(set.claims.map((c) => c.kind)).toEqual(["observed", "inference", "assumption"]);
    expect(set.rejected).toEqual([]);
  });
});

// ── Dissent ──────────────────────────────────────────────────────────────────

describe("dissent", () => {
  it("records an opposition over the same subject and keeps both claims", async () => {
    const snap = await snapshot();
    const id = idFor(snap, "freeCashFlow");
    const set = await collectResearchClaims({
      snapshot: snap,
      outputs: [
        {
          agent: "bull_agent",
          raw: [
            raw({
              text: "FCF growth is durable",
              kind: "inference",
              direction: "bull",
              evidenceIds: [id],
            }),
          ],
        },
        {
          agent: "bear_agent",
          raw: [
            raw({
              text: "FCF is flattered by working capital",
              kind: "inference",
              direction: "bear",
              evidenceIds: [id],
            }),
          ],
        },
      ],
    });
    expect(set.claims).toHaveLength(2);
    expect(set.dissent).toHaveLength(1);
    expect(set.dissent[0]).toMatch(/bull_agent/);
    expect(set.dissent[0]).toMatch(/bear_agent/);
  });

  it("does not call two claims about different things a disagreement", async () => {
    const snap = await snapshot();
    const set = await collectResearchClaims({
      snapshot: snap,
      outputs: [
        {
          agent: "bull_agent",
          raw: [
            raw({
              text: "FCF growth is durable",
              direction: "bull",
              kind: "inference",
              evidenceIds: [idFor(snap, "freeCashFlow")],
            }),
          ],
        },
        {
          agent: "bear_agent",
          raw: [
            raw({
              text: "Net debt is high",
              direction: "bear",
              kind: "observed",
              evidenceIds: [idFor(snap, "netDebt")],
              subject: { ticker: "TEST", period: "FY2025", fields: ["netDebt"] },
            }),
          ],
        },
      ],
    });
    expect(set.claims).toHaveLength(2);
    expect(set.dissent).toEqual([]);
  });

  it("stays quiet when no subject was declared, rather than guessing one", () => {
    expect(
      retainDissent([
        {
          claim: {
            id: "c1",
            agent: "a",
            ticker: "TEST",
            text: "up",
            evidenceIds: ["e1"],
            kind: "inference",
            direction: "bull",
          },
          subject: null,
        },
        {
          claim: {
            id: "c2",
            agent: "b",
            ticker: "TEST",
            text: "down",
            evidenceIds: ["e1"],
            kind: "inference",
            direction: "bear",
          },
          subject: null,
        },
      ])
    ).toEqual([]);
  });
});

// ── The stage ────────────────────────────────────────────────────────────────

describe("collectResearchClaims", () => {
  it("separates an unavailable agent from a rejected claim", async () => {
    const snap = await snapshot();
    const set = await collectResearchClaims({
      snapshot: snap,
      outputs: [
        { agent: "broken", raw: "I could not produce JSON" },
        { agent: "risk", raw: [raw({ evidenceIds: ["nope"] })] },
        {
          agent: "fundamentals",
          raw: [raw({ evidenceIds: [idFor(snap, "freeCashFlow")] })],
        },
      ],
    });
    expect(set.unavailableAgents.map((a) => a.agent)).toEqual(["broken"]);
    expect(set.rejected.map((r) => r.agent)).toEqual(["risk"]);
    expect(set.claims.map((c) => c.agent)).toEqual(["fundamentals"]);
  });

  it("renders one claim once when an agent repeats itself verbatim", async () => {
    const snap = await snapshot();
    const one = raw({ evidenceIds: [idFor(snap, "freeCashFlow")] });
    const set = await collectResearchClaims({
      snapshot: snap,
      outputs: [{ agent: "fundamentals", raw: [one, { ...one }] }],
    });
    expect(set.claims).toHaveLength(1);
  });

  it("produces an empty, honest result when every agent failed", async () => {
    const snap = await snapshot();
    const set = await collectResearchClaims({
      snapshot: snap,
      outputs: [
        { agent: "a", raw: null },
        { agent: "b", raw: 42 },
      ],
    });
    expect(set.claims).toEqual([]);
    expect(set.dissent).toEqual([]);
    expect(set.unavailableAgents.map((a) => a.agent)).toEqual(["a", "b"]);
  });
});
