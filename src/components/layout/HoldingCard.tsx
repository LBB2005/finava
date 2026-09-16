"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/portfolio/ConfirmDialog";
import type { Holding, Quote } from "@/types/portfolio";

interface Props {
  holding: Holding;
  quote?: Quote;
  portfolioPct?: number;
  onRemove: (id: string) => void | Promise<void>;
  /** Opens the edit dialog (shares + cost basis). Omit to hide the edit control. */
  onEdit?: (holding: Holding) => void;
  /** Compact = sidebar holding row (ticker chip + name + pct, no expand) */
  compact?: boolean;
  /** When true (e.g. Plaid-synced book), editing and removal are unavailable. */
  readOnly?: boolean;
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function Stat({ label, value, color, span, text }: {
  label: string; value: string; color?: string; span?: boolean;
  /** Non-numeric value (e.g. sector name) — rendered in the UI sans instead of mono. */
  text?: boolean;
}) {
  return (
    <div className={span ? "col-span-2" : ""}>
      <p className="text-[length:var(--text-micro)] text-[var(--color-muted)] leading-none mb-0.5">{label}</p>
      <p
        className={`text-[length:var(--text-meta)] font-medium ${text ? "" : "mono tabular-nums"}`}
        style={{ color: color ?? "var(--color-text-secondary)" }}
      >{value}</p>
    </div>
  );
}

function PencilIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function CrossIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

/**
 * Edit / remove cluster. Revealed on hover for pointer users, and always visible
 * where there is no hover (touch) or when a control inside has keyboard focus —
 * a hover-only affordance is why holdings looked un-removable on a phone.
 */
function RowActions({ ticker, onEdit, onRemove, size = 11 }: {
  ticker: string;
  onEdit?: () => void;
  onRemove: () => void;
  size?: number;
}) {
  return (
    <span className="holding-actions inline-flex items-center gap-0.5">
      {onEdit && (
        <button
          type="button"
          aria-label={`Edit ${ticker}`}
          title={`Edit ${ticker}`}
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="std-focus p-1 rounded-[var(--radius-xs)] text-[var(--color-muted)] hover:text-[var(--color-accent)] transition-colors duration-150"
        >
          <PencilIcon size={size} />
        </button>
      )}
      <button
        type="button"
        aria-label={`Remove ${ticker}`}
        title={`Remove ${ticker}`}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="std-focus p-1 rounded-[var(--radius-xs)] text-[var(--color-muted)] hover:text-[var(--color-bear)] transition-colors duration-150"
      >
        <CrossIcon size={size} />
      </button>
    </span>
  );
}

export default function HoldingCard({ holding, quote, portfolioPct, onRemove, onEdit, compact = false, readOnly = false }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  const price = quote?.price ?? 0;
  const marketValue = price > 0 ? price * holding.shares : holding.avgCost * holding.shares;
  const costBasis = holding.avgCost * holding.shares;
  const gainLoss = price > 0 ? marketValue - costBasis : 0;
  const gainLossPct = costBasis > 0 && price > 0 ? (gainLoss / costBasis) * 100 : 0;
  const isUp = gainLoss >= 0;
  const dayChange = quote?.changePct ?? 0;
  const isDayUp = dayChange >= 0;

  const confirmDialog = confirming && (
    <ConfirmDialog
      title={`Remove ${holding.ticker}?`}
      body={
        <>
          This removes {fmt(holding.shares, holding.shares % 1 === 0 ? 0 : 2)} shares of{" "}
          {holding.companyName ?? holding.ticker}{" "}and their cost basis from your portfolio.
          It doesn&apos;t place a trade.
        </>
      }
      confirmLabel="Remove holding"
      onConfirm={() => onRemove(holding.id)}
      onClose={() => setConfirming(false)}
    />
  );

  /* ── Compact sidebar row ─────────────────────────────────────────────── */
  if (compact) {
    return (
      <>
        <div
          className="group grid items-center gap-[10px] px-[18px] py-[8px] cursor-pointer bg-transparent hover:bg-[var(--color-sidebar-hover)] transition-colors duration-100"
          style={{
            gridTemplateColumns: "auto 1fr auto",
          }}
          onClick={() => router.push(`/stock/${holding.ticker}`)}
        >
          {/* Ticker chip */}
          <span
            className="text-[length:var(--text-micro)] font-bold tracking-[0.04em] px-[6px] py-[3px] rounded-[var(--radius-xs)]"
            style={{ color: "var(--color-accent)", background: "var(--color-accent-light)" }}
          >
            {holding.ticker}
          </span>

          {/* Company name */}
          <span
            className="text-[length:var(--text-meta)] overflow-hidden text-ellipsis whitespace-nowrap"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {holding.companyName ?? holding.ticker}
          </span>

          {/* P&L pct + row actions */}
          <span className="inline-flex items-center gap-1">
            <span
              className="mono text-[length:var(--text-meta)] font-semibold tabular-nums"
              style={{ color: price > 0 ? (isUp ? "var(--color-bull)" : "var(--color-bear)") : "var(--color-muted)" }}
            >
              {price > 0 ? `${isUp ? "+" : ""}${fmt(gainLossPct, 1)}%` : "—"}
            </span>
            {!readOnly && (
              <RowActions
                ticker={holding.ticker}
                onEdit={onEdit ? () => onEdit(holding) : undefined}
                onRemove={() => setConfirming(true)}
                size={10}
              />
            )}
          </span>
        </div>
        {confirmDialog}
      </>
    );
  }

  /* ── Full expandable card ────────────────────────────────────────────── */
  return (
    <>
      <div
        className="group flex flex-col px-3 py-2 rounded-[var(--radius-md)] hover:bg-[var(--color-sidebar-hover)] transition-colors duration-150 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Main row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[length:var(--text-meta)] font-bold text-[var(--color-accent)] bg-[var(--color-accent-light)] px-1.5 py-0.5 rounded-[var(--radius-xs)] flex-shrink-0">
              {holding.ticker}
            </span>
            {holding.companyName && (
              <span className="text-[length:var(--text-meta)] text-[var(--color-muted)] truncate">{holding.companyName}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span
              className="mono text-[length:var(--text-meta)] font-medium tabular-nums"
              style={{ color: price > 0 ? (isUp ? "var(--color-bull)" : "var(--color-bear)") : "var(--color-muted)" }}
            >
              {price > 0 ? `${isUp ? "+" : ""}${fmt(gainLossPct, 1)}%` : "—"}
            </span>
            {!readOnly && (
              <RowActions
                ticker={holding.ticker}
                onEdit={onEdit ? () => onEdit(holding) : undefined}
                onRemove={() => setConfirming(true)}
              />
            )}
          </div>
        </div>

        {/* Sub row */}
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-[length:var(--text-meta)] text-[var(--color-muted)] tabular-nums">
            {fmt(holding.shares, holding.shares % 1 === 0 ? 0 : 2)} sh
            {portfolioPct !== undefined && portfolioPct > 0 && (
              <span className="ml-1 text-[var(--color-accent-medium)]">{fmt(portfolioPct, 1)}%</span>
            )}
          </span>
          <span className="mono text-[length:var(--text-meta)] text-[var(--color-text-secondary)] font-medium tabular-nums">
            {price > 0 ? `$${fmt(marketValue, 0)}` : `$${fmt(costBasis, 0)}`}
          </span>
        </div>

        {/* Expanded detail panel */}
        {expanded && (
          <div
            className="mt-2 pt-2 border-t border-[var(--color-border)] grid grid-cols-2 gap-x-3 gap-y-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <Stat label="Price" value={price > 0 ? `$${fmt(price)}` : "—"} />
            <Stat label="Day" value={quote ? `${isDayUp ? "+" : ""}${fmt(dayChange, 2)}%` : "—"} color={isDayUp ? "var(--color-bull)" : "var(--color-bear)"} />
            <Stat label="Avg cost" value={`$${fmt(holding.avgCost)}`} />
            <Stat label="Cost basis" value={`$${fmt(costBasis, 0)}`} />
            <Stat label="Gain / Loss" value={price > 0 ? `${gainLoss >= 0 ? "+" : ""}$${fmt(Math.abs(gainLoss), 0)}` : "—"} color={isUp ? "var(--color-bull)" : "var(--color-bear)"} />
            <Stat label="Mkt value" value={`$${fmt(marketValue, 0)}`} />
            {holding.sector && <Stat label="Sector" value={holding.sector} span text />}
            {readOnly && (
              <p className="col-span-2 text-[length:var(--text-micro)] text-[var(--color-muted)] mt-0.5">
                Synced from your brokerage — edit it there, or disconnect to manage it here.
              </p>
            )}
          </div>
        )}
      </div>
      {confirmDialog}
    </>
  );
}
