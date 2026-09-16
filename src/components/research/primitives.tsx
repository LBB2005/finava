"use client";
import type { CSSProperties, ReactNode, ButtonHTMLAttributes } from "react";
import { FACTORS, factorColor, gradeClass, type FactorScores } from "@/lib/research";
import type { Fact, SlimScore } from "@/lib/facts/types";
import { factTitle } from "@/lib/facts/format";

/* ── Lens panel — the house card with a surface header strip ────────── */

/** `.card-head` header strip: mono title, optional meta beside it, optional far-right node. */
export function PanelHeader({ title, meta, right }: { title: ReactNode; meta?: ReactNode; right?: ReactNode }) {
  return (
    <div className="card-head" style={{ justifyContent: "space-between" }}>
      <div className="flex items-center" style={{ gap: 9, minWidth: 0 }}>
        <span className="card-title mono">{title}</span>
        {meta && <span className="card-meta mono">{meta}</span>}
      </div>
      {right}
    </div>
  );
}

/** The research lens panel: `.card` + `.card-head` — replaces the inlined
 *  "1px border + radius + surface header strip" recipe. */
export function LensPanel({
  title,
  meta,
  right,
  style,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className="card" style={style}>
      <PanelHeader title={title} meta={meta} right={right} />
      {children}
    </div>
  );
}

/* ── Primary CTA — the one accent action per lens ─────────────────────
   `.btn-primary` sized up, in the research area's mono-uppercase voice. */

export function PrimaryCta({ children, style, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={"btn btn-primary" + (className ? " " + className : "")}
      style={{
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        fontWeight: 700,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** Chevron glyph for expand/collapse controls (replaces ▴/▾). */
export function Chevron({ up = false, size = 10 }: { up?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: up ? "rotate(180deg)" : undefined, flexShrink: 0 }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/* ── Spinner — one loading ring for every lens ──────────────────────── */

export function LensSpinner({ size = 28, style }: { size?: number; style?: CSSProperties }) {
  return (
    <div
      className="spin"
      style={{
        width: size,
        height: size,
        border: "2px solid var(--color-border)",
        borderTopColor: "currentColor",
        borderRadius: "50%",
        color: "var(--color-accent)",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

/* ── Show more / Show less control (Board tables + rails) ───────────── */

export function ShowMore({ expanded, onToggle, more }: { expanded: boolean; onToggle: () => void; more: number }) {
  return (
    <button className="b-showmore" onClick={onToggle}>
      {expanded ? "Show less" : `Show ${more} more`}
      <Chevron up={expanded} />
    </button>
  );
}

/* ── Grade badge ────────────────────────────────────────────────────── */

type BadgeSize = "sm" | "md" | "lg" | "xl";

const BADGE_DIMS: Record<BadgeSize, { w: number; h: number; f: number; r: string }> = {
  sm: { w: 26, h: 20, f: 12, r: "var(--radius-xs)" },
  md: { w: 34, h: 26, f: 14, r: "var(--radius-xs)" },
  lg: { w: 48, h: 38, f: 20, r: "var(--radius-sm)" },
  xl: { w: 76, h: 60, f: 34, r: "var(--radius-sm)" },
};

/** Grade chip — colour-coded A–F, sized by `size`. */
export function GradeBadge({ grade, size = "md" }: { grade: string; size?: BadgeSize }) {
  const d = BADGE_DIMS[size];
  return (
    <span
      className={"grade " + gradeClass(grade)}
      style={{ width: d.w, height: d.h, fontSize: d.f, borderRadius: d.r }}
    >
      {grade}
    </span>
  );
}

/** 0–100 arc gauge — 270° sweep with the score numeral centred. The Banner
 *  board's feature-pick treatment (borrowed from the Editorial direction). */
export function ArcGauge({ score, size = 130, stroke = 12 }: { score: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const a0 = 135;
  const sweep = 270;
  const rad = (d: number) => ((d - 180) * Math.PI) / 180;
  const pt = (deg: number): [number, number] => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];
  const arc = (from: number, to: number) => {
    const [x0, y0] = pt(from);
    const [x1, y1] = pt(to);
    const large = to - from > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  };
  const end = a0 + sweep * (Math.max(0, Math.min(100, score)) / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block", flexShrink: 0 }}>
      <path d={arc(a0, a0 + sweep)} fill="none" stroke="var(--color-surface-2)" strokeWidth={stroke} strokeLinecap="round" />
      <path d={arc(a0, end)} fill="none" stroke="var(--color-accent)" strokeWidth={stroke} strokeLinecap="round" />
      <text x={cx} y={cy - 2} textAnchor="middle" className="serif" style={{ fontSize: size * 0.3, fontWeight: 800, fill: "var(--color-accent)" }}>
        {score}
      </text>
      <text x={cx} y={cy + size * 0.16} textAnchor="middle" className="mono" style={{ fontSize: size * 0.072, fontWeight: 700, letterSpacing: "0.16em", fill: "var(--color-muted)" }}>
        SCORE
      </text>
    </svg>
  );
}

/** Compact vertical factor bars (terminal leaderboard cell). */
export function MiniBars({ f }: { f: FactorScores }) {
  return (
    <div className="flex items-center" style={{ gap: 4 }}>
      {FACTORS.map((fac) => (
        <div
          key={fac.key}
          title={fac.full + ": " + f[fac.key]}
          className="flex flex-col items-center"
          style={{ gap: 3, width: 18 }}
        >
          <div
            className="fbar-track"
            style={{ width: "100%", height: 22, display: "flex", alignItems: "flex-end", borderRadius: "var(--radius-xs)", background: "var(--color-surface-2)" }}
          >
            <div style={{ width: "100%", height: f[fac.key] + "%", background: factorColor(f[fac.key]), borderRadius: "var(--radius-xs)" }} />
          </div>
          <span className="mono" style={{ fontSize: 7.5, fontWeight: 700, color: "var(--color-muted)" }}>
            {fac.short}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Finava Score cell — the facts layer's canonical score for a row ───── */

/** The canonical Finava Score as a bar + number, or "—" with the reason on hover.
 *  Board rank comes from the factor composite; the score shown is always facts. */
export function FactScoreCell({
  fact,
  trackClass = "b-score-track",
  trackStyle,
}: {
  fact: Fact<SlimScore> | undefined;
  trackClass?: string;
  trackStyle?: CSSProperties;
}) {
  if (!fact?.value) {
    return (
      <span className="mono" title={fact?.note ?? "Not scored yet"} style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>
        —
      </span>
    );
  }
  const v = fact.value;
  return (
    <div title={factTitle(fact)} style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <div className={trackClass} style={trackStyle}>
        <div style={{ width: v.total + "%", height: "100%", borderRadius: 999, background: "var(--color-accent)" }} />
      </div>
      <span className="serif" style={{ fontSize: "var(--text-lg)", fontWeight: 800, color: "var(--color-text)", width: 24, textAlign: "right" }}>{v.total}</span>
    </div>
  );
}

/** Grade for a row from the facts score, or a muted dash. */
export function FactGradeCell({ fact }: { fact: Fact<SlimScore> | undefined }) {
  return fact?.value ? <GradeBadge grade={fact.value.grade} size="sm" /> : <span style={{ color: "var(--color-muted)" }}>—</span>;
}
