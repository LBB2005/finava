"use client";
import React, { useState } from "react";
import { authFetch } from "@/lib/authFetch";
import {
  EXPERIENCE_LEVELS,
  EXPERIENCE_LABELS,
  EXPERIENCE_BLURBS,
  type ExperienceLevel,
} from "@/lib/experienceLevel";

/**
 * The one question asked at first run. It decides how much gets explained —
 * nothing else — so it is a single tap with no "skip for now" guilt, and it
 * disappears for good once answered.
 */
export default function ExperienceQuestion({
  onAnswered,
}: {
  onAnswered?: (level: ExperienceLevel) => void;
}) {
  const [saving, setSaving] = useState<ExperienceLevel | null>(null);

  async function choose(level: ExperienceLevel) {
    setSaving(level);
    try {
      await authFetch("/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experienceLevel: level }),
      });
    } catch {
      // A failed save is not worth blocking first run over — the default holds
      // and Settings can set it later.
    }
    onAnswered?.(level);
  }

  return (
    <div
      className="fade-in"
      style={{
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-xl)",
        background: "var(--color-bg)",
        padding: "14px 16px",
        marginBottom: 20,
      }}
    >
      <p
        style={{
          margin: 0,
          fontFamily: "var(--font-serif)",
          fontSize: "var(--text-title)",
          fontWeight: 600,
          color: "var(--color-text)",
        }}
      >
        How familiar are you with investing?
      </p>
      <p style={{ margin: "3px 0 11px", fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>
        It only changes how much Finava explains — never which numbers you see. Change it any time in Settings.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {EXPERIENCE_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            disabled={saving !== null}
            onClick={() => choose(level)}
            className="std-focus followup-chip"
            title={EXPERIENCE_BLURBS[level]}
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              fontSize: "var(--text-sm)",
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: saving ? "default" : "pointer",
              opacity: saving && saving !== level ? 0.5 : 1,
              transition: "all 140ms",
            }}
          >
            {EXPERIENCE_LABELS[level]}
          </button>
        ))}
      </div>
    </div>
  );
}
