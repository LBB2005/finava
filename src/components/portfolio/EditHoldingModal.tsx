"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import { useToast } from "@/hooks/useToast";
import type { Holding } from "@/types/portfolio";

/**
 * Edit an existing position: share count and per-share cost basis.
 *
 * Cost basis is entered **per share**, matching how the book stores it and how
 * Plaid reports it — the label says so, because entering a total here would
 * silently distort every return figure on the page.
 */
export default function EditHoldingModal({
  holding,
  onSave,
  onClose,
}: {
  holding: Holding;
  onSave: (patch: { shares: number; avgCost: number }) => Promise<void>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [shares, setShares] = useState(String(holding.shares));
  const [avgCost, setAvgCost] = useState(String(holding.avgCost));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const sharesNum = parseFloat(shares);
  const costNum = parseFloat(avgCost);
  const costBasis = Number.isFinite(sharesNum) && Number.isFinite(costNum) ? sharesNum * costNum : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!Number.isFinite(sharesNum) || sharesNum <= 0) {
      setError("Shares must be greater than zero.");
      return;
    }
    if (!Number.isFinite(costNum) || costNum < 0) {
      setError("Cost basis can't be negative.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({ shares: sharesNum, avgCost: costNum });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save changes";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  // Portalled to <body>: a holding row can sit inside a collapsed accordion or
  // an `overflow:hidden` card, which would clip a dialog rendered in place.
  // These dialogs only ever mount from a click, so `document` is always there —
  // the guard is just for a defensive server render.
  if (typeof document === "undefined") return null;

  return createPortal(
    <Modal
      onClose={onClose}
      label={`Edit ${holding.ticker}`}
      className="w-full max-w-md p-6 mx-4 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-xl)] shadow-[var(--shadow-pop)]"
    >
      <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-text)] mb-1">
        Edit {holding.ticker}
      </h2>
      <p className="text-[length:var(--text-sm)] text-[var(--color-muted)] mb-5">
        {holding.companyName ?? "Manual position"}
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Shares"
            type="number"
            min="0"
            step="any"
            value={shares}
            onChange={(e) => setShares(e.target.value)}
            required
          />
          <Input
            label="Cost basis / share ($)"
            type="number"
            min="0"
            step="any"
            value={avgCost}
            onChange={(e) => setAvgCost(e.target.value)}
            required
          />
        </div>
        <p className="text-[length:var(--text-meta)] text-[var(--color-muted)]">
          {costBasis == null
            ? "Total cost basis: Unavailable"
            : `Total cost basis: $${costBasis.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
        </p>
        {error && <p className="text-[length:var(--text-sm)] text-[var(--color-bear)]">{error}</p>}
        <div className="flex gap-3 justify-end pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Modal>,
    document.body
  );
}
