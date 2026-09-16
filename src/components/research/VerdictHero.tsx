"use client";
import Link from "next/link";
import { HORIZONS, fmtPct1, type HorizonKey, type RankedStock } from "@/lib/research";
import { verdictFor, heroTag, priceMoveLabel, SIGNAL_STRENGTH_HELP, type Verdict } from "@/lib/verdict";
import { ArcGauge, GradeBadge } from "./primitives";
import { useTickerFactsSlim } from "@/hooks/useTickerFacts";
import { factTitle } from "@/lib/facts/format";

/** Three-dot signal-strength indicator — 3 = Strong, 2 = Moderate, 1 = Weak. */
function StrengthDots({ level }: { level: Verdict["signalStrength"] }) {
  const on = level === "Strong" ? 3 : level === "Moderate" ? 2 : 1;
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 6, height: 6, borderRadius: 99, background: i < on ? "var(--color-bull)" : "var(--color-surface-2)" }} />
      ))}
    </span>
  );
}

/**
 * B1 hero — the horizon's highest-scoring name (never a "pick") across one strip: arc gauge +
 * identity, live price, and the rule-based factor read filling the middle.
 * The rank and the rule-based factor read come from the universe's factor
 * scores; the gauge and grade are the facts layer's Finava Score (the number the
 * stock page shows), or "—" until it has been computed. No price target is
 * implied here (the DCF on the stock page is the valuation surface).
 */
export default function VerdictHero({ feature, horizon }: { feature: RankedStock; horizon: HorizonKey }) {
  const tag = HORIZONS.find((h) => h.key === horizon)?.tag ?? "1W";
  const v = verdictFor(feature, horizon); // cheap arithmetic; the React Compiler memoizes
  const slim = useTickerFactsSlim([feature.ticker]);
  const fs = slim.map.get(feature.ticker)?.score;
  const up = feature.chg >= 0;
  const take = v.take.split(". ")[0] + ".";
  const horizonMove = feature.mv[horizon];
  const stanceColor = v.score >= 60 ? "var(--color-bull)" : v.score <= 44 ? "var(--color-bear)" : "var(--color-warn)";

  return (
    <div className="b1-hero">
      <div className="b1-pick">
        {fs?.value ? (
          <div title={factTitle(fs)}><ArcGauge score={fs.value.total} size={92} stroke={10} /></div>
        ) : (
          <div
            title={fs?.note ?? "Not scored yet"}
            className="serif"
            style={{ width: 92, height: 92, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-muted)", fontSize: "var(--text-stat)" }}
          >
            —
          </div>
        )}
        <div className="b1-id">
          <span className="mono b1-tag">{heroTag(tag)}</span>
          <div className="b1-idrow">
            <Link href={`/stock/${feature.ticker}`} className="tklink">
              <span className="serif b1-tk">{feature.ticker}</span>
            </Link>
            {fs?.value && <GradeBadge grade={fs.value.grade} size="md" />}
          </div>
          <span className="b1-name truncate">{feature.name}</span>
        </div>
      </div>

      <div className="b1-px">
        <span className="serif b1-price">${feature.price.toFixed(2)}</span>
        <span className="mono b1-chg" style={{ color: up ? "var(--color-bull)" : "var(--color-bear)" }}>
          {up ? "▲" : "▼"} {fmtPct1(feature.chg)} {priceMoveLabel()}
        </span>
      </div>

      <div className="b1-verdict">
        <div className="b1-verdict-head">
          <span className="mono b1-verdict-eyebrow">FACTOR READ</span>
          <span className="b1-stance" style={{ color: stanceColor, borderColor: `color-mix(in oklab, ${stanceColor} 36%, var(--color-border))` }}>
            {v.stance}
          </span>
          <span className="mono b1-conf" title={SIGNAL_STRENGTH_HELP} aria-label={`Signal strength ${v.signalStrength}. ${SIGNAL_STRENGTH_HELP}`}>
            Signal strength <StrengthDots level={v.signalStrength} />
          </span>
        </div>
        <p className="b1-take">{take}</p>
      </div>

      {/* Realised move over the active horizon — backward-looking fact from the
          price history, deliberately not a forecast. */}
      <div className="b1-val">
        <div className="b1-valrow">
          <span className="b1-vk">Factor rank</span>
          <span className="serif b1-vv">#{feature.rank}</span>
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
