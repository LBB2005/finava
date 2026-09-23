"use client";

// A finished investment report, rendered inside a chat message.
//
// The message stores only a RUN REFERENCE, and this component reads the persisted
// report. That indirection is the point: chat and the stock page render the same
// stored document through the same card, so the expected return quoted in a
// conversation cannot drift from the one on the stock page, and a follow-up
// question is answered from the saved report rather than from the model's memory
// of its own prose.
//
// Reading is a free GET — mounting this never advances a run and never spends
// anything.

import InvestmentReportCard from "@/components/investment/InvestmentReportCard";
import { useInvestmentRun } from "@/hooks/useInvestmentRun";

export default function ChatInvestmentReport({ runId }: { runId: string }) {
  // Passing the id resumes read-only on mount; it does not advance a stage.
  const { run, report, busy, error } = useInvestmentRun(runId);

  if (busy && !report) {
    return <div className="skeleton" style={{ height: 160, borderRadius: "var(--radius-md)" }} />;
  }

  if (error) {
    return (
      <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>
        This report could not be loaded ({error}). The stored report is unchanged.
      </p>
    );
  }

  if (!report) {
    // A run that never reached a report is a real state — say which stage it
    // stopped at rather than rendering an empty card.
    return (
      <p className="mono" style={{ margin: 0, fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
        No report was produced for this run
        {run ? ` — it stopped at “${run.stage}” (${run.status})` : ""}.
      </p>
    );
  }

  return <InvestmentReportCard report={report} horizon={run?.horizon} />;
}
