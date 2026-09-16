"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/ui/Button";
import Modal from "@/components/ui/Modal";

/**
 * Standard confirm step for a destructive portfolio action. Built on the shared
 * Modal shell (focus trap, ESC, backdrop close) and the house button variants,
 * so "Remove holding" looks and behaves like every other dialog in the app.
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel = "Remove",
  cancelLabel = "Cancel",
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** May be async — the confirm button shows a pending state until it settles. */
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
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
      label={title}
      className="w-full max-w-sm p-6 mx-4 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-xl)] shadow-[var(--shadow-pop)]"
    >
      <h2 className="text-[length:var(--text-lg)] font-semibold text-[var(--color-text)] mb-2">{title}</h2>
      <div className="text-[length:var(--text-sm)] text-[var(--color-text-secondary)] mb-5">{body}</div>
      {error && <p className="text-[length:var(--text-sm)] text-[var(--color-bear)] mb-3">{error}</p>}
      <div className="flex gap-3 justify-end">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button type="button" variant="danger" onClick={confirm} disabled={busy}>
          {busy ? "Removing…" : confirmLabel}
        </Button>
      </div>
    </Modal>,
    document.body
  );
}
