"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveBoard } from "@/hooks/useLiveBoard";
import { CONSTITUENT_BY_TICKER } from "@/lib/extraUniverse";

// Window very large lists: render the first chunk and reveal the rest on
// demand, so a 200-ticker watchlist doesn't render (and poll-rerender) 200
// rows at once.
const WINDOW_SIZE = 50;

function pct(n: number | null): string {
  if (n === null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function price(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function nameFor(t: string): string {
  return CONSTITUENT_BY_TICKER.get(t)?.name ?? "—";
}

export default function WatchlistBoard({
  tickers,
  compact = false,
  onRemove,
}: {
  tickers: string[];
  compact?: boolean;
  onRemove?: (ticker: string) => void;
}) {
  const router = useRouter();
  const { liveMap, isLoading } = useLiveBoard(tickers);
  const [showAll, setShowAll] = useState(false);
  const visibleTickers = showAll ? tickers : tickers.slice(0, WINDOW_SIZE);
  const hidden = tickers.length - visibleTickers.length;

  if (tickers.length === 0) {
    if (compact) {
      return (
        <p className="pl-[42px] pr-[14px] py-[7px] text-[length:var(--text-meta)]" style={{ color: "var(--color-muted)" }}>
          No stocks yet.
        </p>
      );
    }
    return (
      <div
        className="flex flex-col items-center justify-center text-center"
        style={{ padding: "40px 20px", gap: 6 }}
      >
        <p className="text-[length:var(--text-sm)]" style={{ color: "var(--color-text-secondary)" }}>
          No stocks in this list yet.
        </p>
        <p className="text-[length:var(--text-meta)]" style={{ color: "var(--color-muted)" }}>
          Add a ticker above to start tracking it.
        </p>
      </div>
    );
  }

  /* ── Compact sidebar rows — mirrors the portfolio HoldingCard look ──────── */
  if (compact) {
    return (
      <div className="flex flex-col">
        {visibleTickers.map((t) => {
          const row = liveMap.get(t);
          const chg = row?.changePct ?? null;
          const up = (chg ?? 0) >= 0;
          return (
            <div
              key={t}
              role="button"
              tabIndex={0}
              onClick={() => router.push(`/stock/${t}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(`/stock/${t}`);
                }
              }}
              className="group grid items-center gap-[10px] pl-[42px] pr-[14px] py-[7px] cursor-pointer bg-transparent hover:bg-[var(--color-sidebar-hover)] transition-colors duration-100"
              style={{ gridTemplateColumns: "auto 1fr auto" }}
            >
              <span
                className="text-[length:var(--text-micro)] font-bold tracking-[0.04em] px-[6px] py-[3px] rounded-[var(--radius-xs)]"
                style={{ color: "var(--color-accent)", background: "var(--color-accent-light)" }}
              >
                {t}
              </span>
              <span
                className="text-[length:var(--text-meta)] overflow-hidden text-ellipsis whitespace-nowrap"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {nameFor(t)}
              </span>
              <span
                className="mono text-[length:var(--text-meta)] font-semibold tabular-nums"
                style={{ color: chg === null ? "var(--color-muted)" : up ? "var(--color-bull)" : "var(--color-bear)" }}
              >
                {isLoading && !row ? "…" : pct(chg)}
              </span>
            </div>
          );
        })}
        {hidden > 0 && (
          <button
            onClick={() => setShowAll(true)}
            className="pl-[42px] pr-[14px] py-[7px] text-left text-[length:var(--text-meta)]"
            style={{ color: "var(--color-muted)" }}
          >
            Show {hidden} more…
          </button>
        )}
      </div>
    );
  }

  /* ── Full page table — mirrors the portfolio holdings table ─────────────── */
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
          {["Ticker", "Company", "Last", "Day", "Mkt Cap"].map((h, i) => (
            <th
              key={h}
              className={`text-[length:var(--text-micro)] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)] px-4 py-[10px] ${i >= 2 ? "text-right" : "text-left"}`}
            >
              {h}
            </th>
          ))}
          {onRemove && <th style={{ width: 40 }} />}
        </tr>
      </thead>
      <tbody>
        {visibleTickers.map((t) => {
          const row = liveMap.get(t);
          const chg = row?.changePct ?? null;
          const up = (chg ?? 0) >= 0;
          return (
            <tr
              key={t}
              className="portfolio-row group"
              style={{ borderBottom: "1px solid var(--color-border)", cursor: "pointer", transition: "background 100ms" }}
              onClick={() => router.push(`/stock/${t}`)}
            >
              <td className="px-4 py-3">
                <span
                  className="text-[length:var(--text-meta)] font-bold px-[7px] py-[3px] rounded-[var(--radius-xs)] tracking-[0.04em]"
                  style={{ color: "var(--color-accent)", background: "var(--color-accent-light)" }}
                >
                  {t}
                </span>
              </td>
              <td className="px-4 py-3 text-[length:var(--text-sm)] text-[var(--color-text-secondary)] max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap">
                {nameFor(t)}
              </td>
              <td className="mono px-4 py-3 text-[length:var(--text-sm)] text-right text-[var(--color-text)] tabular-nums">
                {isLoading && !row ? "…" : price(row?.price ?? null)}
              </td>
              <td
                className="mono px-4 py-3 text-[length:var(--text-sm)] font-medium text-right tabular-nums"
                style={{ color: chg === null ? "var(--color-muted)" : up ? "var(--color-bull)" : "var(--color-bear)" }}
              >
                {pct(chg)}
              </td>
              <td className="mono px-4 py-3 text-[length:var(--text-sm)] text-right text-[var(--color-text)] tabular-nums">
                {row?.marketCap == null ? "—" : `$${(row.marketCap / 1e9).toFixed(1)}B`}
              </td>
              {onRemove && (
                <td className="px-3 py-3 text-right">
                  <button
                    aria-label={`Remove ${t}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(t);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-[var(--color-muted)] hover:text-[var(--color-bear)] transition-opacity duration-150 p-0.5"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </td>
              )}
            </tr>
          );
        })}
        {hidden > 0 && (
          <tr>
            <td colSpan={onRemove ? 6 : 5} className="px-4 py-3 text-center">
              <button
                onClick={() => setShowAll(true)}
                className="text-[length:var(--text-meta)]"
                style={{ color: "var(--color-muted)" }}
              >
                Show {hidden} more…
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
