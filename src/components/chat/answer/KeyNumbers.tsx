"use client";
import React from "react";
import type { KeyNumberRow } from "@/lib/answerFormat";
import { sourceLink } from "@/lib/facts/citations";

/**
 * The numbers behind the verdict, with where each came from and when. Source
 * and as-of ride as small muted chips so the figure stays the loud thing, and a
 * missing number renders as a styled "Unavailable" — never an error, never a
 * plausible stand-in. When the number came from a fact with a primary source
 * (a filing index, a Form 4 list), its source chip links there.
 */
export default function KeyNumbers({ rows }: { rows: KeyNumberRow[] }) {
  if (!rows.length) return null;

  return (
    <section>
      <div className="eyebrow-label" style={{ color: "var(--color-muted)", marginBottom: 8 }}>
        Key numbers
      </div>
      <div
        style={{
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
          background: "var(--color-bg)",
        }}
      >
        {rows.map((row, i) => (
          <div
            key={`${row.metric}-${i}`}
            className="key-number-row"
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 14,
              flexWrap: "wrap",
              padding: "10px 13px",
              borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
            }}
          >
            <span
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--color-text-secondary)",
                minWidth: "8ch",
              }}
            >
              {row.metric}
            </span>

            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0, maxWidth: "100%" }}>
              {row.unavailable ? (
                <span
                  style={{
                    fontSize: "var(--text-meta)",
                    color: "var(--color-muted)",
                    border: "1px dashed var(--color-border-strong)",
                    borderRadius: 999,
                    padding: "1px 9px",
                    letterSpacing: "0.01em",
                  }}
                >
                  Unavailable
                </span>
              ) : (
                <span
                  style={{
                    fontSize: "var(--text-title)",
                    fontWeight: 650,
                    color: "var(--color-text)",
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {row.value}
                </span>
              )}

              {(row.source || row.asOf) && (
                <span style={{ display: "inline-flex", gap: 5, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", minWidth: 0, maxWidth: "100%" }}>
                  {row.source && <SourceChip source={row.source} />}
                  {row.asOf && <Chip muted>{row.asOf}</Chip>}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceChip({ source }: { source: string }) {
  const { label, href } = sourceLink(source);
  if (!href) return <Chip>{label}</Chip>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="std-focus"
      title={`Open source: ${label}`}
      style={{ textDecoration: "none", borderRadius: 999, display: "inline-flex", minWidth: 0, maxWidth: "100%" }}
    >
      <Chip linked>{label} ↗</Chip>
    </a>
  );
}

function Chip({ children, muted, linked }: { children: React.ReactNode; muted?: boolean; linked?: boolean }) {
  return (
    <span
      style={{
        fontSize: "var(--text-micro)",
        fontWeight: 600,
        letterSpacing: "0.02em",
        color: muted ? "var(--color-muted)" : linked ? "var(--color-accent)" : "var(--color-text-secondary)",
        background: muted ? "transparent" : "var(--color-surface)",
        border: `1px solid ${muted ? "transparent" : "var(--color-border)"}`,
        borderRadius: 999,
        padding: "1px 7px",
        whiteSpace: "nowrap",
        // A long source name truncates rather than pushing the figure off a phone screen.
        display: "inline-block",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </span>
  );
}
