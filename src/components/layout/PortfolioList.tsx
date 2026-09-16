"use client";
import { useState } from "react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useQuotes } from "@/hooks/useQuotes";
import EditHoldingModal from "@/components/portfolio/EditHoldingModal";
import type { Holding } from "@/types/portfolio";
import HoldingCard from "./HoldingCard";

interface Props {
  /** When true, renders compact holding rows without the summary header (hero lives in Sidebar) */
  compact?: boolean;
}

export default function PortfolioList({ compact = false }: Props) {
  const { holdings, isLoading, removeHolding, updateHolding, plaidConnected } = usePortfolio();
  const [editing, setEditing] = useState<Holding | null>(null);
  const tickers = holdings.map((h) => h.ticker);
  const { quoteMap } = useQuotes(tickers);

  const totalValue = holdings.reduce((sum, h) => {
    const price = quoteMap.get(h.ticker)?.price ?? 0;
    return sum + (price > 0 ? price * h.shares : h.avgCost * h.shares);
  }, 0);

  if (isLoading) {
    return (
      <div className="px-4 py-3 flex flex-col gap-2">
        {[85, 65].map((w, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="skeleton" style={{ width: 40, height: 16, borderRadius: "var(--radius-xs)" }} />
            <span className="skeleton" style={{ width: `${w}%`, height: 10, borderRadius: "var(--radius-xs)" }} />
          </div>
        ))}
      </div>
    );
  }

  if (holdings.length === 0) {
    return <p className="empty-note" style={{ padding: "12px 16px" }}>No holdings yet — use + to add</p>;
  }

  return (
    <div className="flex flex-col pb-2">
      {/* Holdings */}
      <div className={compact ? "" : "px-1"}>
        {holdings.map((h) => {
          const quote = quoteMap.get(h.ticker);
          const price = quote?.price ?? 0;
          const mv = price > 0 ? price * h.shares : h.avgCost * h.shares;
          const pct = totalValue > 0 ? (mv / totalValue) * 100 : 0;
          return (
            <HoldingCard
              key={h.id}
              holding={h}
              quote={quote}
              portfolioPct={pct}
              onRemove={removeHolding}
              onEdit={plaidConnected ? undefined : setEditing}
              compact={compact}
              readOnly={plaidConnected}
            />
          );
        })}
      </div>
      {/* Brokerage-synced positions are rebuilt on every sync, so they can't be
          edited here — say so rather than showing controls that won't stick. */}
      {plaidConnected && (
        <p className="empty-note" style={{ padding: "8px 16px 2px" }}>
          Synced from your brokerage — read-only here.
        </p>
      )}
      {editing && (
        <EditHoldingModal
          holding={editing}
          onSave={(patch) => updateHolding(editing.id, patch)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
