"use client";
import React from "react";
import Markdown from "../Markdown";

/**
 * Bull and bear, side by side on desktop and stacked on a phone. Reading them
 * as one balanced pair is the point — a report that lists the bull case, then
 * eight hundred words, then the bear case reads as an argument, not research.
 */
export default function CaseColumns({
  bull,
  bear,
  glossary,
}: {
  bull?: string;
  bear?: string;
  glossary?: boolean;
}) {
  if (!bull && !bear) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-[14px]">
      {bull !== undefined && <CaseColumn tone="bull" title="Bull case" body={bull} glossary={glossary} />}
      {bear !== undefined && <CaseColumn tone="bear" title="Bear case" body={bear} glossary={glossary} />}
    </div>
  );
}

function CaseColumn({
  tone,
  title,
  body,
  glossary,
}: {
  tone: "bull" | "bear";
  title: string;
  body: string;
  glossary?: boolean;
}) {
  const color = tone === "bull" ? "var(--color-bull)" : "var(--color-bear)";
  return (
    <section
      style={{
        border: "1px solid var(--color-border)",
        borderTop: `2px solid color-mix(in oklab, ${color} 55%, transparent)`,
        borderRadius: "var(--radius-lg)",
        background: "var(--color-bg)",
        padding: "11px 14px 4px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {tone === "bull" ? (
            <><polyline points="3 17 9 11 13 15 21 7" /><polyline points="15 7 21 7 21 13" /></>
          ) : (
            <><polyline points="3 7 9 13 13 9 21 17" /><polyline points="15 17 21 17 21 11" /></>
          )}
        </svg>
        <span className="eyebrow-label" style={{ color }}>{title}</span>
      </div>
      {body.trim() ? (
        <Markdown glossary={glossary}>{body}</Markdown>
      ) : (
        <p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)", paddingBottom: 8 }}>Still writing…</p>
      )}
    </section>
  );
}
