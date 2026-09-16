"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import type { GlossaryMarks } from "@/lib/glossary";

/**
 * A jargon term with its plain-English definition one tap away. 17 of 50 beta
 * testers hit a term they could not decode; the underline is the affordance and
 * the popover is the answer, without sending anyone to a separate glossary page.
 *
 * Desktop opens on hover or focus, mobile on tap — it is a real button either
 * way, so keyboard and screen-reader users get the same definition.
 */
export function GlossaryTerm({ term, definition, children }: { term: string; definition: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline" }}>
      <button
        type="button"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="std-focus glossary-term"
        style={{
          font: "inherit",
          color: "inherit",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "help",
          textDecoration: "underline",
          textDecorationStyle: "dotted",
          textDecorationThickness: "from-font",
          textUnderlineOffset: "3px",
          textDecorationColor: "var(--color-accent-medium)",
        }}
      >
        {children}
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="fade-in"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            zIndex: 40,
            width: "min(280px, 76vw)",
            display: "block",
            padding: "9px 11px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-border-strong)",
            background: "var(--color-bg)",
            boxShadow: "var(--shadow-pop)",
            // The popover can sit inside the serif lede — it sets its own type
            // rather than inheriting display styling.
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            lineHeight: 1.5,
            letterSpacing: "normal",
            color: "var(--color-text-secondary)",
            fontWeight: 400,
            textAlign: "left",
            whiteSpace: "normal",
          }}
        >
          <span
            className="eyebrow-label"
            style={{ display: "block", color: "var(--color-accent)", marginBottom: 3 }}
          >
            {term}
          </span>
          {definition}
        </span>
      )}
    </span>
  );
}

/**
 * Wrap the first occurrence of each glossary term in a run of text. `marks` is
 * shared across one message so a term is underlined once, not on every mention,
 * and gives the same result when React renders the same tree twice.
 */
export function decorateGlossary(node: React.ReactNode, marks: GlossaryMarks): React.ReactNode {
  if (typeof node === "string") {
    const hits = marks.hits(node);
    if (!hits.length) return node;
    const out: React.ReactNode[] = [];
    let cursor = 0;
    hits.forEach((hit, i) => {
      if (hit.start > cursor) out.push(node.slice(cursor, hit.start));
      out.push(
        <GlossaryTerm key={`${hit.term}-${i}`} term={hit.term} definition={hit.definition}>
          {node.slice(hit.start, hit.end)}
        </GlossaryTerm>
      );
      cursor = hit.end;
    });
    if (cursor < node.length) out.push(node.slice(cursor));
    return out;
  }
  if (Array.isArray(node)) {
    return node.map((child, i) => <React.Fragment key={i}>{decorateGlossary(child, marks)}</React.Fragment>);
  }
  return node;
}
