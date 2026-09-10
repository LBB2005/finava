"use client";
import { useMemo } from "react";
import Link from "next/link";
import { HORIZONS, fmtPct1, type HorizonKey, type RankedStock } from "@/lib/research";
import { verdictFor } from "@/lib/verdict";
import { ArcGauge, GradeBadge } from "./primitives";

/** Three-dot confidence indicator — 3 = High, 2 = Moderate, 1 = Low. */
function ConfidenceDots({ level }: { level: "High" | "Moderate" | "Low" }) {
  const on = level === "High" ? 3 : level === "Moderate" ? 2 : 1;
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 6, height: 6, borderRadius: 99, background: i < on ? "var(--color-bull)" : "var(--color-surface-2)" }} />
      ))}
    </span>
  );
}

/**
 * B1 hero — the horizon's top-ranked name across one strip: arc gauge +
 * identity, live price, and the rule-based factor read filling the middle.
 * Everything shown is derived from the factor scores; no price target is
 * implied here (the DCF on the stock page is the valuation surface).
 */
export default function VerdictHero({ feature, horizon }: { feature: RankedStock; horizon: HorizonKey }) {
  const tag = HORIZONS.find((h) => h.key === horizon)?.tag ?? "1W";
  const v = useMemo(() => verdictFor(feature, horizon), [feature, horizon]);
  const up = feature.chg >= 0;
  const take = v.take.split(". ")[0] + ".";
  const horizonMove = feature.mv[horizon];
  const stanceColor = v.score >= 60 ? "var(--color-bull)" : v.score <= 44 ? "var(--color-bear)" : "var(--color-warn)";

  return (
    <div className="b1-hero">
      <div className="b1-pick">
        <ArcGauge score={feature.score} size={92} stroke={10} />
        <div className="b1-id">
          <span className="mono b1-tag">{tag} · TOP PICK</span>
          <div className="b1-idrow">
            <Link href={`/stock/${feature.ticker}`} className="tklink">
              <span className="serif b1-tk">{feature.ticker}</span>
            </Link>
            <GradeBadge grade={feature.grade} size="md" />
          </div>
          <span className="b1-name truncate">{feature.name}</span>
        </div>
      </div>

      <div className="b1-px">
        <span className="serif b1-price">${feature.price.toFixed(2)}</span>
        <span className="mono b1-chg" style={{ color: up ? "var(--color-bull)" : "var(--color-bear)" }}>
          {up ? "▲" : "▼"} {fmtPct1(feature.chg)} today
        </span>
      </div>

      <div className="b1-verdict">
        <div className="b1-verdict-head">
          <span className="mono b1-verdict-eyebrow">FACTOR READ</span>
          <span className="b1-stance" style={{ color: stanceColor, borderColor: `color-mix(in oklab, ${stanceColor} 36%, var(--color-border))` }}>
            {v.stance}
          </span>
          <span className="mono b1-conf">
            Confidence <ConfidenceDots level={v.confidence} />
          </span>
        </div>
        <p className="b1-take">{take}</p>
      </div>

      {/* Realised move over the active horizon — backward-looking fact from the
          price history, deliberately not a forecast. */}
      <div className="b1-val">
        <div className="b1-valrow">
          <span className="b1-vk">Factor score</span>
          <span className="serif b1-vv">{feature.score}</span>
        </div>
        <div className="b1-valrow">
          <span className="b1-vk">{tag} return</span>
          <span className="mono b1-vu" style={{ color: horizonMove >= 0 ? "var(--color-bull)" : "var(--color-bear)" }}>
            {fmtPct1(horizonMove)}
          </span>
        </div>
      </div>
    </div>
  );
}
