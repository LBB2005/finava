"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ALL_CONSTITUENTS } from "@/lib/extraUniverse";
import { sanitizeSymbol, searchStocks } from "@/lib/stockSearch";

interface Props {
  onAdd: (ticker: string) => void;
  /** Tickers already in the list — excluded from suggestions. */
  existing?: string[];
}

const MAX_RESULTS = 8;

/**
 * Compact add-ticker control with a live suggestion popover. Matches the site's
 * popover styling (the chat composer's "+" menu is the reference). Filters the
 * scannable universe by ticker or company name; ↑/↓ to move, Enter to add,
 * Esc to close.
 */
export default function AddTickerSearch({ onAdd, existing = [] }: Props) {
  const [val, setVal] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const have = useMemo(() => new Set(existing.map((t) => t.toUpperCase())), [existing]);

  // Drop already-listed tickers before ranking, so the capped result set is
  // never padded out with names the user cannot add.
  const pool = useMemo(
    () => ALL_CONSTITUENTS.filter((c) => !have.has(c.ticker.toUpperCase())),
    [have],
  );

  const results = useMemo(() => searchStocks(val, pool, MAX_RESULTS), [val, pool]);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  function commit(sym: string) {
    const t = sanitizeSymbol(sym);
    if (!t) return;
    onAdd(t);
    setVal("");
    setOpen(false);
    inputRef.current?.focus();
  }

  function submit() {
    if (results[active]) commit(results[active].ticker);
    else commit(val);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showPopover = open && results.length > 0;

  return (
    <div ref={wrapRef} className="relative" style={{ width: 220 }}>
      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          background: "var(--color-bg)",
          border: `1px solid ${open ? "var(--color-accent-medium)" : "var(--color-border)"}`,
          borderRadius: "var(--radius-sm)", padding: "4px 4px 4px 10px",
          transition: "border-color 140ms",
        }}
      >
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
        <input
          ref={inputRef}
          value={val}
          onChange={(e) => { setVal(e.target.value.toUpperCase()); setActive(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search ticker or company…"
          className="mono"
          role="combobox"
          aria-expanded={showPopover}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-label="Search to add a ticker"
          style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: "var(--text-sm)", letterSpacing: "0.04em", color: "var(--color-text)", minWidth: 0 }}
        />
        <button
          type="submit"
          aria-label="Add ticker"
          style={{
            width: 26, height: 26, borderRadius: "var(--radius-xs)", border: "none",
            background: val ? "var(--color-accent)" : "var(--color-surface-2)",
            color: val ? "var(--color-on-accent)" : "var(--color-muted)", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </form>

      {showPopover && (
        <div
          role="listbox"
          id={listboxId}
          className="popover absolute left-0 right-0 mt-1.5 z-50 overflow-hidden fade-in"
          style={{ top: "100%" }}
        >
          {results.map((s, i) => (
            <button
              key={s.ticker}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); commit(s.ticker); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left bg-transparent transition-colors duration-100"
              style={{ background: i === active ? "var(--color-accent-light)" : "transparent" }}
            >
              <span className="mono" style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--color-text)", width: 52, flexShrink: 0 }}>{s.ticker}</span>
              <span className="truncate" style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)", flex: 1, minWidth: 0 }}>{s.name}</span>
              <span className="mono" style={{ fontSize: "var(--text-micro)", flexShrink: 0, color: "var(--color-muted)" }}>
                {s.sector}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
