"use client";
import { useMoneyMap } from "@/hooks/useMoneyMap";
import MoneyMapGraph from "@/components/stock/MoneyMapGraph";
import MoneyFlowList from "@/components/stock/MoneyFlowList";
import Rule from "@/components/ui/Rule";

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: color }} />
      <span style={{ fontSize: "var(--text-micro)", color: "var(--color-text-secondary)" }}>{label}</span>
    </span>
  );
}

export function MoneyMapTab({ ticker }: { ticker: string }) {
  const { status, map, error, run, retry } = useMoneyMap(ticker);

  const { self, relations } = map;
  const streaming = status === "streaming";

  // Runs start ONLY from an explicit action, mirroring the Finava tab. The
  // store is session-scoped, so an auto-run on mount re-charged the user's
  // credits on every reload of the page.
  if (status === "idle") {
    return (
      <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
        <Rule>Money Map · who funds {ticker} &amp; who it pays</Rule>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--color-text-secondary)", maxWidth: 480, lineHeight: 1.6 }}>
          Trace the money around {ticker.toUpperCase()} — the customers it earns from,
          the suppliers it pays, and the owners behind it.
        </p>
        <button className="tbtn on" onClick={run}>BUILD THE MONEY MAP</button>
        <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
          Uses credits
        </span>
      </div>
    );
  }

  if (status === "error" && relations.length === 0) {
    return (
      <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--color-bear)" }}>{error ?? "Couldn't build the money map."}</p>
        <button className="tbtn on" onClick={retry}>RETRY</button>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <Rule right={
        streaming ? (
          <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)", letterSpacing: "0.05em" }}>MAPPING…</span>
        ) : (
          <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>{relations.length} linked</span>
        )
      }>
        Money Map · who funds {ticker} & who it pays
      </Rule>

      {/* graph — hidden on narrow screens, where the ranked flows list below is
          the readable fallback (a radial web is too dense at phone widths) */}
      <div className="hidden md:block">
        {self ? (
          <MoneyMapGraph self={self} relations={relations} />
        ) : (
          <div className="skeleton" style={{ width: "100%", height: 300 }} />
        )}
      </div>

      {/* legend */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, margin: "10px 2px 0", paddingTop: 10, borderTop: "1px solid var(--color-border)" }}>
        <LegendDot color="var(--color-bull)" label="Customers · in" />
        <LegendDot color="var(--color-warn)" label="Suppliers · out" />
        <LegendDot color="var(--color-accent)" label="Owners" />
        <LegendDot color="var(--color-muted)" label="Peers" />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
          <svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke="var(--color-text-secondary)" strokeWidth="2" strokeDasharray="3 4" strokeLinecap="round" /></svg>
          <span style={{ fontSize: "var(--text-micro)", color: "var(--color-text-secondary)" }}>AI-estimated</span>
        </span>
      </div>

      {/* flows list */}
      <div style={{ marginTop: 20 }}>
        <Rule>Flows · ranked by money intensity</Rule>
        {relations.length > 0 ? (
          <MoneyFlowList relations={relations} />
        ) : streaming ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: 22, borderRadius: "var(--radius-sm)" }} />
            ))}
          </div>
        ) : (
          <p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>No relationships found for this company.</p>
        )}
      </div>

      <p className="mono" style={{ margin: "16px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)", lineHeight: 1.5 }}>
        Owners &amp; peers are live data (Finnhub). Suppliers &amp; customers are AI-estimated from the latest SEC 10-K — directional, may contain errors, not audit-grade. Research color, not investment advice.
      </p>
    </div>
  );
}
