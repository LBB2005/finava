"use client";
import { memo, useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtPct1, fmtMktCap, type HorizonKey, type RankedStock, type Stock } from "@/lib/research";
import { boardRanking, boardStatusLabel } from "@/lib/verdict";
import { GradeBadge, ShowMore } from "./primitives";

// Ranked rows are rebuilt as fresh objects on every 30s live-data poll, so a
// plain memo never bails — compare the fields the row actually renders.
const Row = memo(function Row({ s, onOpen }: { s: RankedStock; onOpen: (t: string) => void }) {
  const up = s.chg >= 0;
  return (
    <tr
      className={"b-row" + (s.rank <= 3 ? " top3" : "")}
      onClick={() => onOpen(s.ticker)}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(s.ticker); }}
    >
      <td className="mono" style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: s.rank <= 3 ? "var(--color-accent)" : "var(--color-muted)" }}>
        {String(s.rank).padStart(2, "0")}
      </td>
      <td>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span className="tk" style={{ fontSize: "var(--text-sm)" }}>{s.ticker}</span>
          <span className="b-rowname">{s.name}</span>
        </span>
      </td>
      <td className="mono num" style={{ fontSize: "var(--text-sm)", color: "var(--color-text)" }}>{s.price.toFixed(2)}</td>
      <td className="mono num" style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: up ? "var(--color-bull)" : "var(--color-bear)" }}>{fmtPct1(s.chg)}</td>
      <td className="mono num" style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>{fmtMktCap(s.marketCap)}</td>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div className="b-score-track"><div style={{ width: s.score + "%", height: "100%", borderRadius: 999, background: "var(--color-accent)" }} /></div>
          <span className="serif" style={{ fontSize: "var(--text-lg)", fontWeight: 800, color: "var(--color-text)", width: 22, textAlign: "right" }}>{s.score}</span>
        </div>
      </td>
      <td style={{ textAlign: "center" }}><GradeBadge grade={s.grade} size="sm" /></td>
    </tr>
  );
}, (prev, next) =>
  prev.onOpen === next.onOpen &&
  prev.s.ticker === next.s.ticker &&
  prev.s.rank === next.s.rank &&
  prev.s.price === next.s.price &&
  prev.s.chg === next.s.chg &&
  prev.s.marketCap === next.s.marketCap &&
  prev.s.score === next.s.score &&
  prev.s.grade === next.s.grade
);

/** A name whose factor profile is a placeholder: listed, never ranked or scored. */
function UnrankedRow({ s, onOpen }: { s: Stock; onOpen: (t: string) => void }) {
  return (
    <tr className="b-row" onClick={() => onOpen(s.ticker)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen(s.ticker); }}>
      <td className="mono" style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>—</td>
      <td>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span className="tk" style={{ fontSize: "var(--text-sm)" }}>{s.ticker}</span>
          <span className="b-rowname">{s.name}</span>
        </span>
      </td>
      <td className="mono num" style={{ fontSize: "var(--text-sm)", color: "var(--color-text)" }}>{s.price > 0 ? s.price.toFixed(2) : "—"}</td>
      <td className="mono num" style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>{s.price > 0 ? fmtPct1(s.chg) : "—"}</td>
      <td className="mono num" style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>{fmtMktCap(s.marketCap)}</td>
      <td style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)", fontStyle: "italic" }}>Not enough data</td>
      <td style={{ textAlign: "center", color: "var(--color-muted)" }}>—</td>
    </tr>
  );
}

/** B1 leaderboard — the horizon-weighted board, collapsed to the top names with
 *  a Show more / Show less control. */
export default function BoardLeaderboard({
  horizon,
  universe,
  loading = false,
  collapsed = 7,
  expandTo = 14,
}: {
  horizon: HorizonKey;
  universe: Stock[];
  loading?: boolean;
  collapsed?: number;
  expandTo?: number;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  // Placeholder (insufficient-data) names are held out of the ranking entirely;
  // they only appear, unranked, once the ranked names run out.
  const { ranked: rows, notEnoughData } = useMemo(() => boardRanking(horizon, universe), [horizon, universe]);
  const limit = expanded ? expandTo : collapsed;
  const shown = rows.slice(0, limit);
  const shownUnranked = notEnoughData.slice(0, Math.max(0, limit - shown.length));
  const total = rows.length + notEnoughData.length;
  const more = Math.min(expandTo, total) - collapsed;
  const status = boardStatusLabel(loading);
  const onOpen = useCallback((t: string) => router.push(`/stock/${t}`), [router]);

  return (
    <div className="b-board">
      <div className="b-boardhead">
        <span className="mono b-boardtitle">LEADERBOARD</span>
        <span className="mono b-boardmeta">weighted {horizon.toUpperCase()}</span>
        <span
          className="mono b-live"
          style={{ color: status === "LIVE" ? "var(--color-bull)" : "var(--color-muted)", display: "inline-flex", alignItems: "center", gap: 5 }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6, height: 6, borderRadius: 999, flexShrink: 0,
              background: status === "LIVE" ? "currentColor" : "transparent",
              border: status === "LIVE" ? "none" : "1px solid currentColor",
            }}
          />
          {status}
        </span>
      </div>
      {total === 0 ? (
        <div className="empty-note flex flex-col items-center justify-center" style={{ minHeight: 240 }}>
          No names on the board yet — the leaderboard fills in once the S&amp;P 500 data loads.
        </div>
      ) : (
        <table className="b-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>#</th>
              <th style={{ width: 198 }}>Ticker</th>
              <th className="num" style={{ width: 78 }}>Last</th>
              <th className="num" style={{ width: 64 }}>Chg</th>
              <th className="num" style={{ width: 84 }}>Mkt Cap</th>
              <th style={{ minWidth: 132 }}>Finava Score</th>
              <th style={{ textAlign: "center", width: 46 }}>Grd</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => <Row key={s.ticker} s={s} onOpen={onOpen} />)}
            {shownUnranked.map((s) => <UnrankedRow key={s.ticker} s={s} onOpen={onOpen} />)}
          </tbody>
        </table>
      )}
      {notEnoughData.length > 0 && (
        <p className="mono" style={{ margin: "8px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
          {notEnoughData.length} {notEnoughData.length === 1 ? "name" : "names"} not ranked · Not enough data
        </p>
      )}
      {more > 0 && <ShowMore expanded={expanded} onToggle={() => setExpanded((e) => !e)} more={more} />}
    </div>
  );
}
