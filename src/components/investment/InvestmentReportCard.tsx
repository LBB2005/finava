"use client";

// The report. One component, rendered identically in the stock page and in chat.
//
// It renders a PERSISTED report and computes nothing. That is the whole point: if
// this component did its own arithmetic, the number on the stock page and the
// number in chat could drift apart, and neither would match what was stored and
// later evaluated. Every value here was produced by deterministic server code and
// is displayed as-is.
//
// The honesty properties all land in this file, because a reader only ever sees
// this surface:
//
//   · a missing value reads "Unavailable", never 0%
//   · Watch is neutral, because most Watch ratings mean "not enough to judge"
//   · `insufficient_data` says it is about our data, not the company
//   · the probability basis is stated next to the rating, not buried
//   · the annualized figure is hidden below a year and captioned as terminal
//     wealth, not CAGR
//   · Finava Score appears separately, captioned, never as a probability
//
// Imports only pure modules. Nothing under src/agents may be imported from a
// client component — a lazy import() does not save you.

import Rule from "@/components/ui/Rule";
import ScenarioTable from "./ScenarioTable";
import EvidenceList from "./EvidenceList";
import type { InvestmentReport, SourceGap } from "@/lib/investment/contracts";
import type { EvidenceItem, ResolvedHorizonContract } from "@/lib/investment/schemas";
import {
  ANNUALIZED_CAPTION,
  BASIS_BADGE,
  RATING_LABEL,
  RATING_TOKEN,
  SCORE_CAPTION,
  STATUS_COPY,
  horizonLabel,
  money,
  pct,
  pctMagnitude,
  reasonCopy,
  showAnnualized,
} from "@/lib/investment/presentation";

function Stat({ label, value, caption, color }: { label: string; value: string; caption?: string; color?: string }) {
  return (
    <div>
      <div className="mono eyebrow-label" style={{ color: "var(--color-muted)" }}>{label}</div>
      <div
        className="mono"
        style={{ fontSize: "var(--text-body)", fontWeight: 700, color: color ?? "var(--color-text)", marginTop: 2 }}
      >
        {value}
      </div>
      {caption && (
        <div className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)", marginTop: 2, lineHeight: 1.5 }}>
          {caption}
        </div>
      )}
    </div>
  );
}

