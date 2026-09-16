"use client";
import { useMemo, useRef, useState } from "react";
import { FACTORS, type RankedStock, type Stock } from "@/lib/research";
import { applyScreen, type ScreenFilter } from "@/lib/screen";
import { authFetch } from "@/lib/authFetch";
import type { ScreenCommentary, SuggestedScreen } from "@/lib/researchAI";
import LadderRow from "./LadderRow";
import { useTickerFactsSlim } from "@/hooks/useTickerFacts";
import { LensPanel, LensSpinner, PrimaryCta, Chevron } from "./primitives";

type Status = "idle" | "parsing" | "done" | "error";
const DEFAULT_VISIBLE = 25;

/** Compact digest of the tape so the suggest agent grounds its ideas. */
function universeSummary(universe: Stock[]): string {
  if (universe.length === 0) return "No data yet.";
  const bySector = new Map<string, Stock[]>();
  for (const s of universe) {
    (bySector.get(s.sector) ?? bySector.set(s.sector, []).get(s.sector)!).push(s);
  }
  const sectorMom = [...bySector.entries()]
    .map(([sec, list]) => ({ sec, mom: Math.round(list.reduce((a, s) => a + s.f.mom, 0) / list.length), val: Math.round(list.reduce((a, s) => a + s.f.value, 0) / list.length) }))
    .sort((a, b) => b.mom - a.mom);
  const up = universe.filter((s) => s.chg > 0).length;
  const breadth = Math.round((up / universe.length) * 100);
  const lead = sectorMom.slice(0, 2).map((x) => `${x.sec} (mom ${x.mom})`).join(", ");
  const lag = sectorMom.slice(-2).map((x) => `${x.sec} (mom ${x.mom})`).join(", ");
  const cheap = [...sectorMom].sort((a, b) => b.val - a.val)[0];
  return `Breadth: ${breadth}% of names up today. Momentum leaders: ${lead}. Momentum laggards: ${lag}. Cheapest sector by valuation score: ${cheap?.sec}.`;
}

