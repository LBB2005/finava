"use client";

// The Analyze panel: a horizon, a button, honest progress, and a report.
//
// Self-contained on purpose. It mounts into the existing stock surfaces with a
// couple of lines rather than threading state through them, so the surrounding
// tab keeps working untouched whether this feature is on or off.
//
// Three behaviours worth stating, because each is a thing the UI could easily get
// wrong in a way the user would not notice:
//
//  1. NOTHING SPENDS MONEY ON MOUNT. Research starts only from the button. A URL
//     with a ticker in it, a page refresh, or a re-render never triggers a paid
//     run — `useInvestmentRun` only reads until `start()` is called.
//
//  2. PAUSED IS PAUSED. When no request is in flight and the run has not
//     finished, this says paused and offers to continue. It never implies work is
//     happening in the background, because nothing advances a run server-side.
//
//  3. CHANGING THE HORIZON DISCARDS THE REPORT rather than relabelling it. Every
//     number in a report — the hurdle, the scenarios, the expected return — was
//     computed for one horizon, so showing it under a different one would be
//     wrong in a way that looks fine.

import { useState } from "react";
import Rule from "@/components/ui/Rule";
import InvestmentReportCard from "./InvestmentReportCard";
import HorizonPicker from "./HorizonPicker";
import { useInvestmentRun } from "@/hooks/useInvestmentRun";
import { investmentResearchVisible } from "@/lib/investment/visibility";
import { DEFAULT_ASSUMED_MONTHS } from "@/lib/investment/horizon";

const STAGE_COPY: Record<string, string> = {
  snapshot: "Freezing the evidence",
  research: "Running the specialists",
  valuation: "Valuing the scenarios",
  scenarios: "Weighting the scenarios",
  decision: "Applying the rating policy",
  complete: "Done",
};

export default function InvestmentSection({
  ticker,
  price,
  finavaScore,
}: {
  ticker: string;
  price?: number | null;
  finavaScore?: number | null;
}) {
  // Visibility only — the routes enforce the real gate server-side.
  if (!investmentResearchVisible()) return null;
  return <Panel ticker={ticker} price={price} finavaScore={finavaScore} />;
}

function Panel({
  ticker,
  price,
  finavaScore,
}: {
  ticker: string;
  price?: number | null;
  finavaScore?: number | null;
}) {
  // Annotated: DEFAULT_ASSUMED_MONTHS is a literal type, which would narrow
  // the state to exactly 12 and reject any other horizon.
  const [months, setMonths] = useState<number>(DEFAULT_ASSUMED_MONTHS);
  const [chosen, setChosen] = useState(false);
  const { run, report, busy, error, elapsedMs, paused, start, advance, cancel } = useInvestmentRun();

  // The server's resolved horizon, shown beside the report so the reader can see
  // which horizon produced these numbers. Absent means we show no label rather
  // than asserting one we did not get back.
  const horizon = run?.horizon;

  const stage = run?.stage ?? null;
  const seconds = Math.round(elapsedMs / 1000);

  return (
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--color-border)" }}>
      <Rule
        right={
          run && (
            <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
              {run.status}
            </span>
          )
        }
      >
        Analyze · Buy / Watch / Avoid
      </Rule>

      <div style={{ display: "grid", gap: 12 }}>
        <HorizonPicker
          months={months}
          assumed={!chosen}
          disabled={busy}
          onChange={(m) => {
            setChosen(true);
            setMonths(m);
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-primary std-focus"
            disabled={busy}
            onClick={() => void start({ ticker, horizonMonths: months })}
          >
            {report ? "Re-run analysis" : "Analyze"}
          </button>

          {busy && (
            <>
              <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
                {stage ? STAGE_COPY[stage] ?? stage : "Starting"} · {seconds}s
              </span>
              <button type="button" className="btn btn-ghost std-focus" onClick={() => void cancel()}>
                Stop
              </button>
            </>
          )}

          {/* Paused is an honest state, not a spinner. Nothing is advancing this
              run, so the user is told, and given the control to continue it. */}
          {paused && run && (
            <>
              <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-warn)" }}>
                Paused at “{STAGE_COPY[run.stage] ?? run.stage}” — nothing is running in the background.
              </span>
              <button
                type="button"
                className="btn std-focus"
                onClick={() => void advance(run.runId)}
              >
                Continue
              </button>
            </>
          )}
        </div>

        {error && (
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-bear)" }}>
            {error}{" "}
            <button
              type="button"
              className="btn btn-ghost std-focus"
              onClick={() => void start({ ticker, horizonMonths: months })}
            >
              Retry
            </button>
          </p>
        )}

        {busy && !report && (
          <div style={{ display: "grid", gap: 10 }}>
            <div className="skeleton" style={{ height: 54 }} />
            <div className="skeleton" style={{ height: 120 }} />
          </div>
        )}

        {run && run.gaps.length > 0 && (
          <ul
            className="mono"
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              fontSize: "var(--text-micro)",
              color: "var(--color-muted)",
              display: "grid",
              gap: 3,
            }}
          >
            {run.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        )}

        {report && (
          <InvestmentReportCard
            report={report}
            horizon={horizon}
            asOfPrice={price ?? null}
            finavaScore={finavaScore ?? null}
          />
        )}

        {!run && !busy && (
          <p className="mono" style={{ margin: 0, fontSize: "var(--text-micro)", color: "var(--color-muted)", lineHeight: 1.6 }}>
            Runs the specialist crew against dated evidence, values three scenarios at your
            horizon, and applies a fixed rating policy. Costs credits · nothing runs until you
            press Analyze.
          </p>
        )}
      </div>
    </div>
  );
}
