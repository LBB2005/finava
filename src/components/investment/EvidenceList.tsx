"use client";

// The evidence a report rests on, and the gaps it does not.
//
// Two things this list refuses to blur:
//
//  1. WHAT A SOURCE SAYS vs WHAT AN ANALYST CONCLUDED. `observed` claims carry a
//     source; `inference` and `assumption` are marked, because an inference
//     rendered with the visual authority of a reported fact is the most
//     misleading thing this feature could put on screen.
//
//  2. UNDATED AND POST-CUTOFF EVIDENCE. A source that will not say when a figure
//     is from is neither clean nor excluded — it is unverifiable, and the row
//     says so rather than looking identical to a dated one.
//
// Gaps are shown alongside the evidence, not hidden, and an outage is worded
// differently from "the company has none".

import Rule from "@/components/ui/Rule";
import type { EvidenceItem, ResearchClaim } from "@/lib/investment/schemas";
import type { SourceGap } from "@/lib/investment/contracts";

const STANDING_NOTE: Record<EvidenceItem["standing"], string | null> = {
  clean: null,
  undated: "undated — the source would not say when this is from",
  post_asof: "published after the cutoff — excluded from the analysis",
};

const KIND_NOTE: Record<ResearchClaim["kind"], string | null> = {
  observed: null,
  inference: "inference",
  assumption: "assumption",
};

const GAP_REASON_COPY: Record<SourceGap["reason"], string> = {
  // An outage and a genuine absence are different facts about the world.
  unavailable: "the source could not be reached",
  rate_limited: "we were rate-limited, so this was not retrieved",
  not_covered: "this source does not cover the company",
  unauthorized: "our access does not include this data",
  stale: "the only available figure was too old to use",
};

export default function EvidenceList({
  evidence,
  claims,
  gaps,
}: {
  evidence: EvidenceItem[];
  claims: ResearchClaim[];
  gaps: SourceGap[];
}) {
  const byId = new Map(evidence.map((e) => [e.id, e]));

  return (
    <div>
      <Rule right={<span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>{evidence.length} sources</span>}>
        Evidence
      </Rule>

      {claims.length === 0 && (
        <p className="empty-note" style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>
          No structured findings were produced for this report.
        </p>
      )}

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 14 }}>
        {claims.map((claim) => {
          const kindNote = KIND_NOTE[claim.kind];
          const sources = claim.evidenceIds.map((id) => byId.get(id)).filter((e): e is EvidenceItem => e != null);
          return (
            <li key={claim.id}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                {kindNote && (
                  <span
                    className="pill"
                    style={{
                      background: "color-mix(in oklab, var(--color-warn) 12%, transparent)",
                      color: "var(--color-warn)",
                      fontSize: "var(--text-micro)",
                    }}
                  >
                    {kindNote}
                  </span>
                )}
                <span
                  className="pill"
                  style={{
                    background: "var(--color-accent-light)",
                    color: "var(--color-accent)",
                    fontSize: "var(--text-micro)",
                  }}
                >
                  {claim.agent}
                </span>
                <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text)" }}>{claim.text}</span>
              </div>

              {sources.length > 0 && (
                <ul
                  className="mono"
                  style={{
                    listStyle: "none",
                    margin: "6px 0 0 0",
                    padding: 0,
                    fontSize: "var(--text-micro)",
                    color: "var(--color-muted)",
                    display: "grid",
                    gap: 3,
                  }}
                >
                  {sources.map((e) => {
                    const note = STANDING_NOTE[e.standing];
                    return (
                      <li key={e.id}>
                        {e.source}
                        {e.period ? ` · ${e.period}` : ""}
                        {e.publishedAt ? ` · published ${e.publishedAt.slice(0, 10)}` : ""}
                        {` · read ${e.observedAt.slice(0, 10)}`}
                        {note ? ` · ${note}` : ""}
                        {e.url && (
                          <>
                            {" · "}
                            <a href={e.url} target="_blank" rel="noopener noreferrer" className="std-focus" style={{ color: "var(--color-accent)" }}>
                              source
                            </a>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {gaps.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <Rule>What was missing</Rule>
          <ul
            className="mono"
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              fontSize: "var(--text-micro)",
              color: "var(--color-muted)",
              display: "grid",
              gap: 4,
            }}
          >
            {gaps.map((g, i) => (
              <li key={`${g.source}-${g.field}-${i}`}>
                {g.field} from {g.source} — {GAP_REASON_COPY[g.reason]}
                {g.detail ? ` (${g.detail})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
