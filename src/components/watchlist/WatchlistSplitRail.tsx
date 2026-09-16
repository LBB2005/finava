"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWatchlists } from "@/hooks/useWatchlists";
import { useWatchlistStore } from "@/stores/watchlistStore";
import { useToast } from "@/hooks/useToast";
import { useLiveBoard } from "@/hooks/useLiveBoard";
import { useFactorUniverse } from "@/hooks/useFactorUniverse";
import { useTickerFactsSlim } from "@/hooks/useTickerFacts";
import { factTitle } from "@/lib/facts/format";
import type { Fact, SlimScore } from "@/lib/facts/types";
import { type FactorScores } from "@/lib/research";
import { CONSTITUENT_BY_TICKER } from "@/lib/extraUniverse";
import ScorePill from "@/components/ui/ScorePill";
import ChatContextButton from "@/components/chat/ChatContextButton";
import PageHeader from "@/components/layout/PageHeader";
import AddTickerSearch from "@/components/watchlist/AddTickerSearch";
import { useChatStore } from "@/stores/chatStore";
import { buildWatchlistSnapshot } from "@/lib/pageContext";

// ─── Data helpers ────────────────────────────────────────────────────────────

function scoreTierColor(s: number): string {
  if (s >= 80) return "var(--color-bull)";
  if (s >= 70) return "color-mix(in oklab, var(--color-bull) 78%, var(--color-warn))";
  if (s >= 60) return "var(--color-warn)";
  return "var(--color-bear)";
}

const SIGNAL_TONE = {
  alert: { color: "var(--color-bear)", bg: "color-mix(in oklab, var(--color-bear) 11%, transparent)" },
  earn:  { color: "var(--color-accent)", bg: "var(--color-accent-light)" },
  up:    { color: "var(--color-bull)", bg: "color-mix(in oklab, var(--color-bull) 11%, transparent)" },
  cross: { color: "var(--color-warn)", bg: "var(--color-warn-bg)" },
  high:  { color: "var(--color-bull)", bg: "color-mix(in oklab, var(--color-bull) 9%, transparent)" },
} as const;

type SignalKind = keyof typeof SIGNAL_TONE;

/** Drawn glyph per signal kind — house icon voice (24-box, stroke 2, currentColor). */
function SignalIcon({ k, size = 10 }: { k: SignalKind; size?: number }) {
  const paths: Record<SignalKind, React.ReactNode> = {
    alert: (
      <>
        <line x1="12" y1="4" x2="12" y2="14" />
        <line x1="12" y1="19" x2="12.01" y2="19" />
      </>
    ),
    earn: (
      <>
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15 14" />
      </>
    ),
    up: (
      <>
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </>
    ),
    cross: (
      <>
        <line x1="12" y1="5" x2="12" y2="19" />
        <polyline points="8 9 12 5 16 9" />
        <polyline points="8 15 12 19 16 15" />
      </>
    ),
    high: (
      <polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.6 5.8 21 7 14 2 9.3 9 8.5 12 2" />
    ),
  };
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
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      {paths[k]}
    </svg>
  );
}

interface Signal {
  k: SignalKind;
  label: string;
}

function deriveSignals(changePct: number | null, f: FactorScores | null): Signal[] {
  const sigs: Signal[] = [];
  if (changePct !== null) {
    if (changePct < -2.5) sigs.push({ k: "alert", label: `Down ${Math.abs(changePct).toFixed(1)}% today` });
    else if (changePct > 2.5) sigs.push({ k: "up", label: `Up ${changePct.toFixed(1)}% today` });
  }
  if (f) {
    if (f.analyst >= 78) sigs.push({ k: "high", label: "Strong analyst coverage" });
    else if (f.mom >= 80) sigs.push({ k: "high", label: "Momentum breakout" });
  }
  return sigs.slice(0, 1);
}

// ─── Primitives ──────────────────────────────────────────────────────────────

function SignalChip({ sig }: { sig: Signal }) {
  const tone = SIGNAL_TONE[sig.k];
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: "var(--text-micro)", fontWeight: 600,
        color: tone.color, background: tone.bg,
        padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap", letterSpacing: "0.01em",
      }}
    >
      <SignalIcon k={sig.k} />
      {sig.label}
    </span>
  );
}

// ─── Table ───────────────────────────────────────────────────────────────────

