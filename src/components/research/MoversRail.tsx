"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { HORIZONS, fmtPct1, type HorizonKey, type Stock } from "@/lib/research";
import { ShowMore } from "./primitives";

type MoverRow = Stock & { move: number };

function RailList({
  title, rows, up, mx, count, tag, onOpen, loading = false, collapsed = 5, expandTo = 10,
}: {
  title: string; rows: MoverRow[]; up: boolean; mx: number; count: number; tag: string;
  onOpen: (t: string) => void; loading?: boolean; collapsed?: number; expandTo?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = up ? "var(--color-bull)" : "var(--color-bear)";
  const shown = rows.slice(0, expanded ? expandTo : collapsed);
  const more = Math.min(expandTo, rows.length) - collapsed;
  return (
    <div className="b-railsec">
      <div className="b-railhead">
        <span className="mono b-railtitle" style={{ color }}>{up ? "▲" : "▼"} {title}</span>
        <span className="mono b-railcount">{count} · {tag}</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty-note">
          {loading
            ? "Syncing…"
            : `No ${up ? "gainers" : "laggards"} on this horizon yet.`}
        </div>
      ) : (
        shown.map((s, i) => (
          <div key={s.ticker} className="b-railrow" onClick={() => onOpen(s.ticker)}>
            <span className="mono b-rail-rank">{String(i + 1).padStart(2, "0")}</span>
            <span className="mono b-rail-tk">{s.ticker}</span>
            <div className="b-rail-track"><div style={{ width: (Math.abs(s.move) / mx) * 100 + "%", height: "100%", borderRadius: 999, background: color }} /></div>
            <span className="mono b-rail-val" style={{ color }}>{fmtPct1(s.move)}</span>
          </div>
        ))
      )}
      {more > 0 && <ShowMore expanded={expanded} onToggle={() => setExpanded((e) => !e)} more={more} />}
    </div>
  );
}

/** Gainers / Laggards rail — ranked one-line movers for the active horizon, each
 *  with a magnitude bar; Show more reveals the rest. */
export default function MoversRail({
  horizon,
  universe,
  loading = false,
}: {
  horizon: HorizonKey;
  universe: Stock[];
  loading?: boolean;
}) {
  const router = useRouter();
  const tag = HORIZONS.find((h) => h.key === horizon)?.tag ?? "1W";
  const { gainers, losers, mxG, mxL, adv, dec } = useMemo(() => {
    const all = universe.map((s) => ({ ...s, move: s.mv[horizon] }));
    const g = all.filter((s) => s.move >= 0).sort((a, b) => b.move - a.move);
    const l = all.filter((s) => s.move < 0).sort((a, b) => a.move - b.move);
    return {
      gainers: g,
      losers: l,
      mxG: Math.max(...g.map((s) => s.move), 1),
      mxL: Math.max(...l.map((s) => Math.abs(s.move)), 1),
      adv: g.length,
      dec: l.length,
    };
  }, [horizon, universe]);

  const onOpen = (t: string) => router.push(`/stock/${t}`);

  return (
    <div className="b-rail">
      <RailList title="GAINERS" rows={gainers} up mx={mxG} count={adv} tag={tag} onOpen={onOpen} loading={loading} />
      <RailList title="LAGGARDS" rows={losers} up={false} mx={mxL} count={dec} tag={tag} onOpen={onOpen} loading={loading} />
    </div>
  );
}
