"use client";
import React, { useState } from "react";
import Markdown from "../Markdown";

/**
 * Everything below the answer, folded away. 26 of 50 testers called the reports
 * far too long; none of them wanted the work thrown out, so it stays one click
 * away — and the click is remembered for the rest of the session, per message,
 * so scrolling back does not re-collapse what someone opened.
 */
const OPENED = new Set<string>();

export default function DetailsExpander({
  id,
  markdown,
  label = "Show full analysis",
  glossary,
}: {
  /** Message id — the memory key for this expander's open state. */
  id: string;
  markdown: string;
  label?: string;
  glossary?: boolean;
}) {
  const [open, setOpen] = useState(() => OPENED.has(id));
  if (!markdown.trim()) return null;

  function toggle() {
    setOpen((was) => {
      const next = !was;
      if (next) OPENED.add(id);
      else OPENED.delete(id);
      return next;
    });
  }

  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="std-focus followup-chip"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          padding: "7px 13px",
          borderRadius: 999,
          fontSize: "var(--text-sm)",
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          transition: "border-color 140ms, background 140ms, color 140ms",
        }}
      >
        {open ? "Hide full analysis" : label}
        <svg
          width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ transition: "transform 200ms ease", transform: open ? "rotate(180deg)" : "none" }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          className="fade-in"
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <Markdown glossary={glossary}>{markdown}</Markdown>
        </div>
      )}
    </section>
  );
}