const COLS = ["Ticker", "Finava", "Last", "Day", "Mkt Cap"] as const;
const RIGHT_COLS = new Set(["Last", "Day", "Mkt Cap"]);

function fmtCap(cap: number | null): string {
  if (cap == null) return "—";
  if (cap >= 1e12) return `$${(cap / 1e12).toFixed(1)}T`;
  return `$${(cap / 1e9).toFixed(1)}B`;
}

function TableHead() {
  return (
    <thead>
      <tr>
        {COLS.map((h) => (
          <th
            key={h}
            className="mono"
            style={{
              textAlign: RIGHT_COLS.has(h) ? "right" : "left",
              fontSize: "var(--text-micro)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
              color: "var(--color-muted)", padding: "8px 12px",
              borderBottom: "1px solid var(--color-border)",
              whiteSpace: "nowrap",
            }}
          >
            {h}
          </th>
        ))}
        <th style={{ width: 30, borderBottom: "1px solid var(--color-border)" }} />
      </tr>
    </thead>
  );
}

interface RowData {
  ticker: string;
  name: string;
  price: number | null;
  changePct: number | null;
  marketCap: number | null;
  f: FactorScores | null;
  /** The facts layer's cached Finava Score; null until computed. */
  score: number | null;
  scoreFact: Fact<SlimScore> | null;
  signals: Signal[];
}

