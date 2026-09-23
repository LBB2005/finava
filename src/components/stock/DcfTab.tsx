"use client";
import { useMemo, useState } from "react";
import { useQuotes } from "@/hooks/useQuotes";
import { useDcfInputs } from "@/hooks/useDcfInputs";
import { computeDcf, defaultGrowthFor } from "@/lib/dcf";
import { asOfLabel } from "@/lib/facts/format";
import Rule from "@/components/ui/Rule";

// Inputs come from the facts layer via useDcfInputs, so the sliders start from
// exactly the inputs behind the rail's fair value. Slider tweaks stay local.

function fmtMoney(n: number | null | undefined, d = 2): string {
  return typeof n === "number" && Number.isFinite(n)
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`
    : "—";
}
function compact(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  return `${s}$${a.toFixed(0)}`;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function Slider({ label, value, min, max, step, onChange, display }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>{label}</span>
        <span className="mono serif" style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--color-accent)" }}>{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="finava-range"
        style={{ width: "100%" }}
      />
    </div>
  );
}

function Fact({ l, v, color }: { l: string; v: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 0", borderBottom: "1px solid var(--color-border)", gap: 12 }}>
      <span style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>{l}</span>
      <span className="mono" style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: color ?? "var(--color-text)" }}>{v}</span>
    </div>
  );
}

export function DcfTab({ ticker }: { ticker: string }) {
  const { data: inputs, error, isLoading, asOf } = useDcfInputs(ticker);

  // Slider overrides start null and fall back to data-derived defaults, so we never
  // need an effect to seed them once the inputs load.
  const [waccOverride, setWacc] = useState<number | null>(null);
  const [growthOverride, setGrowth] = useState<number | null>(null);

  const { quoteMap } = useQuotes([ticker]);
  const livePrice = quoteMap.get(ticker)?.price ?? null;
  const price = livePrice ?? inputs?.currentPrice ?? null;

  const defaultGrowth = inputs ? defaultGrowthFor(inputs) : 0.08;
  const wacc = waccOverride ?? inputs?.suggestedWacc ?? 0.09;
  const growth = growthOverride ?? defaultGrowth;

  const result = useMemo(() => {
    if (!inputs) return null;
    return computeDcf({ ...inputs, currentPrice: price }, { wacc, growth });
  }, [inputs, price, wacc, growth]);

  if (isLoading) {
    return (
      <div className="fade-in" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
        <div className="skeleton" style={{ height: 220 }} />
        <div className="skeleton" style={{ height: 220 }} />
      </div>
    );
  }
  if (error || !inputs || !result) {
    return (
      <div className="fade-in">
        <p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>{error ?? "DCF is unavailable for this symbol."}</p>
      </div>
    );
  }

  // A dash must never be unexplained: when an input is missing the model says
  // which one, rather than leaving the reader to assume a rendering glitch.
  const GAP_COPY: Record<string, string> = {
    no_fcf: "free cash flow is unavailable in the filings",
    invalid_wacc: "the discount rate is invalid",
    net_debt_unknown: "total debt or cash is missing from the filings, so net debt cannot be computed",
    shares_unknown: "shares outstanding are unavailable",
    terminal_growth_exceeds_wacc: "terminal growth is not below the discount rate",
  };
  const gapNote = result.gaps.length
    ? `No intrinsic value: ${result.gaps.map((g) => GAP_COPY[g] ?? g).join("; ")}.`
    : null;

  const upside = result.upsidePct;
  const upColor = upside == null ? "var(--color-muted)" : upside >= 0 ? "var(--color-bull)" : "var(--color-bear)";

  return (
    <div className="fade-in dcf-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 36, alignItems: "start" }}>
      {/* ── assumptions ────────────────────────────────────────────────────── */}
      <div className="dcf-left">
        <Rule>Assumptions</Rule>
        <Slider label="Discount rate (WACC)" value={wacc} min={0.05} max={0.16} step={0.0025} onChange={setWacc} display={pct(wacc)} />
        <Slider label="FCF growth (5-yr)" value={growth} min={0} max={0.3} step={0.005} onChange={setGrowth} display={pct(growth)} />
        <p className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)", lineHeight: 1.6, marginTop: 4 }}>
          Suggested WACC {pct(inputs.suggestedWacc)} (from beta){inputs.historicalGrowth != null ? ` · historical growth ${pct(inputs.historicalGrowth)}` : ""}. Terminal growth fixed at 2.5%.
          {inputs.fcfIsProxy ? " FCF proxied by operating cash flow (capex unavailable)." : ""}
          {asOf ? ` Inputs ${asOfLabel(asOf)}.` : ""}
        </p>
      </div>

      {/* ── output ─────────────────────────────────────────────────────────── */}
      <div className="dcf-right" style={{ borderLeft: "1px solid var(--color-border)", paddingLeft: 36 }}>
        <Rule>Intrinsic value</Rule>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          {/* Section-level display numeral → --text-stat; --text-hero stays
              reserved for the page hero price. */}
          <span className="serif" style={{ fontSize: "var(--text-stat)", fontWeight: 800, letterSpacing: "-0.02em", color: "var(--color-accent)", lineHeight: 1 }}>
            {fmtMoney(result.fairValue)}
          </span>
          {upside != null && (
            <span className="mono" style={{ fontSize: "var(--text-body)", fontWeight: 700, color: upColor }}>
              {upside >= 0 ? "+" : ""}{upside.toFixed(1)}%
            </span>
          )}
        </div>
        <p className="mono" style={{ margin: "6px 0 18px", fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>
          per share · {price != null ? `vs $${price.toFixed(2)} now` : "no live price"}
          {upside != null ? ` · ${upside >= 0 ? "undervalued" : "overvalued"}` : ""}
        </p>
        {gapNote && (
          <p
            className="mono"
            style={{ margin: "-8px 0 18px", fontSize: "var(--text-micro)", color: "var(--color-muted)", lineHeight: 1.6 }}
          >
            {gapNote}
          </p>
        )}

        <Fact l="PV of 5-yr cash flows" v={compact(result.pvExplicit)} />
        <Fact l="PV of terminal value" v={compact(result.pvTerminal)} />
        <Fact l="Enterprise value" v={compact(result.pvExplicit + result.pvTerminal)} />
        <Fact
          l="Less: net debt"
          v={inputs.netDebt == null ? "Unavailable" : compact(inputs.netDebt)}
          color={inputs.netDebt != null && inputs.netDebt < 0 ? "var(--color-bull)" : undefined}
        />
        <Fact l="Equity value" v={compact(result.equityValue)} />
        <Fact l="Shares outstanding" v={inputs.sharesOutstanding != null ? `${(inputs.sharesOutstanding / 1e9).toFixed(2)}B` : "—"} />
        <Fact l="Base free cash flow" v={compact(inputs.baseFcf)} />

        <p className="mono" style={{ margin: "16px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
          A transparent 5-year DCF on EDGAR filing data · drag the sliders to test assumptions · AI-assisted, may contain errors · research color, not investment advice.
        </p>
      </div>
    </div>
  );
}
