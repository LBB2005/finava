// Earnings-call transcripts: the provider boundary, and the honest default.
//
// Named `callTranscripts` rather than `transcripts` because `live/transcripts.ts`
// already owns that word for agent-debate transcripts. These are two unrelated
// concepts — what a CEO said on a call, versus what our own crew argued — and one
// module name for both would eventually get someone's debate log cited as company
// disclosure.
//
// THE DEFAULT IS UNAVAILABLE, AND THAT IS THE POINT. No licensed transcript
// provider has been verified for this feature, so `unavailableCallTranscripts` —
// the default — reports every request as missing. It does not return an empty
// string, a summary assembled from memory, or a paraphrase of the quarter's press
// release. A transcript we cannot obtain is a SourceGap, and a gap is a publishable
// outcome (see lib/dataAccuracy.ts and contracts.ts `ReportStatus`). Fabricated
// management quotes would be the single worst thing this feature could emit: they
// read as primary-source disclosure, they are what a thesis gets built on, and
// nobody downstream can tell they were invented.
//
// The interface exists now, ahead of any provider, so that wiring one up later is
// an adapter and not a refactor — and so that the gap it produces is already
// visible in the report today.

import type { SourceGap } from "./contracts";
import type { EvidenceDraft } from "./evidence";

/** The valuation input a transcript supplies. One name, so coverage can count it. */
export const CALL_TRANSCRIPT_FIELD = "earningsCallTranscript";

export interface CallTranscriptRequest {
  ticker: string;
  /** The fiscal period the call discussed, e.g. "Q2 2026". */
  period: string;
}

export interface CallTranscript {
  ticker: string;
  period: string;
  /**
   * When the call was held, per the provider. Null when it will not say — which
   * makes the resulting evidence `undated`, not clean. See live/asOf.ts.
   */
  heldAt: string | null;
  source: string;
  url: string | null;
  /** Verbatim transcript text. Never a summary, and never generated. */
  text: string;
}

/**
 * The outcome of asking for one call.
 *
 * `reason` is the contracts.ts enum rather than a free-text string so the
 * distinction survives into the report: `rate_limited`/`unavailable` mean a
 * provider failed us, `not_covered` means no provider covers this call at all.
 * Collapsing those is how an outage becomes an investment finding.
 */
export type CallTranscriptLookup =
  | { status: "available"; transcript: CallTranscript }
  | { status: "unavailable"; reason: SourceGap["reason"]; detail: string };

export interface CallTranscriptProvider {
  /** Recorded as the gap's `source`, so a reader knows who was asked. */
  readonly name: string;
  fetchCall(request: CallTranscriptRequest): Promise<CallTranscriptLookup>;
}

/** Stable key for a call. Upper-cased ticker so "aapl" and "AAPL" are one call. */
export function callKey(ticker: string, period: string): string {
  return `${ticker.trim().toUpperCase()}:${period}`;
}

/**
 * Why the default reports nothing. Spelled out in the gap's `detail` because
 * `not_covered` alone is ambiguous between the two things a reader cares about:
 * "we have no way to get this" and "this company holds no earnings calls". The
 * first is our limitation and must not be read as a fact about the company.
 */
export const NO_LICENSED_PROVIDER =
  "no licensed earnings-call transcript provider is configured; this is a limitation of our sources, not a statement that the company held no call";

/**
 * The default provider: everything is missing, honestly.
 *
 * `not_covered` rather than `unavailable` because nothing broke — there is no
 * source to break. An `unavailable` here would show up in the record as an outage
 * and invite a retry that can never succeed.
 */
export function unavailableCallTranscripts(
  name = "none_configured",
  detail: string = NO_LICENSED_PROVIDER
): CallTranscriptProvider {
  return {
    name,
    async fetchCall(): Promise<CallTranscriptLookup> {
      return { status: "unavailable", reason: "not_covered", detail };
    },
  };
}

/**
 * A provider backed by transcripts handed to us — test fixtures, or genuine text
 * a human pasted in. Deliberately takes its entries as an argument: no synthetic
 * transcript text is committed under src/, so nothing that looks like management
 * speech can leak from a fixture into a rendered report.
 *
 * A miss is `not_covered`, not `unavailable`: the fixture set is complete by
 * definition, so an absent key means we do not cover that call.
 */
export function fixtureCallTranscripts(
  entries: readonly CallTranscript[],
  name = "fixture"
): CallTranscriptProvider {
  const byKey = new Map<string, CallTranscript>();
  for (const entry of entries) {
    if (!entry.text.trim()) {
      // An empty fixture would be indistinguishable from a real transcript with
      // nothing in it, and would count toward coverage while supporting nothing.
      throw new Error(`fixture transcript for ${callKey(entry.ticker, entry.period)} has no text`);
    }
    byKey.set(callKey(entry.ticker, entry.period), {
      ...entry,
      ticker: entry.ticker.trim().toUpperCase(),
    });
  }

  return {
    name,
    async fetchCall(request: CallTranscriptRequest): Promise<CallTranscriptLookup> {
      const hit = byKey.get(callKey(request.ticker, request.period));
      if (!hit) {
        return {
          status: "unavailable",
          reason: "not_covered",
          detail: `no transcript for ${callKey(request.ticker, request.period)} in the supplied set`,
        };
      }
      return { status: "available", transcript: hit };
    },
  };
}

/** The gap a failed lookup produces, or null when the call was obtained. */
export function callTranscriptGap(
  provider: CallTranscriptProvider,
  request: CallTranscriptRequest,
  lookup: CallTranscriptLookup
): SourceGap | null {
  if (lookup.status === "available") return null;
  return {
    source: provider.name,
    field: `${CALL_TRANSCRIPT_FIELD}:${request.period}`,
    reason: lookup.reason,
    detail: lookup.detail,
  };
}

/**
 * Turn an obtained transcript into an evidence draft.
 *
 * `publishedAt` is the call date, so a transcript for a call held after the run's
 * as-of is stamped `post_asof` and withheld by the same rule as every other piece
 * of evidence — a transcript is exactly the kind of source that arrives late and
 * reads like it was always known.
 */
export function callTranscriptDraft(transcript: CallTranscript): EvidenceDraft {
  return {
    ticker: transcript.ticker,
    field: CALL_TRANSCRIPT_FIELD,
    kind: "transcript",
    source: transcript.source,
    url: transcript.url,
    publishedAt: transcript.heldAt,
    period: transcript.period,
    value: null,
    unit: null,
    text: transcript.text,
  };
}
