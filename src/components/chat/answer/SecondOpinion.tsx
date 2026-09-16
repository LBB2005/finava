"use client";
import React, { useState } from "react";
import { PROBLEM_LABELS, parseSkepticReport, summarizeSkeptic } from "@/lib/skepticReport";
import type { SkepticIssue } from "@/types/chat";
import Markdown from "../Markdown";

/**
 * The second opinion, after W3-2.
 *
 * It used to paste the reviewer's prose next to the report, which is how 23
 * testers ended up reading a critique that contradicted the answer above it.
 * Now the corrections are already folded into the answer, so this is a receipt:
 * one line saying what the review did, expandable to the findings. A review that
 * didn't run says that instead of showing nothing.
 */

function IssueList({ title, issues }: { title: string; issues: SkepticIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="eyebrow-label" style={{ color: "var(--color-muted)", marginBottom: 6 }}>
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
        {issues.map((issue, i) => (
          <li key={`${issue.quote}-${i}`} style={{ fontSize: "var(--text-sm)", color: "var(--color-text)" }}>
            <span style={{ fontWeight: 600 }}>{PROBLEM_LABELS[issue.problem] ?? "Issue"}: </span>
            <span style={{ color: "var(--color-muted)" }}>&ldquo;{issue.quote}&rdquo;</span>
            {issue.evidence && (
              <span style={{ color: "var(--color-muted)" }}> — {issue.evidence}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SecondOpinion({ critique }: { critique: string }) {
  const [open, setOpen] = useState(false);
  const report = parseSkepticReport(critique);

  // A conversation written before W3-2 stored free markdown here. Render it the
  // way it was written rather than dropping it.
  if (!report) {
    return (
      <Shell tone="warn">
        <Markdown style={{ color: "var(--color-warn-text)" }}>{critique}</Markdown>
      </Shell>
    );
  }

  const didNotRun = report.status !== "reviewed";
  const issues = [...report.corrections, ...report.caveats];
  const expandable = !didNotRun && issues.length > 0;

  return (
    <Shell tone={didNotRun ? "muted" : "warn"}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: "var(--text-sm)",
            color: didNotRun ? "var(--color-muted)" : "var(--color-warn-text)",
          }}
        >
          {summarizeSkeptic(report)}
        </span>
        {expandable && (
          <button
            type="button"
            onClick={() => setOpen((w) => !w)}
            aria-expanded={open}
            className="std-focus"
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              fontSize: "var(--text-sm)",
              fontWeight: 600,
              color: "var(--color-warn-heading)",
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            {open ? "Hide" : "What it found"}
          </button>
        )}
      </div>

      {open && expandable && (
        <div className="fade-in">
          <IssueList title="Corrected in this answer" issues={report.corrections} />
          <IssueList title="Left as a caveat" issues={report.caveats} />
        </div>
      )}
    </Shell>
  );
}

/* ── The callout frame ──────────────────────────────────────────────────── */
function Shell({ tone, children }: { tone: "warn" | "muted"; children: React.ReactNode }) {
  const warn = tone === "warn";
  return (
    <div
      style={{
        borderRadius: "var(--radius-md)",
        border: `1px solid ${warn ? "var(--color-warn-border)" : "var(--color-border)"}`,
        background: warn ? "var(--color-warn-bg)" : "var(--color-surface-2)",
        padding: "12px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <svg
          width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true"
          style={{ color: warn ? "var(--color-warn)" : "var(--color-muted)", flexShrink: 0 }}
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span
          className="eyebrow-label"
          style={{ color: warn ? "var(--color-warn-heading)" : "var(--color-muted)" }}
        >
          Second Opinion
        </span>
      </div>
      {children}
    </div>
  );
}
