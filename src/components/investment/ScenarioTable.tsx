"use client";

// The three scenarios, their prices, their returns and their weights.
//
// The table's job is to stop three different things being read as one: a
// scenario's PROJECTED PRICE at the horizon, the RETURN that price implies, and
// the PROBABILITY assigned to it. The probability column is the one readers
// over-trust, so its basis is stated directly beneath rather than in a tooltip.
//
// Only imports pure modules — never anything under src/agents, which would drag
// server code into the client bundle.

import Rule from "@/components/ui/Rule";
import type { ScenarioValue, ScenarioWeights, ReturnEstimate, ScenarioId } from "@/lib/investment/schemas";
import {
  BASIS_COPY,
  SCENARIO_LABEL,
  UNAVAILABLE,
  money,
  pct,
} from "@/lib/investment/presentation";

const ORDER: ScenarioId[] = ["bear", "base", "bull"];

export default function ScenarioTable({
  scenarios,
  weights,
  returns,
}: {
  scenarios: ScenarioValue[] | null;
  weights: ScenarioWeights | null;
  returns: ReturnEstimate | null;
}) {
  // No scenarios at all is a real state with a real cause upstream. Say so
  // plainly rather than rendering an empty grid the reader has to interpret.
  if (!scenarios || scenarios.length === 0) {
    return (
      <div>
        <Rule>Scenarios</Rule>
        <p className="empty-note" style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>
          No scenario valuation was produced, so there is no expected return to show.
        </p>
      </div>
    );
  }

  const byId = new Map(scenarios.map((s) => [s.id, s]));

  return (
    <div>
      <Rule>Scenarios</Rule>
      <table className="data-table" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th>Scenario</th>
            <th className="num">Price at horizon</th>
            <th className="num">Distributions</th>
            <th className="num">Total return</th>
            <th className="num">Probability</th>
          </tr>
        </thead>
        <tbody>
          {ORDER.map((id) => {
            const s = byId.get(id);
            const r = returns?.scenarioReturns?.[id];
            const w = weights?.values?.[id];
            return (
              <tr key={id}>
                <td>{SCENARIO_LABEL[id]}</td>
                {/* money() renders a real 0 as $0.00 — equity can go to zero —
                    and a MISSING value as "Unavailable", never as 0. */}
                <td className="num">{money(s?.priceAtHorizon)}</td>
                <td className="num">{money(s?.distributionsPerShare)}</td>
                <td
                  className="num"
                  style={{
                    color:
                      typeof r === "number" && Number.isFinite(r)
                        ? r >= 0
                          ? "var(--color-bull)"
                          : "var(--color-bear)"
                        : "var(--color-muted)",
                  }}
                >
                  {pct(r)}
                </td>
                <td className="num">{typeof w === "number" ? pct(w, 0).replace("+", "") : UNAVAILABLE}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p
        className="mono"
        style={{
          margin: "10px 0 0",
          fontSize: "var(--text-micro)",
          color: "var(--color-muted)",
          lineHeight: 1.6,
        }}
      >
        {weights
          ? BASIS_COPY[weights.basis]
          : "Scenario probabilities are unavailable, so no expected return was computed. They were not replaced with a default."}
      </p>
    </div>
  );
}
