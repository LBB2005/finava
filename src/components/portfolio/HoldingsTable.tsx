"use client";
import { useRouter } from "next/navigation";
import ScorePill from "@/components/ui/ScorePill";
import type { Holding, Quote } from "@/types/portfolio";

export interface HoldingRow {
  holding: Holding;
  quote?: Quote;
  /** Market value. */
  mv: number;
  /** Share of equity, in percent. */
  pct: number;
  gainLoss: number;
  gainLossPct: number;
  /** Finava score, or null when the factor universe doesn't cover this ticker. */
  score: number | null;
}

function fmt(n: number, d = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmt0(n: number) {
  return Math.round(Math.abs(n)).toLocaleString("en-US");
}

function Shimmer({ w, h = 12 }: { w: number | string; h?: number }) {
  return (
    <span
      className="skeleton"
      style={{ display: "inline-block", width: w, height: h, borderRadius: "var(--radius-xs)" }}
    />
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </svg>
  );
}

function RowActions({ ticker, onEdit, onRemove }: {
  ticker: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="holding-actions inline-flex items-center gap-0.5">
      <button
        type="button"
        aria-label={`Edit ${ticker}`}
        title={`Edit ${ticker}`}
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        className="std-focus p-1 rounded-[var(--radius-xs)] text-[var(--color-muted)] hover:text-[var(--color-accent)] transition-colors duration-150"
      >
        <PencilIcon />
      </button>
      <button
        type="button"
        aria-label={`Remove ${ticker}`}
        title={`Remove ${ticker}`}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="std-focus p-1 rounded-[var(--radius-xs)] text-[var(--color-muted)] hover:text-[var(--color-bear)] transition-colors duration-150"
      >
        <TrashIcon />
      </button>
    </span>
  );
}

const COLS = [
  { label: "Ticker", right: false },
  { label: "Finava", right: false },
  { label: "Price", right: true },
  { label: "Day", right: true },
  { label: "Mkt Value", right: true },
  { label: "Return", right: true },
] as const;

/**
 * The holdings book.
 *
 * Two renderings of the same rows: the full table when the card is wide, and —
 * once it drops under 560px, where six numeric columns used to be clipped by the
 * card's `overflow:hidden` — a stacked row (ticker + value, then day / return /
 * weight). A container query picks one, so the swap tracks the card's own width
 * rather than the viewport's. There is never a horizontal body scroll.
 */
export default function HoldingsTable({ rows, quotesLoading, readOnly = false, onEdit, onRemove }: {
  rows: HoldingRow[];
  quotesLoading: boolean;
  /** Plaid-synced books are rebuilt on sync, so their rows carry no controls. */
  readOnly?: boolean;
  onEdit: (holding: Holding) => void;
  onRemove: (holding: Holding) => void;
}) {
  const router = useRouter();
  const open = (ticker: string) => router.push(`/stock/${ticker}`);

  return (
    <div className="pf-holdings-card" style={{
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius-lg)",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        padding: "12px 18px",
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)",
      }}>
        <p className="eyebrow-label" style={{ color: "var(--color-muted)", margin: 0 }}>Holdings</p>
        <span className="pf-holdings-hint" style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>
          {readOnly ? "Synced from your brokerage — read-only" : "Click a row to open its stock page"}
        </span>
      </div>

      {/* ── Desktop: full table ── */}
      <table className="pf-holdings-table" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {COLS.map(({ label, right }) => (
              <th
                key={label}
                className="mono"
                style={{
                  textAlign: right ? "right" : "left",
                  fontSize: "var(--text-micro)", fontWeight: 700,
                  letterSpacing: "0.1em", textTransform: "uppercase",
                  color: "var(--color-muted)",
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--color-border)",
                }}
              >{label}</th>
            ))}
            {!readOnly && <th style={{ width: 62, borderBottom: "1px solid var(--color-border)" }} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, rowIdx) => {
            const dayPct = r.quote?.changePct ?? 0;
            const isDayPos = dayPct >= 0;
            const isPos = r.gainLoss >= 0;
            return (
              <tr
                key={r.holding.ticker}
                className="portfolio-row std-focus group"
                style={{
                  borderBottom: rowIdx < rows.length - 1 ? "1px solid var(--color-border)" : "none",
                  cursor: "pointer",
                }}
                onClick={() => open(r.holding.ticker)}
              >
                <td style={{ padding: "8px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{
                      fontSize: "var(--text-meta)", fontWeight: 700, letterSpacing: "0.04em",
                      color: "var(--color-accent)", background: "var(--color-accent-light)",
                      padding: "3px 7px", borderRadius: "var(--radius-xs)",
                    }}>{r.holding.ticker}</span>
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>
                      {r.holding.companyName ?? ""}
                    </span>
                  </div>
                </td>
                <td style={{ padding: "8px 12px" }}>
                  {r.score != null ? (
                    <ScorePill score={r.score} />
                  ) : (
                    <span className="mono" style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>—</span>
                  )}
                </td>
                <td className="mono" style={{
                  textAlign: "right", padding: "8px 12px",
                  fontSize: "var(--text-sm)", color: "var(--color-text)",
                }}>
                  {r.quote?.price ? `$${fmt(r.quote.price)}` : quotesLoading ? <Shimmer w={48} /> : "—"}
                </td>
                <td className="mono" style={{
                  textAlign: "right", padding: "8px 12px",
                  fontSize: "var(--text-sm)", fontWeight: 600,
                  color: r.quote ? (isDayPos ? "var(--color-bull)" : "var(--color-bear)") : "var(--color-muted)",
                }}>
                  {r.quote ? `${isDayPos ? "+" : ""}${fmt(dayPct, 2)}%` : quotesLoading ? <Shimmer w={40} /> : "—"}
                </td>
                <td className="mono" style={{
                  textAlign: "right", padding: "8px 12px",
                  fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--color-text)",
                }}>
                  ${fmt0(r.mv)}
                </td>
                <td className="mono" style={{
                  textAlign: "right", padding: "8px 12px",
                  fontSize: "var(--text-sm)", fontWeight: 700,
                  color: isPos ? "var(--color-bull)" : "var(--color-bear)",
                }}>
                  {isPos ? "+" : ""}{fmt(r.gainLossPct, 1)}%
                </td>
                {!readOnly && (
                  <td style={{ padding: "8px 10px", textAlign: "right" }}>
                    <RowActions
                      ticker={r.holding.ticker}
                      onEdit={() => onEdit(r.holding)}
                      onRemove={() => onRemove(r.holding)}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* ── Phone: stacked rows ── */}
      <div className="pf-holdings-stack">
        {rows.map((r, rowIdx) => {
          const dayPct = r.quote?.changePct ?? 0;
          const isDayPos = dayPct >= 0;
          const isPos = r.gainLoss >= 0;
          return (
            <div
              key={r.holding.ticker}
              className="pf-stack-row portfolio-row std-focus"
              role="button"
              tabIndex={0}
              onClick={() => open(r.holding.ticker)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(r.holding.ticker); } }}
              style={{ borderBottom: rowIdx < rows.length - 1 ? "1px solid var(--color-border)" : "none" }}
            >
              {/* Line 1 — identity and what it's worth */}
              <div className="pf-stack-line1">
                <span className="pf-stack-tk">{r.holding.ticker}</span>
                {r.score != null ? (
                  <ScorePill score={r.score} />
                ) : (
                  <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>—</span>
                )}
                <span className="mono pf-stack-mv">${fmt0(r.mv)}</span>
                {!readOnly && (
                  <RowActions
                    ticker={r.holding.ticker}
                    onEdit={() => onEdit(r.holding)}
                    onRemove={() => onRemove(r.holding)}
                  />
                )}
              </div>
              {/* Line 2 — day, return, weight */}
              <div className="pf-stack-line2">
                <span>
                  <span className="pf-stack-k">Day</span>
                  <span
                    className="mono pf-stack-v"
                    style={{ color: r.quote ? (isDayPos ? "var(--color-bull)" : "var(--color-bear)") : "var(--color-muted)" }}
                  >
                    {r.quote ? `${isDayPos ? "+" : ""}${fmt(dayPct, 2)}%` : quotesLoading ? <Shimmer w={34} h={10} /> : "—"}
                  </span>
                </span>
                <span>
                  <span className="pf-stack-k">Return</span>
                  <span
                    className="mono pf-stack-v"
                    style={{ color: isPos ? "var(--color-bull)" : "var(--color-bear)" }}
                  >
                    {isPos ? "+" : ""}{fmt(r.gainLossPct, 1)}%
                  </span>
                </span>
                <span>
                  <span className="pf-stack-k">Weight</span>
                  <span className="mono pf-stack-v" style={{ color: "var(--color-text-secondary)" }}>
                    {fmt(r.pct, 1)}%
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