export default function ScreenMode({ universe, loading }: { universe: Stock[]; loading: boolean }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [filter, setFilter] = useState<ScreenFilter | null>(null);
  const [interpretation, setInterpretation] = useState("");
  const [commentary, setCommentary] = useState<ScreenCommentary | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestedScreen[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const suggestedRef = useRef(false);

  const results: RankedStock[] | null = useMemo(
    () => (filter && universe.length ? applyScreen(universe, filter) : null),
    [filter, universe]
  );

  // Suggested screens cost credits, so they are fetched on the user's first
  // intent to screen (focusing the box) rather than on merely opening the lens.
  // Once per mount, and never before real scores exist to summarise.
  async function loadSuggestions() {
    if (suggestedRef.current || universe.length === 0) return;
    suggestedRef.current = true;
    try {
      const res = await authFetch("/api/research/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "suggest", summary: universeSummary(universe) }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.screens)) setSuggestions(data.screens);
    } catch {
      /* suggestions are a nicety — silent on failure */
    }
  }

  async function run(query: string) {
    const text = query.trim();
    if (!text || loading) return;
    setQ(text);
    setStatus("parsing");
    setErr(null);
    setCommentary(null);
    setShowAll(false);
    try {
      const res = await authFetch("/api/research/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "parse", query: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const f = data.filter as ScreenFilter;
      setFilter(f);
      setInterpretation(data.interpretation ?? "");
      setStatus("done");

      // Fire commentary on the resulting basket (best-effort).
      const matched = applyScreen(universe, f);
      if (matched.length) {
        const top = matched.slice(0, 20).map((s) => ({ ticker: s.ticker, name: s.name, sector: s.sector, score: s.score }));
        authFetch("/api/research/screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "commentary", query: text, stocks: top }),
        })
          .then((r) => r.json())
          .then((c) => { if (c && (c.commentary || c.standout)) setCommentary(c as ScreenCommentary); })
          .catch(() => {});
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not run that screen.");
      setStatus("error");
    }
  }

  const visible = showAll ? results?.length ?? 0 : DEFAULT_VISIBLE;
  const slim = useTickerFactsSlim((results ?? []).slice(0, visible).map((s) => s.ticker));
  const activeFactors = filter?.factors ? Object.keys(filter.factors) : [];

  return (
    <div className="flex" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
      {/* ── Query + results ─────────────────────────────────────── */}
      <LensPanel
        title="ASK THE SCREENER"
        right={results ? <span className="card-meta mono">{results.length} matches</span> : undefined}
        style={{ flex: "1 1 480px", minWidth: 320 }}
      >
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          <form onSubmit={(e) => { e.preventDefault(); run(q); }} style={{ display: "flex", gap: 8 }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onFocus={loadSuggestions}
              placeholder={loading ? "Loading S&P 500…" : "e.g. cheap profitable tech with momentum and low debt"}
              disabled={loading}
              className="input mono"
              style={{ flex: 1, padding: "9px 12px", background: "var(--color-surface)" }}
            />
            <PrimaryCta
              type="submit"
              disabled={loading || status === "parsing" || !q.trim()}
              style={{ padding: "0 16px" }}
            >
              {status === "parsing" ? "…" : "RUN"}
            </PrimaryCta>
          </form>

          {/* Suggested screens */}
          {suggestions.length > 0 && (
            <div className="flex" style={{ gap: 6, flexWrap: "wrap" }}>
              {suggestions.map((s) => (
                <button key={s.label} className="tbtn" title={s.rationale} onClick={() => run(s.query)} style={{ maxWidth: 240 }}>
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {interpretation && status === "done" && (
            <div style={{ fontSize: "var(--text-meta)", color: "var(--color-text-secondary)", lineHeight: 1.5, padding: "8px 10px", background: "var(--color-surface)", borderRadius: "var(--radius-sm)", border: "1px solid var(--color-border)" }}>
              <span className="mono" style={{ color: "var(--color-accent)", fontWeight: 700, fontSize: "var(--text-micro)", letterSpacing: "0.08em" }}>READING · </span>
              {interpretation}
              {activeFactors.length > 0 && (
                <span style={{ color: "var(--color-muted)" }}>{"  ·  factors: " + activeFactors.map((k) => FACTORS.find((f) => f.key === k)?.short ?? k).join(", ")}</span>
              )}
            </div>
          )}

          {status === "error" && (
            <div className="flex items-center" style={{ gap: 8 }}>
              <p style={{ fontSize: "var(--text-sm)", color: "var(--color-bear)" }}>{err}</p>
              <button className="tbtn" onClick={() => run(q)}>Retry</button>
            </div>
          )}

          {status === "parsing" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="skeleton" style={{ height: 30 }} />
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="skeleton" style={{ height: 34 }} />
              ))}
            </div>
          ) : results == null ? (
            <div className="flex flex-col items-center justify-center" style={{ minHeight: 240, padding: 24, textAlign: "center", gap: 8 }}>
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <p className="serif" style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--color-text)" }}>Describe what you&apos;re hunting for</p>
              <p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)", maxWidth: 340, lineHeight: 1.5 }}>
                Type it in plain English — Finava turns it into a factor screen and runs it across the whole S&amp;P 500.
              </p>
            </div>
          ) : results.length === 0 ? (
            <div className="empty-note flex flex-col items-center justify-center" style={{ minHeight: 240 }}>
              No names match that screen. Try loosening the criteria.
            </div>
          ) : (
            <div style={{ overflowX: "auto", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}>
              <table className="lad-table" style={{ minWidth: 620, width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", width: 36 }}>#</th>
                    <th style={{ textAlign: "left", width: 160 }}>Ticker</th>
                    <th style={{ textAlign: "right", width: 68 }}>Last</th>
                    <th style={{ textAlign: "right", width: 60 }}>Chg</th>
                    <th style={{ textAlign: "center", width: 132 }}>Factor profile</th>
                    <th style={{ textAlign: "left" }}>Score</th>
                    <th style={{ textAlign: "center", width: 48 }}>Grd</th>
                  </tr>
                </thead>
                <tbody>
                  {results.slice(0, visible).map((s) => (
                    <LadderRow key={s.ticker} s={s} fs={slim.map.get(s.ticker)?.score} highlight={s.rank <= 3} />
                  ))}
                </tbody>
              </table>
              {results.length > DEFAULT_VISIBLE && (
                <div className="flex justify-center" style={{ padding: "10px 0", borderTop: "1px solid var(--color-border)" }}>
                  <button className="tbtn" onClick={() => setShowAll((v) => !v)} style={{ gap: 5 }}>
                    {showAll ? "Show top 25" : `Show all ${results.length}`}
                    <Chevron up={showAll} size={9} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </LensPanel>

      {/* ── Basket read ─────────────────────────────────────────── */}
      <LensPanel
        title="BASKET READ"
        right={<span className="card-meta mono" style={{ letterSpacing: "0.08em" }}>AI COLOR</span>}
        style={{ flex: "1 1 300px", minWidth: 280, maxWidth: 400 }}
      >
        <div style={{ padding: 16 }}>
          {commentary ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {commentary.commentary && <p className="serif" style={{ fontSize: "var(--text-body)", lineHeight: 1.55, color: "var(--color-text)" }}>{commentary.commentary}</p>}
              {commentary.standout && <p style={{ fontSize: "var(--text-sm)", lineHeight: 1.5, color: "var(--color-text-secondary)" }}><span className="mono" style={{ color: "var(--color-bull)", fontWeight: 700, fontSize: "var(--text-micro)", letterSpacing: "0.08em" }}>STANDOUT · </span>{commentary.standout}</p>}
              {commentary.watchout && <p style={{ fontSize: "var(--text-sm)", lineHeight: 1.5, color: "var(--color-text-secondary)" }}><span className="mono" style={{ color: "var(--color-warn)", fontWeight: 700, fontSize: "var(--text-micro)", letterSpacing: "0.08em" }}>WATCH · </span>{commentary.watchout}</p>}
            </div>
          ) : status === "done" && results && results.length > 0 ? (
            <div className="flex items-center" style={{ gap: 8, minHeight: 80 }}>
              <LensSpinner size={18} />
              <p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>Reading the basket…</p>
            </div>
          ) : (
            <p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)", lineHeight: 1.5, minHeight: 80 }}>
              Run a screen and Finava writes a short read on what the surviving names have in common.
            </p>
          )}
        </div>
      </LensPanel>
    </div>
  );
}
