"use client";
import { useState } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Modal from "@/components/ui/Modal";
import { useToast } from "@/hooks/useToast";
import { addToPosition, replacePosition } from "@/lib/holdings";
import type { MergeMode } from "@/hooks/usePortfolio";
import type { Holding, HoldingFormData } from "@/types/portfolio";

interface Props {
  onClose: () => void;
  onAdd: (data: HoldingFormData) => Promise<void>;
  /** The position already on file for a ticker, if any. */
  findExisting?: (ticker: string) => Holding | null;
  /** Apply the entered lot to an existing position — folded in, or replacing it. */
  onMerge?: (existing: Holding, incoming: HoldingFormData, mode: MergeMode) => Promise<void>;
}

function fmtShares(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
function fmtCost(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** One side of the add-vs-replace choice: what the position becomes. */
function OutcomeCard({ title, note, shares, avgCost, onPick, disabled, variant }: {
  title: string;
  note: string;
  shares: number;
  avgCost: number;
  onPick: () => void;
  disabled: boolean;
  variant: "primary" | "outline";
}) {
  return (
    <div
      className="flex flex-col gap-2 p-3 rounded-[var(--radius-md)]"
      style={{ border: "1px solid var(--color-border)", background: "var(--color-surface)" }}
    >
      <div>
        <p className="text-[length:var(--text-sm)] font-semibold text-[var(--color-text)]">{title}</p>
        <p className="text-[length:var(--text-meta)] text-[var(--color-muted)]">{note}</p>
      </div>
      <p className="mono text-[length:var(--text-meta)] text-[var(--color-text-secondary)] tabular-nums">
        → {fmtShares(shares)} sh @ {fmtCost(avgCost)}
      </p>
      <Button type="button" variant={variant} onClick={onPick} disabled={disabled} className="w-full">
        {title}
      </Button>
    </div>
  );
}

export default function AddHoldingModal({ onClose, onAdd, findExisting, onMerge }: Props) {
  const toast = useToast();
  const [form, setForm] = useState<HoldingFormData>({
    ticker: "",
    shares: 0,
    avgCost: 0,
    companyName: "",
    sector: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Set when the entered ticker is already in the book — re-adding must never
  // silently overwrite the existing lot, so the user picks what happens.
  const [duplicate, setDuplicate] = useState<Holding | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.ticker || form.shares <= 0) {
      setError("Ticker and shares are required");
      return;
    }
    setError("");

    const existing = findExisting?.(form.ticker) ?? null;
    if (existing && onMerge) {
      setDuplicate(existing);
      return;
    }

    setLoading(true);
    try {
      await onAdd(form);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add holding";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  async function resolveDuplicate(mode: MergeMode) {
    if (!duplicate || !onMerge) return;
    setLoading(true);
    setError("");
    try {
      await onMerge(duplicate, form, mode);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update holding";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  /* ── Duplicate-ticker decision step ──────────────────────────────────── */
  if (duplicate) {
    const incoming = { shares: form.shares, avgCost: form.avgCost };
    const added = addToPosition(duplicate, incoming);
    const replaced = replacePosition(duplicate, incoming);
    return (
      <Modal
        onClose={onClose}
        label={`${duplicate.ticker} is already in your portfolio`}
        className="w-full max-w-md p-6 mx-4 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-xl)] shadow-[var(--shadow-pop)]"
      >
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-text)] mb-1">
          You already hold {duplicate.ticker}
        </h2>
        <p className="text-[length:var(--text-sm)] text-[var(--color-text-secondary)] mb-4">
          Currently{" "}
          <span className="mono tabular-nums">
            {fmtShares(duplicate.shares)} sh @ {fmtCost(duplicate.avgCost)}
          </span>
          . You entered{" "}
          <span className="mono tabular-nums">
            {fmtShares(form.shares)} sh @ {fmtCost(form.avgCost)}
          </span>
          .
        </p>
        <div className="flex flex-col gap-3">
          <OutcomeCard
            title="Add to position"
            note="Keeps both lots; cost basis is share-weighted."
            shares={added.shares}
            avgCost={added.avgCost}
            onPick={() => resolveDuplicate("add")}
            disabled={loading}
            variant="primary"
          />
          <OutcomeCard
            title="Replace"
            note="Discards the existing lot and its cost basis."
            shares={replaced.shares}
            avgCost={replaced.avgCost}
            onPick={() => resolveDuplicate("replace")}
            disabled={loading}
            variant="outline"
          />
        </div>
        {error && <p className="text-[length:var(--text-sm)] text-[var(--color-bear)] mt-3">{error}</p>}
        <div className="flex gap-3 justify-end pt-4">
          <Button type="button" variant="ghost" onClick={() => setDuplicate(null)} disabled={loading}>
            Back
          </Button>
        </div>
      </Modal>
    );
  }

  /* ── Entry step ──────────────────────────────────────────────────────── */
  return (
    <Modal
      onClose={onClose}
      label="Add holding"
      className="w-full max-w-md p-6 mx-4 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-xl)] shadow-[var(--shadow-pop)]"
    >
        <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-text)] mb-5">Add Holding</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            label="Ticker Symbol"
            placeholder="AAPL"
            value={form.ticker}
            onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
            required
          />
          <Input
            label="Company Name (optional)"
            placeholder="Apple Inc."
            value={form.companyName ?? ""}
            onChange={(e) => setForm({ ...form, companyName: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Shares"
              type="number"
              placeholder="100"
              min="0"
              step="any"
              value={form.shares || ""}
              onChange={(e) => setForm({ ...form, shares: parseFloat(e.target.value) || 0 })}
              required
            />
            <Input
              label="Cost / share ($)"
              type="number"
              placeholder="150.00"
              min="0"
              step="any"
              value={form.avgCost || ""}
              onChange={(e) => setForm({ ...form, avgCost: parseFloat(e.target.value) || 0 })}
            />
          </div>
          <Input
            label="Sector (optional)"
            placeholder="Technology"
            value={form.sector ?? ""}
            onChange={(e) => setForm({ ...form, sector: e.target.value })}
          />
          {error && <p className="text-[length:var(--text-sm)] text-[var(--color-bear)]">{error}</p>}
          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Adding…" : "Add Holding"}
            </Button>
          </div>
        </form>
    </Modal>
  );
}
