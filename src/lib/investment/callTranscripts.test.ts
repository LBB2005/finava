import { describe, it, expect } from "vitest";

import {
  CALL_TRANSCRIPT_FIELD,
  NO_LICENSED_PROVIDER,
  callKey,
  callTranscriptDraft,
  callTranscriptGap,
  fixtureCallTranscripts,
  unavailableCallTranscripts,
  type CallTranscript,
} from "./callTranscripts";
import { buildEvidenceItem } from "./evidence";

const AS_OF = "2026-09-22T12:00:00.000Z";

// The only transcript text in this repo, and it lives in a test on purpose: no
// synthetic management speech is committed under src/, so nothing that reads as
// primary-source disclosure can leak from a fixture into a rendered report.
const FIXTURE: CallTranscript = {
  ticker: "TEST",
  period: "Q2 2026",
  heldAt: "2026-07-24T21:00:00.000Z",
  source: "fixture_transcript",
  url: null,
  text: "OPERATOR: Good afternoon. CFO: Free cash flow was 1.2 billion for the quarter.",
};

describe("the default provider", () => {
  it("reports every call as missing rather than inventing one", async () => {
    const provider = unavailableCallTranscripts();
    const lookup = await provider.fetchCall({ ticker: "TEST", period: "Q2 2026" });
    expect(lookup.status).toBe("unavailable");
    if (lookup.status !== "unavailable") return;
    expect(lookup.reason).toBe("not_covered");
    expect(lookup.detail).toBe(NO_LICENSED_PROVIDER);
  });

  it("says the limitation is ours, not a fact about the company", () => {
    // The distinction matters: `not_covered` alone would read as "this company
    // holds no earnings calls", which is a claim we have no basis for.
    expect(NO_LICENSED_PROVIDER).toMatch(/limitation of our sources/);
  });

  it("produces a not_covered gap naming the period that is missing", async () => {
    const provider = unavailableCallTranscripts();
    const request = { ticker: "TEST", period: "Q2 2026" };
    const gap = callTranscriptGap(provider, request, await provider.fetchCall(request));
    expect(gap).toEqual({
      source: "none_configured",
      field: `${CALL_TRANSCRIPT_FIELD}:Q2 2026`,
      reason: "not_covered",
      detail: NO_LICENSED_PROVIDER,
    });
  });
});

describe("the fixture provider", () => {
  it("returns a transcript it was handed", async () => {
    const provider = fixtureCallTranscripts([FIXTURE]);
    const lookup = await provider.fetchCall({ ticker: "test", period: "Q2 2026" });
    expect(lookup.status).toBe("available");
    if (lookup.status !== "available") return;
    expect(lookup.transcript.text).toBe(FIXTURE.text);
  });

  it("keeps a missing call missing, as not_covered", async () => {
    const provider = fixtureCallTranscripts([FIXTURE]);
    const lookup = await provider.fetchCall({ ticker: "TEST", period: "Q3 2026" });
    expect(lookup.status).toBe("unavailable");
    if (lookup.status !== "unavailable") return;
    expect(lookup.reason).toBe("not_covered");
    expect(lookup.detail).toMatch(/TEST:Q3 2026/);
  });

  it("refuses an empty fixture, which would count as coverage while supporting nothing", () => {
    expect(() => fixtureCallTranscripts([{ ...FIXTURE, text: "   " }])).toThrow(/no text/);
  });

  it("keys on the upper-cased ticker", () => {
    expect(callKey(" aapl ", "Q2 2026")).toBe("AAPL:Q2 2026");
  });
});

describe("a transcript as evidence", () => {
  it("carries the call date as publishedAt, so look-ahead is caught by the usual rule", () => {
    const d = callTranscriptDraft(FIXTURE);
    expect(d.publishedAt).toBe(FIXTURE.heldAt);
    expect(d.field).toBe(CALL_TRANSCRIPT_FIELD);
    expect(d.kind).toBe("transcript");

    const before = buildEvidenceItem(d, { asOf: AS_OF });
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.built.item.standing).toBe("clean");

    // A call held after the cutoff is post-as-of like any other late source.
    const after = buildEvidenceItem(d, { asOf: "2026-07-01T00:00:00.000Z" });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.built.item.standing).toBe("post_asof");
  });

  it("is undated when the provider will not say when the call was held", () => {
    const r = buildEvidenceItem(callTranscriptDraft({ ...FIXTURE, heldAt: null }), {
      asOf: AS_OF,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.built.item.standing).toBe("undated");
  });

  it("produces no gap when the call was obtained", async () => {
    const provider = fixtureCallTranscripts([FIXTURE]);
    const request = { ticker: "TEST", period: "Q2 2026" };
    expect(callTranscriptGap(provider, request, await provider.fetchCall(request))).toBeNull();
  });
});
