"use client";
import Link from "next/link";
import { fmtPct1, type RankedStock } from "@/lib/research";
import { FactGradeCell, FactScoreCell, MiniBars } from "./primitives";
import type { Fact, SlimScore } from "@/lib/facts/types";

/** One leaderboard / match row — shared by the Board and the Screen results table. */
/** `fs` is the facts layer's cached score; rank still comes from the factor composite. */
export default function LadderRow({ s, fs, highlight = false }: { s: RankedStock; fs?: Fact<SlimScore>; highlight?: boolean }) {
  return (
    <tr className={highlight ? "top3" : ""}>
      <td className="mono" style={{ textAlign: "left", fontSize: "var(--text-sm)", fontWeight: 600, color: highlight ? "var(--color-accent)" : "var(--color-muted)" }}>
        {String(s.rank).padStart(2, "0")}
      </td>
      <td style={{ textAlign: "left", overflow: "hidden" }}>
        <Link href={`/stock/${s.ticker}`} className="tklink" style={{ display: "flex", alignItems: "baseline", gap: 6, overflow: "hidden" }}>
          <span className="tk" style={{ fontSize: "var(--text-sm)", flexShrink: 0 }}>{s.ticker}</span>
          <span style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
        </Link>
      </td>
      <td className="mono" style={{ textAlign: "right", fontSize: "var(--text-sm)", color: "var(--color-text)" }}>{s.price.toFixed(2)}</td>
      <td className="mono" style={{ textAlign: "right", fontSize: "var(--text-sm)", fontWeight: 600, color: s.chg >= 0 ? "var(--color-bull)" : "var(--color-bear)" }}>
        {fmtPct1(s.chg)}
      </td>
      <td><div className="flex justify-center"><MiniBars f={s.f} /></div></td>
      <td><FactScoreCell fact={fs} trackClass="fbar-track" trackStyle={{ flex: 1, height: 7 }} /></td>
      <td style={{ textAlign: "center" }}><div className="flex justify-center"><FactGradeCell fact={fs} /></div></td>
    </tr>
  );
}
