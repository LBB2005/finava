"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ALL_CONSTITUENTS } from "@/lib/extraUniverse";
import { sanitizeSymbol, searchStocks } from "@/lib/stockSearch";

const MAX_RESULTS = 7;

/**
 * The Research page's lookup hero — type a ticker or company name, hit Enter,
 * land on that stock's page. Suggestions come from the scannable universe
 * (instant, no network), but a free-typed symbol outside it still routes: the
 * stock page resolves any symbol server-side.
 *
 * Matching goes through the shared `searchStocks` helper, so a query ranks the
 * same way everywhere in the app (exact ticker → ticker prefix → name match).
 */
export default function ResearchSearch() {
  const router = useRouter();
  const [val, setVal] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const results = useMemo(
    () => searchStocks(val, ALL_CONSTITUENTS, MAX_RESULTS),
    [val],
  );

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  function go(sym: string) {
    const t = sanitizeSymbol(sym);
    if (!t) return;
    setOpen(false);
    router.push(`/stock/${t}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(open && results[active] ? results[active].ticker : val);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative" style={{ maxWidth: 560 }}>
      <svg
        className="absolute left-[14px] top-1/2 -translate-y-1/2 pointer-events-none"
        width="16" height="16" viewBox="0 0 24 24" fill="none"
        stroke="var(--color-muted)" strokeWidth="2" strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
      </svg>
      <input
        value={val}
        onChange={(e) => { setVal(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => val && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Look up any stock — ticker or company name"
        role="combobox"
        aria-label="Search for a stock"
        aria-autocomplete="list"
        aria-expanded={open && results.length > 0}
        aria-controls={listboxId}
        spellCheck={false}
        className="w-full bg-transparent focus:outline-none"
        style={{
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-surface)",
          color: "var(--color-text)",
          padding: "11px 14px 11px 40px",
          fontSize: "var(--text-sm)",
        }}
      />

      {open && results.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+6px)] overflow-hidden"
          style={{
            zIndex: 20,
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-pop)",
          }}
        >
          {results.map((s, i) => (
            <li
              key={s.ticker}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); go(s.ticker); }}
              className="flex items-center gap-3 cursor-pointer"
              style={{
                padding: "9px 14px",
                background: i === active ? "var(--color-surface-2)" : "transparent",
              }}
            >
              <span className="tk" style={{ fontSize: "var(--text-sm)", minWidth: 54 }}>{s.ticker}</span>
              <span
                style={{
                  fontSize: "var(--text-meta)",
                  color: "var(--color-text-secondary)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                {s.name}
              </span>
              <span className="mono ml-auto" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
                {s.sector}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
