import { Card } from "./DnaPrimitives";
import { EDGE_GATE, monthsLabel } from "@/lib/investorDna";
import type { BenchmarkSummary, TraitRecord as TraitRecordType } from "@/types/dna";

const pts = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n))} pts`;

const BASIS: Record<NonNullable<BenchmarkSummary["basis"]>, string> = {
  purchase: "since purchase",
  added: "since each holding was added to Finava",
  mixed: "since purchase, or since added to Finava where no purchase date exists",
};

/**
 * Each trait's return against SPY over the positions' own holding windows.
 * Colour is earned: green only for a gated edge, red only for a gated blind
 * spot. Everything else is muted and says why ("too early", "not point-in-time").
 */
export default function TraitRecord({ traits, benchmark }: { traits: TraitRecordType[]; benchmark: BenchmarkSummary }) {
  if (traits.length === 0) return null;
  const maxAbs = Math.max(...traits.map((t) => Math.abs(t.excessVsSpyPct ?? 0)), 1);

  return (
    <Card title="Your traits against the S&P 500">
      <p className="mono" style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)", margin: "-6px 0 16px", lineHeight: 1.5 }}>
        Whole book:{" "}
        {benchmark.excessVsSpyPct === null ? (
          <b style={{ color: "var(--color-text)" }}>Unavailable</b>
        ) : (
          <>
            <b style={{ color: "var(--color-text)" }}>{pts(benchmark.excessVsSpyPct)} vs SPY</b>
            {benchmark.excessVsSectorPct !== null && <> · {pts(benchmark.excessVsSectorPct)} vs sector ETFs</>}
            {" · "}{benchmark.beatSpy}/{benchmark.benchmarked} beat SPY
            {benchmark.typicalHoldingMonths !== null && <> · typically held {monthsLabel(benchmark.typicalHoldingMonths)}</>}
          </>
        )}
        {benchmark.benchmarked < benchmark.total && <> · {benchmark.benchmarked} of {benchmark.total} positions benchmarked</>}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {traits.map((t) => {
          const color =
            t.verdict === "edge" ? "var(--color-bull)" : t.verdict === "blind-spot" ? "var(--color-bear)" : "var(--color-muted)";
          const excess = t.excessVsSpyPct;
          const width = excess === null ? 0 : Math.max((Math.abs(excess) / maxAbs) * 100, 4);
          const claimed = t.verdict === "edge" || t.verdict === "blind-spot";

          return (
            <div key={t.factor}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 5, flexWrap: "wrap" }}>
                <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text)" }}>
                  {t.label}
                  <span className="mono" style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)", marginLeft: 8 }}>
                    {t.exposurePct}% of book
                  </span>
                </span>
                <span className="mono" style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>
                  <b style={{ color: claimed ? color : "var(--color-text)", fontWeight: 700 }}>
                    {excess === null ? "Unavailable" : `${pts(excess)} vs SPY`}
                  </b>
                  {t.excessVsSectorPct !== null && <> · {pts(t.excessVsSectorPct)} vs sector</>}
                  {t.benchmarked > 0 && <> · {t.beatBenchmark}/{t.benchmarked} beat</>}
                </span>
              </div>
              <div style={{ height: 7, borderRadius: 999, background: "var(--color-bg)", overflow: "hidden" }}>
                <div style={{ width: `${width}%`, height: "100%", background: color }} />
              </div>
              <p style={{ fontSize: "var(--text-meta)", color: claimed ? "var(--color-text-secondary)" : "var(--color-muted)", margin: "5px 0 0" }}>
                {t.verdictLine}
              </p>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)", marginTop: 14, lineHeight: 1.5 }}>
        Each position&apos;s return minus SPY&apos;s over the same window
        {benchmark.basis ? `, measured ${BASIS[benchmark.basis]}` : ""}. An edge or a lag is only called with at least{" "}
        {EDGE_GATE.minPositions} positions, {EDGE_GATE.minMonths} months held, a gap of {EDGE_GATE.minExcessPts} points or
        more, and factors scored as of the purchase date. Until then it says so.
      </p>
    </Card>
  );
}
