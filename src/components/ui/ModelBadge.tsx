"use client";

import { type Brand, type RunMeta, BRAND_META, brandRole, slugToBrand } from "@/lib/models";

// Stylized, monochrome brand glyphs (16×16, drawn with currentColor so the brand
// accent tints them). Distinct silhouettes for at-a-glance recognition; the short
// label carries the rest. Swap in official brand SVGs later if desired.
const GLYPHS: Record<Brand, React.ReactNode> = {
  claude: (
    <g stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <line x1={8} y1={1.5} x2={8} y2={14.5} />
      <line x1={2.4} y1={4.7} x2={13.6} y2={11.3} />
      <line x1={2.4} y1={11.3} x2={13.6} y2={4.7} />
    </g>
  ),
  openai: (
    <>
      <path d="M8 1.6 L13.6 4.8 V11.2 L8 14.4 L2.4 11.2 V4.8 Z" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
      <circle cx={8} cy={8} r={1.5} fill="currentColor" />
    </>
  ),
  gemini: (
    <path
      d="M8 0.5 C8.4 4.4 9.6 5.6 13.5 8 C9.6 10.4 8.4 11.6 8 15.5 C7.6 11.6 6.4 10.4 2.5 8 C6.4 5.6 7.6 4.4 8 0.5 Z"
      fill="currentColor"
    />
  ),
  grok: (
    <path d="M3 13 L13 3 M6.5 13 L13 6.5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
  ),
  perplexity: (
    <g fill="none" stroke="currentColor" strokeWidth={1.4}>
      <circle cx={8} cy={8} r={3.1} />
      <path d="M8 1.9 V14.1 M2.5 5.1 V10.9 M13.5 5.1 V10.9" strokeLinecap="round" />
    </g>
  ),
};

/**
 * "Powered by Claude · GPT · Gemini …" roster strip, shared by both surfaces.
 * Tooltip roles come from `run` (what actually ran); without it, no role claim.
 */
export function PoweredByStrip({ brands, run, className }: { brands: Brand[]; run?: RunMeta; className?: string }) {
  if (!brands.length) return null;
  return (
    <div
      className={className}
      style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}
    >
      <span
        className="mono"
        style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-muted)" }}
      >
        Powered by
      </span>
      {brands.map((b) => (
        <span key={b} style={{ display: "inline-flex", alignItems: "center", gap: 4 }} title={brandRole(b, run) ?? undefined}>
          <ModelGlyph brand={b} size={12} />
          <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--color-text-secondary)" }}>
            {BRAND_META[b].label}
          </span>
        </span>
      ))}
    </div>
  );
}

export function ModelGlyph({ brand, size = 12 }: { brand: Brand; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ color: BRAND_META[brand].accent, flexShrink: 0, display: "block" }}
    >
      {GLYPHS[brand]}
    </svg>
  );
}

export interface ModelBadgeProps {
  /** Display brands (server-computed, supports pipelines like Perplexity → Gemini). */
  brands?: Brand[];
  /** Or a raw OpenRouter slug for the single-model case. */
  slug?: string;
  /** Show the short brand label next to the glyph. */
  showLabel?: boolean;
  /** Glyph size in px. */
  size?: number;
  /** Dim the badge (e.g. an agent that hasn't run yet). */
  dim?: boolean;
  /** Gentle pulse — used for the live "lighting up" state while an agent runs. */
  lit?: boolean;
  title?: string;
}

/**
 * A small model-attribution pill. Renders one brand, or a pipeline (A → B) when
 * given multiple brands. Sized to the existing 10–10.5px badge convention.
 */
export default function ModelBadge({
  brands,
  slug,
  showLabel = true,
  size = 12,
  dim = false,
  lit = false,
  title,
}: ModelBadgeProps) {
  const list = brands ?? (slug ? [slugToBrand(slug)] : []);
  if (!list.length) return null;

  return (
    <span
      className={lit ? "model-badge-lit" : undefined}
      title={title ?? list.map((b) => BRAND_META[b].label).join(" → ")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.01em",
        lineHeight: 1,
        opacity: dim ? 0.5 : 1,
        transition: "opacity 0.25s ease",
        whiteSpace: "nowrap",
      }}
    >
      {list.map((b, i) => (
        <span key={b} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {i > 0 && (
            <span aria-hidden="true" style={{ color: "var(--color-muted)", fontSize: 9 }}>
              →
            </span>
          )}
          <ModelGlyph brand={b} size={size} />
          {showLabel && (
            <span style={{ color: "var(--color-text-secondary)" }}>{BRAND_META[b].short}</span>
          )}
        </span>
      ))}
    </span>
  );
}