function TableRow({ data, isLast, onRemove, onClick }: {
  data: RowData;
  isLast: boolean;
  onRemove: (t: string) => void;
  onClick: (t: string) => void;
}) {
  const up = (data.changePct ?? 0) >= 0;
  const fmtPrice = data.price == null
    ? "—"
    : `$${data.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtChange = data.changePct == null
    ? "—"
    : `${data.changePct >= 0 ? "+" : ""}${data.changePct.toFixed(2)}%`;

  return (
    <tr
      className="portfolio-row std-focus"
      onClick={() => onClick(data.ticker)}
      style={{
        borderBottom: isLast ? "none" : "1px solid var(--color-border)",
        cursor: "pointer",
      }}
    >
      {/* Ticker chip + company name — mirrors the portfolio holdings table */}
      <td style={{ padding: "8px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            fontSize: "var(--text-meta)", fontWeight: 700, letterSpacing: "0.04em",
            color: "var(--color-accent)", background: "var(--color-accent-light)",
            padding: "3px 7px", borderRadius: "var(--radius-xs)",
          }}>{data.ticker}</span>
          <span style={{
            fontSize: "var(--text-sm)", color: "var(--color-text-secondary)",
            maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {data.name}
          </span>
        </div>
      </td>
      {/* Finava score — the facts layer's cached score, "—" until computed */}
      <td style={{ padding: "8px 12px" }}>
        {data.score != null
          ? <span title={data.scoreFact ? factTitle(data.scoreFact) : undefined}><ScorePill score={data.score} /></span>
          : <span className="mono" title={data.scoreFact?.note} style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>—</span>}
      </td>
      {/* Last price */}
      <td className="mono" style={{ textAlign: "right", fontSize: "var(--text-sm)", color: "var(--color-text)", padding: "8px 12px", fontVariantNumeric: "tabular-nums" }}>
        {fmtPrice}
      </td>
      {/* Day % */}
      <td className="mono" style={{
        textAlign: "right", padding: "8px 12px",
        fontSize: "var(--text-sm)", fontWeight: 600, fontVariantNumeric: "tabular-nums",
        color: data.changePct == null ? "var(--color-muted)" : up ? "var(--color-bull)" : "var(--color-bear)",
      }}>
        {fmtChange}
      </td>
      {/* Market cap */}
      <td className="mono" style={{ textAlign: "right", fontSize: "var(--text-sm)", color: "var(--color-text)", padding: "8px 12px", fontVariantNumeric: "tabular-nums" }}>
        {fmtCap(data.marketCap)}
      </td>
      <td style={{ padding: "8px 10px", textAlign: "right" }}>
        <button
          aria-label={`Remove ${data.ticker}`}
          onClick={(e) => { e.stopPropagation(); onRemove(data.ticker); }}
          className="wl-x"
          style={{ width: 20, height: 20, border: "none", background: "transparent", color: "var(--color-muted)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </td>
    </tr>
  );
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

function RailSection({ title, count, children }: {
  title: string; count?: number; children: React.ReactNode;
}) {
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px",
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)",
      }}>
        <p className="eyebrow-label" style={{ color: "var(--color-muted)", margin: 0 }}>{title}</p>
        {count != null && (
          <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── Insight stat — bare label/value pair, mirrors the portfolio stat row ────

function InsightStat({ label, value, accent }: {
  label: string; value: string; accent?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginRight: 24 }}>
      <span className="mono" style={{ fontSize: "var(--text-micro)", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--color-muted)", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <span className="mono" style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: accent ?? "var(--color-text)", lineHeight: 1, whiteSpace: "nowrap" }}>
        {value}
      </span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function WatchlistSplitRail() {
  const router = useRouter();
  const toast = useToast();
  const { watchlists, isLoading, error, createWatchlist, updateWatchlist, deleteWatchlist, addTicker, removeTicker } = useWatchlists();
  const { activeId, setActiveId } = useWatchlistStore();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (error) toast.error("Couldn't load your watchlists. Check your connection and retry.");
  }, [error, toast]);

  useEffect(() => {
    if (watchlists.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId || !watchlists.some((w) => w.id === activeId)) {
      setActiveId(watchlists[0].id);
    }
  }, [watchlists, activeId, setActiveId]);

  const active = watchlists.find((w) => w.id === activeId) ?? null;
  const tickers = active?.tickers ?? [];

  // Publish the active watchlist as app-wide page context, so a chat sent here
  // ("which of these looks strongest?") is scoped to these names.
  useEffect(() => {
    const setActivePageContext = useChatStore.getState().setActivePageContext;
    if (active) {
      setActivePageContext({
        kind: "watchlist",
        label: active.name,
        snapshot: buildWatchlistSnapshot(active.name, active.tickers),
      });
    }
    return () => setActivePageContext(null);
  }, [active?.id, active?.name, tickers.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const { liveMap } = useLiveBoard(tickers);
  const { universe } = useFactorUniverse();
  const slim = useTickerFactsSlim(tickers);

  // Build enriched row data
  const rows: RowData[] = tickers.map((ticker) => {
    const live = liveMap.get(ticker);
    const stock = universe?.find((s) => s.ticker === ticker) ?? null;
    const f = stock?.f ?? null;
    const changePct = live?.changePct ?? null;
    const scoreFact = slim.map.get(ticker)?.score ?? null;
    const sc = scoreFact?.value?.total ?? null;
    const signals = deriveSignals(changePct, f);
    return {
      ticker,
      name: CONSTITUENT_BY_TICKER.get(ticker)?.name ?? ticker,
      price: live?.price ?? null,
      changePct,
      marketCap: live?.marketCap ?? null,
      f,
      score: sc,
      scoreFact,
      signals,
    };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.ticker.localeCompare(b.ticker));

  // Insight summary
  const n = rows.length;
  const changes = rows.map((r) => r.changePct).filter((c): c is number => c != null);
  const gainers = changes.filter((c) => c >= 0).length;
  const avg = changes.length ? changes.reduce((s, c) => s + c, 0) / changes.length : null;
  const signalCount = rows.reduce((s, r) => s + r.signals.length, 0);

  // Rail data
  const movers = [...rows].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
  const topMover = movers[0] ?? null;
  const worstMover = movers.length > 1 ? movers[movers.length - 1] : null;
  const feed = rows.flatMap((r) => r.signals.map((sig) => ({ ...sig, ticker: r.ticker })));

  async function handleCreate() {
    try {
      const created = await createWatchlist("New watchlist");
      setActiveId(created.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create watchlist.");
    }
  }

  function startRename() {
    setDraft(active?.name ?? "");
    setRenaming(true);
  }
  function commitRename() {
    if (active && draft.trim()) updateWatchlist(active.id, { name: draft.trim() });
    setRenaming(false);
  }

  async function handleDelete() {
    if (!active) return;
    if (!window.confirm(`Delete "${active.name}"?`)) return;
    try {
      await deleteWatchlist(active.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete watchlist.");
    }
  }

  return (
    <div className="research-root term" style={{ height: "100%", background: "var(--color-bg)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Standardized page header — list tabs + management controls, with the
          KPI strip as the standardized second row */}
      <PageHeader
        title="Watchlist"
        subtitle={`${n} TICKER${n !== 1 ? "S" : ""} · ${gainers} GREEN TODAY`}
        center={
          watchlists.length > 0 ? (
            <div className="b-lenses b-lenses-pill">
              {watchlists.map((w) => (
                <button key={w.id} className={"b-lens" + (w.id === activeId ? " on" : "")} onClick={() => setActiveId(w.id)}>
                  {w.name}
                </button>
              ))}
            </div>
          ) : undefined
        }
        actions={
          <>
            {active && !renaming && (
              <button className="btn btn-ghost" onClick={startRename}>
                Rename
              </button>
            )}
            {renaming && (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(false); }}
                className="tsel mono"
                style={{ width: 160 }}
              />
            )}
            {active && !renaming && (
              <button className="btn btn-danger" onClick={handleDelete}>
                Delete
              </button>
            )}
            <button className="tbtn" onClick={handleCreate} style={{ gap: 5 }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New
            </button>
            <span className="mono b-asof">
              {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
            <button className="tbtn on" onClick={() => router.push("/chat")}>
              ASK AI
            </button>
            <ChatContextButton context="watchlist" />
          </>
        }
        secondRow={
          active ? (
            <>
              <InsightStat
                label="Avg day"
                value={avg == null ? "—" : `${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%`}
                accent={avg == null ? undefined : avg >= 0 ? "var(--color-bull)" : "var(--color-bear)"}
              />
              <InsightStat
                label="Top mover"
                value={topMover?.changePct == null ? "—" : `${topMover.ticker} ${topMover.changePct >= 0 ? "+" : ""}${topMover.changePct.toFixed(2)}%`}
                accent={topMover?.changePct == null ? undefined : topMover.changePct >= 0 ? "var(--color-bull)" : "var(--color-bear)"}
              />
              <InsightStat
                label="Worst mover"
                value={worstMover?.changePct == null ? "—" : `${worstMover.ticker} ${worstMover.changePct >= 0 ? "+" : ""}${worstMover.changePct.toFixed(2)}%`}
                accent={worstMover?.changePct == null ? undefined : worstMover.changePct >= 0 ? "var(--color-bull)" : "var(--color-bear)"}
              />
              <div style={{ marginLeft: "auto" }}>
                <AddTickerSearch
                  existing={active?.tickers ?? []}
                  onAdd={(t) => active && addTicker(active.id, t)}
                />
              </div>
            </>
          ) : undefined
        }
      />

      {/* Scroll region — the soft top fade is owned by PageHeader */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>

        {isLoading ? (
          // Skeleton rows shaped like the board table while lists load
          <div style={{ padding: "var(--content-pad-top) var(--page-gutter)", display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="skeleton" style={{ height: 38, borderRadius: "var(--radius-md)" }} />
            {[92, 78, 86, 70, 82, 64].map((w, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <span className="skeleton" style={{ width: 52, height: 16, borderRadius: "var(--radius-xs)" }} />
                <span className="skeleton" style={{ width: `${w}%`, height: 12, borderRadius: "var(--radius-xs)" }} />
              </div>
            ))}
          </div>
        ) : watchlists.length === 0 ? (
          // No lists state
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, padding: "40px 24px", textAlign: "center" }}>
            <p style={{ fontSize: "var(--text-body)", color: "var(--color-text)", fontFamily: "var(--font-serif)", fontWeight: 700 }}>No watchlists yet</p>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>Create a list to start tracking stocks you care about.</p>
            <button className="btn btn-primary" onClick={handleCreate}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Create watchlist
            </button>
          </div>
        ) : tickers.length === 0 ? (
          // Empty list state
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, padding: "40px 24px", textAlign: "center" }}>
            <p style={{ fontSize: "var(--text-body)", color: "var(--color-text)", fontFamily: "var(--font-serif)", fontWeight: 700 }}>Nothing in {active?.name ?? "this list"} yet</p>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--color-text-secondary)" }}>Add a ticker using the search bar above.</p>
          </div>
        ) : (
          // Split rail layout
          <div style={{ height: "100%", overflowY: "auto", scrollbarGutter: "stable both-edges", padding: "var(--content-pad-top) var(--page-gutter) var(--content-pad-bottom)", display: "grid", gridTemplateColumns: "minmax(0,1fr) 268px", gap: 16, alignItems: "start" }}>
            {/* Table — same card chrome as the portfolio holdings table */}
            <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "12px 18px",
                background: "var(--color-surface)",
                borderBottom: "1px solid var(--color-border)",
              }}>
                <p className="eyebrow-label" style={{ color: "var(--color-muted)", margin: 0 }}>{active?.name ?? "Watchlist"}</p>
                <span className="mono" style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: "var(--text-micro)", fontWeight: 700, letterSpacing: "0.08em",
                  color: "var(--color-bull)",
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", flexShrink: 0 }} />
                  LIVE
                </span>
                <span style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)", marginLeft: "auto" }}>
                  Sorted by Finava score · click a row to open
                </span>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <TableHead />
                <tbody>
                  {rows.map((row, i) => (
                    <TableRow
                      key={row.ticker}
                      data={row}
                      isLast={i === rows.length - 1}
                      onRemove={(t) => active && removeTicker(active.id, t)}
                      onClick={(t) => router.push(`/stock/${t}`)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Rail */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Signals */}
              <RailSection title="Signals" count={signalCount}>
                {feed.length === 0 ? (
                  <div style={{ padding: "11px 13px" }}>
                    <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>No active signals</span>
                  </div>
                ) : (
                  feed.slice(0, 5).map((sig, i) => {
                    const tone = SIGNAL_TONE[sig.k];
                    return (
                      <div
                        key={i}
                        className="portfolio-row"
                        onClick={() => router.push(`/stock/${sig.ticker}`)}
                        style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "9px 13px", borderBottom: i < Math.min(feed.length, 5) - 1 ? "1px solid var(--color-border)" : "none" }}
                      >
                        <span style={{ flexShrink: 0, marginTop: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", width: 19, height: 19, borderRadius: 999, background: tone.bg, color: tone.color }}>
                          <SignalIcon k={sig.k} size={11} />
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <span className="mono" style={{ fontSize: "var(--text-meta)", fontWeight: 700, color: "var(--color-accent)" }}>{sig.ticker}</span>
                          <p style={{ margin: "2px 0 0", fontSize: "var(--text-micro)", color: "var(--color-text-secondary)", lineHeight: 1.35 }}>{sig.label}</p>
                        </div>
                      </div>
                    );
                  })
                )}
              </RailSection>

              {/* Today's movers */}
              <RailSection title="Today's movers">
                {movers.slice(0, 5).map((row) => (
                  <div
                    key={row.ticker}
                    className="portfolio-row"
                    onClick={() => router.push(`/stock/${row.ticker}`)}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 13px", borderBottom: "1px solid var(--color-border)" }}
                  >
                    <span className="mono" style={{ fontSize: "var(--text-meta)", fontWeight: 700, color: "var(--color-accent)", width: 46 }}>{row.ticker}</span>
                    <div style={{ flex: 1 }} />
                    <span className="mono" style={{ color: (row.changePct ?? 0) >= 0 ? "var(--color-bull)" : "var(--color-bear)", fontWeight: 700, fontSize: "var(--text-meta)", whiteSpace: "nowrap" }}>
                      {row.changePct == null ? "—" : `${(row.changePct ?? 0) >= 0 ? "▲ +" : "▼ "}${Math.abs(row.changePct).toFixed(2)}%`}
                    </span>
                  </div>
                ))}
              </RailSection>

              {/* Score leaders */}
              <RailSection title="Score leaders">
                {rows.filter((row) => row.score != null).slice(0, 5).map((row) => (
                  <div
                    key={row.ticker}
                    className="portfolio-row"
                    onClick={() => router.push(`/stock/${row.ticker}`)}
                    style={{ display: "grid", gridTemplateColumns: "44px 1fr auto", alignItems: "center", gap: 9, padding: "8px 13px", borderBottom: "1px solid var(--color-border)" }}
                  >
                    <span className="mono" style={{ fontSize: "var(--text-meta)", fontWeight: 700, color: "var(--color-accent)" }}>{row.ticker}</span>
                    <div style={{ height: 6, borderRadius: 999, background: "var(--color-surface-2)", overflow: "hidden" }}>
                      <div style={{ width: `${row.score}%`, height: "100%", borderRadius: 999, background: scoreTierColor(row.score!) }} />
                    </div>
                    <span className="mono" style={{ fontSize: "var(--text-meta)", fontWeight: 700, color: "var(--color-text)" }}>{row.score}</span>
                  </div>
                ))}
              </RailSection>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