export default function InvestmentReportCard({
  report,
  horizon,
  evidence = [],
  gaps = [],
  asOfPrice,
  finavaScore,
}: {
  report: InvestmentReport;
  /**
   * The resolved horizon this report was produced for.
   *
   * Passed in rather than read off the report: the horizon lives on the mandate,
   * which lives on the snapshot the report references. The caller has already
   * loaded that, and threading it explicitly keeps this component from guessing
   * — a report rendered against the wrong horizon would misstate every number
   * on it, since the hurdle and the scenarios were both computed for one.
   */
  horizon?: ResolvedHorizonContract;
  evidence?: EvidenceItem[];
  gaps?: SourceGap[];
  /** The price the report was measured from. Distinct from any horizon price. */
  asOfPrice?: number | null;
  /** Shown separately and captioned — never folded into the rating. */
  finavaScore?: number | null;
}) {
  const { returns, weights, valuation } = report;

  return (
    <div className="card">
      {/* ── verdict ─────────────────────────────────────────────────────────── */}
      <div className="card-head" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontWeight: 700, fontSize: "var(--text-body)" }}>{report.ticker}</span>
        <span
          className="pill"
          style={{
            background: `color-mix(in oklab, ${RATING_TOKEN[report.rating]} 12%, transparent)`,
            color: RATING_TOKEN[report.rating],
            fontWeight: 700,
          }}
        >
          {RATING_LABEL[report.rating]}
        </span>
        {horizon && (
          <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
            {horizonLabel(horizon)}
          </span>
        )}
        {/* A rating resting on untested probabilities says so here, on the
            verdict itself — including on a Buy, which is where it matters most. */}
        {report.experimental && (
          <span
            className="pill"
            style={{
              background: "color-mix(in oklab, var(--color-warn) 12%, transparent)",
              color: "var(--color-warn)",
              fontSize: "var(--text-micro)",
            }}
          >
            {BASIS_BADGE[report.probabilityBasis]}
          </span>
        )}
      </div>

      <div style={{ padding: 20, display: "grid", gap: 22 }}>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {STATUS_COPY[report.status]}
        </p>

        {/* ── the numbers, each named for exactly what it is ────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 18 }}>
          <Stat label="As-of price" value={money(asOfPrice)} caption="what it trades at now" />
          <Stat
            label="Expected return"
            value={pct(returns?.cumulative)}
            caption="probability-weighted, over the whole horizon"
            color={
              returns && Number.isFinite(returns.cumulative)
                ? returns.cumulative >= 0
                  ? "var(--color-bull)"
                  : "var(--color-bear)"
                : undefined
            }
          />
          {/* Withheld below a year rather than annualizing a short view. */}
          {returns?.annualizedWealthEquivalent != null && showAnnualized(horizon?.yearFraction ?? 0) && (
            <Stat
              label="Annualized"
              value={pct(returns.annualizedWealthEquivalent)}
              caption={ANNUALIZED_CAPTION}
            />
          )}
          <Stat
            label="Bear-case loss"
            value={pctMagnitude(returns?.bearScenarioLoss)}
            caption="the bear scenario only — not the maximum possible loss, and not a drawdown"
            color={returns ? "var(--color-bear)" : undefined}
          />
          <Stat
            label="Return hurdle"
            value={pct(report.hurdle)}
            caption="compounded over this horizon, so a two-year report is not judged against one year"
          />
        </div>

        {/* ── why this rating ──────────────────────────────────────────────── */}
        {report.reasonCodes.length > 0 && (
          <div>
            <Rule>Why this rating</Rule>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 5 }}>
              {report.reasonCodes.map((code) => (
                <li key={code} style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>
                  {reasonCopy(code)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <ScenarioTable scenarios={report.scenarios} weights={weights} returns={returns} />

        {/* ── valuation method and what it was missing ─────────────────────── */}
        <div>
          <Rule>Valuation</Rule>
          <p className="mono" style={{ margin: 0, fontSize: "var(--text-micro)", color: "var(--color-muted)", lineHeight: 1.6 }}>
            Method: {valuation.method.replace(/_/g, " ")} · coverage {pctMagnitude(valuation.criticalCoverage, 0)} of required inputs
            {valuation.proxies.length > 0 && ` · proxied: ${valuation.proxies.join(", ")}`}
          </p>
          {valuation.gaps.length > 0 && (
            <ul
              className="mono"
              style={{ listStyle: "none", margin: "6px 0 0", padding: 0, fontSize: "var(--text-micro)", color: "var(--color-muted)", display: "grid", gap: 3 }}
            >
              {valuation.gaps.map((g) => (
                <li key={g.field}>missing {g.field} — {g.detail}</li>
              ))}
            </ul>
          )}
        </div>

        {/* ── unresolved disagreement, kept rather than smoothed away ──────── */}
        {report.dissent.length > 0 && (
          <div>
            <Rule>Unresolved disagreement</Rule>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 5 }}>
              {report.dissent.map((d, i) => (
                <li key={i} style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>{d}</li>
              ))}
            </ul>
          </div>
        )}

        {(evidence.length > 0 || report.claims.length > 0 || gaps.length > 0) && (
          <EvidenceList evidence={evidence} claims={report.claims} gaps={gaps} />
        )}

        {/* ── the score, deliberately apart from the rating ────────────────── */}
        {finavaScore != null && (
          <div>
            <Rule>Finava Score</Rule>
            <div className="mono" style={{ fontSize: "var(--text-body)", fontWeight: 700 }}>{finavaScore}</div>
            <p className="mono" style={{ margin: "2px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)", lineHeight: 1.5 }}>
              {SCORE_CAPTION}
            </p>
          </div>
        )}

        <p className="mono" style={{ margin: 0, fontSize: "var(--text-micro)", color: "var(--color-muted)", lineHeight: 1.6 }}>
          Policy {report.versions.policyVersion} · valuation {report.versions.valuationVersion}
          {report.versions.questionSetVersion ? ` · questions ${report.versions.questionSetVersion}` : ""} · agents {report.versions.agentVersion}
          {report.costUsd != null ? ` · cost $${report.costUsd.toFixed(4)}` : " · cost unavailable"}
          {" · "}AI-assisted research, may contain errors · not investment advice.
        </p>
      </div>
    </div>
  );
}
