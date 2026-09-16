"use client";
import { useState } from "react";
import useSWR from "swr";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useQuotes } from "@/hooks/useQuotes";
import { useNewsImages } from "@/hooks/useNewsImages";
import { useFinava } from "@/hooks/useFinava";
import { useVerdictCache } from "@/hooks/useVerdictCache";
import { factorColor } from "@/lib/research";
import { useTickerFacts } from "@/hooks/useTickerFacts";
import type {
  StockProfile,
  KeyStats,
  AnalystRatings,
  NewsItem,
  SentimentRead,
} from "@/lib/stockData";
import type { FundamentalTimeSeries, YearlyMetric } from "@/lib/edgar";
import Rule from "@/components/ui/Rule";

/* ── format helpers ──────────────────────────────────────────────────────── */
function fmt(n: number, d = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function compact(n: number) {
  const a = Math.abs(n);
  if (a >= 1e12) return `${fmt(n / 1e12, 2)}T`;
  if (a >= 1e9) return `${fmt(n / 1e9, 2)}B`;
  if (a >= 1e6) return `${fmt(n / 1e6, 1)}M`;
  if (a >= 1e3) return `${fmt(n / 1e3, 1)}K`;
  return fmt(n, 0);
}
function signed(n: number, d = 2) {
  return `${n >= 0 ? "+" : ""}${fmt(n, d)}`;
}
function timeAgo(unixSec: number) {
  if (!unixSec) return "";
  const diff = Date.now() / 1000 - unixSec;
  const h = Math.floor(diff / 3600);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/* ── shared primitives (flat, ruled — the research-surface vocabulary) ───── */
function Fact({ l, v, color, big }: { l: string; v: string; color?: string; big?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "9px 0", borderBottom: "1px solid var(--color-border)", gap: 12 }}>
      <span style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)", whiteSpace: "nowrap" }}>{l}</span>
      <span className="mono" style={{ fontSize: big ? "var(--text-body)" : "var(--text-sm)", fontWeight: 600, color: color || "var(--color-text)" }}>{v}</span>
    </div>
  );
}

/* Small inline icons (24-box grammar, stroke 2) for glyphs that used to be
   unicode pseudo-icons (↗ ↻ ▾ ● |). */
function ExternalLinkIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
function RefreshIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
function ChevronIcon({ open, size = 10 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ opacity: 0.7, transform: open ? "rotate(180deg)" : undefined, transition: "transform 130ms ease-out" }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function RangeBar({ lo, hi, cur, mean }: { lo: number; hi: number; cur: number; mean?: number }) {
  const pos = (x: number) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo || 1)) * 100));
  return (
    <div style={{ margin: "4px 0 2px" }}>
      <div style={{ position: "relative", height: 4, background: "var(--color-surface-2)", borderRadius: 99 }}>
        <div style={{ position: "absolute", left: 0, width: `${pos(cur)}%`, height: "100%", background: "var(--color-accent)", borderRadius: 99 }} />
        {mean != null && <div style={{ position: "absolute", left: `${pos(mean)}%`, top: -3, width: 2, height: 10, background: "var(--color-warn)", transform: "translateX(-50%)" }} />}
        <div style={{ position: "absolute", left: `${pos(cur)}%`, top: -3, width: 10, height: 10, borderRadius: 99, background: "var(--color-accent)", border: "2px solid var(--color-bg)", transform: "translateX(-50%)" }} />
      </div>
      <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-micro)", color: "var(--color-muted)", marginTop: 6 }}>
        <span>${fmt(lo, 0)}</span>
        <span>${fmt(hi, 0)}</span>
      </div>
    </div>
  );
}

function SourceLogo({ domain, size = 18 }: { domain: string | null; size?: number }) {
  const [err, setErr] = useState(false);
  if (err || !domain) {
    return <span style={{ width: size, height: size, borderRadius: "var(--radius-xs)", background: "var(--color-surface-2)", display: "inline-block", flexShrink: 0 }} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://www.google.com/s2/favicons?sz=64&domain=${domain}`}
      alt=""
      width={size}
      height={size}
      style={{ borderRadius: "var(--radius-xs)", flexShrink: 0, display: "block" }}
      onError={() => setErr(true)}
    />
  );
}

function NewsThumb({ src, domain, style }: { src: string; domain: string | null; style?: React.CSSProperties }) {
  const [err, setErr] = useState(false);
  const show = src && !err;
  return (
    <div style={{ background: "var(--color-surface-2)", overflow: "hidden", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", ...style }}>
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          onError={() => setErr(true)}
        />
      ) : (
        // Real article image absent/blocked — fall back to the publication mark.
        <SourceLogo domain={domain} size={22} />
      )}
    </div>
  );
}

function FinMetric({ label, data, color, money = true }: { label: string; data: YearlyMetric[]; color: string; money?: boolean }) {
  const recent = data.slice(-5);
  if (recent.length === 0) return null;
  const latest = recent[recent.length - 1].value;
  const prev = recent.length > 1 ? recent[recent.length - 2].value : latest;
  const yoy = prev ? ((latest - prev) / Math.abs(prev)) * 100 : 0;
  const max = Math.max(...recent.map((d) => Math.abs(d.value)), 1);
  return (
    <div style={{ minWidth: 0 }}>
      <p className="mono eyebrow-label" style={{ margin: "0 0 6px", color: "var(--color-muted)" }}>{label}</p>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="serif mono" style={{ fontFamily: "var(--font-serif)", fontSize: "var(--text-display)", fontWeight: 800, letterSpacing: "-0.01em", color: "var(--color-text)" }}>
          {money ? "$" : ""}{compact(latest)}
        </span>
        <span className="mono" style={{ fontSize: "var(--text-meta)", fontWeight: 600, color: yoy >= 0 ? "var(--color-bull)" : "var(--color-bear)" }}>{signed(yoy, 1)}%</span>
      </div>
      <p className="mono" style={{ margin: "1px 0 10px", fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>FY{recent[recent.length - 1].year} · YoY</p>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 52 }}>
        {recent.map((d, i) => {
          const last = i === recent.length - 1;
          return (
            <div key={d.year} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ width: "100%", height: Math.max((Math.abs(d.value) / max) * 44, 3), background: last ? color : `color-mix(in oklab, ${color} 32%, var(--color-surface-2))`, borderRadius: "2px 2px 0 0" }} />
              <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>{`'${String(d.year).slice(2)}`}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function chip(label: string) {
  return (
    <span key={label} className="mono" style={{ fontSize: "var(--text-micro)", fontWeight: 600, letterSpacing: "0.02em", padding: "4px 9px", borderRadius: "var(--radius-xs)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}>
      {label}
    </span>
  );
}

/* ── Overview ────────────────────────────────────────────────────────────── */
function sentimentColor(label: SentimentRead["label"]) {
  if (label === "positive") return "var(--color-bull)";
  if (label === "negative") return "var(--color-bear)";
  return "var(--color-warn)";
}

/* ── Overview building blocks (Bull/Bear ledger — spec §3) ───────────────── */

/** Quarterly financials response (GET /api/stock/[ticker]/financials). */
interface FinQuarter {
  year: number;
  quarter: number;
  revenue: number | null;
  revenueYoY: number | null;
  epsDiluted: number | null;
  grossMargin: number | null;
  netIncome: number | null;
  fcf: number | null;
}
interface FinancialsResponse {
  ticker: string;
  quarters: FinQuarter[];
  fcfIsProxy: boolean;
  ttm: {
    income: { revenue: number | null; grossProfit: number | null; operatingIncome: number | null; netIncome: number | null; epsDiluted: number | null };
    balance: { cash: number | null; cashAndShortTermInvestments: number | null; totalDebt: number | null; netCash: number | null; totalAssets: number | null; bookValuePerShare: number | null; asOf: string | null };
    cashflow: { operatingCF: number | null; capex: number | null; fcf: number | null; buybacks: number | null; fcfMargin: number | null };
  };
}

const publicJson = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

function qLabel(q: FinQuarter): string {
  return `Q${q.quarter}'${String(q.year).slice(2)}`;
}

/** Green catalyst / red risk chip — the FinavaTab recipe, shared here. */
function LedgerChip({ text, tone }: { text: string; tone: "bull" | "bear" }) {
  const c = tone === "bull" ? "var(--color-bull)" : "var(--color-bear)";
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "var(--text-meta)",
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: "var(--radius-xs)",
        color: c,
        background: `color-mix(in oklab, ${c} 9%, transparent)`,
        border: `1px solid color-mix(in oklab, ${c} 25%, transparent)`,
        margin: "0 5px 6px 0",
        lineHeight: 1.4,
      }}
    >
      {text}
    </span>
  );
}

/** One score pillar: label · track · value, tier-colored fill. */
function PillarRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
      <span style={{ width: 86, fontSize: "var(--text-meta)", color: "var(--color-text-secondary)", flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 6, borderRadius: 99, background: "var(--color-surface-2)", overflow: "hidden" }}>
        <div style={{ display: "block", width: `${value}%`, height: "100%", borderRadius: 99, background: factorColor(value) }} />
      </div>
      <span className="mono" style={{ width: 24, textAlign: "right", fontSize: "var(--text-meta)", fontWeight: 700, color: "var(--color-text)" }}>
        {Math.round(value)}
      </span>
    </div>
  );
}

/** Label + latest value + YoY + an 8-quarter mini bar chart. */
function TrajectoryMini({
  label,
  quarters,
  value,
  format,
}: {
  label: string;
  quarters: FinQuarter[];
  value: (q: FinQuarter) => number | null;
  format: (v: number, q: FinQuarter) => string;
}) {
  const vals = quarters.map((q) => value(q));
  const present = vals.filter((v): v is number => v != null);
  const latestQ = quarters.at(-1);
  const latest = vals.at(-1) ?? null;
  if (!latestQ || latest == null || present.length < 2) {
    return (
      <div style={{ marginBottom: 14 }}>
        <span className="mono eyebrow-label" style={{ color: "var(--color-muted)" }}>{label}</span>
        <p className="mono" style={{ margin: "3px 0 0", fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>Unavailable</p>
      </div>
    );
  }
  const max = Math.max(...present.map(Math.abs), 1e-9);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, marginBottom: 14 }}>
      <div style={{ minWidth: 0 }}>
        <span className="mono eyebrow-label" style={{ color: "var(--color-muted)" }}>{label} · {quarters.length}Q</span>
        <div className="mono" style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--color-text)", marginTop: 3 }}>
          {format(latest, latestQ)}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 30, flexShrink: 0 }}>
        {vals.map((v, i) => (
          <span
            key={i}
            title={v != null ? `${qLabel(quarters[i])}: ${format(v, quarters[i])}` : `${qLabel(quarters[i])}: —`}
            style={{
              display: "block",
              width: 7,
              height: v != null ? Math.max(3, (Math.abs(v) / max) * 30) : 3,
              borderRadius: 1.5,
              background: v == null ? "var(--color-surface-2)" : i === vals.length - 1 ? "var(--color-accent)" : "var(--color-accent-medium)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** TTM statement column: title + label/value lines. */
function StatementCol({ title, lines }: { title: string; lines: Array<[string, string, string?]> }) {
  return (
    <div style={{ padding: "12px 16px", minWidth: 0 }}>
      <p className="mono eyebrow-label" style={{ margin: "0 0 8px", color: "var(--color-muted)" }}>{title}</p>
      {lines.map(([l, v, color]) => (
        <div key={l} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "4px 0", borderBottom: "1px solid color-mix(in oklab, var(--color-border) 55%, transparent)", fontSize: "var(--text-meta)" }}>
          <span style={{ color: "var(--color-text-secondary)" }}>{l}</span>
          <span className="mono" style={{ fontWeight: 600, color: color ?? "var(--color-text)" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

export function OverviewTab({
  ticker,
  profile,
  keyStats,
  news,
  onOpenAnalysis,
}: {
  ticker: string;
  profile: StockProfile | null;
  keyStats: KeyStats | null;
  news: NewsItem[] | null;
  onOpenAnalysis: (opts?: { run?: boolean }) => void;
}) {
  const { holdings } = usePortfolio();
  const { quoteMap } = useQuotes([ticker]);

  // Cached-first verdict (shared SWR key with the rail — one read per page).
  const { resolving } = useVerdictCache(ticker);
  const { analysis, status } = useFinava(ticker);
  const verdict = analysis.verdict;

  // Pillar bars are the canonical score's six pillars (the same engine as the rail and Finava tab).
  const facts = useTickerFacts(ticker);
  const fin = useSWR<FinancialsResponse>(`/api/stock/${encodeURIComponent(ticker)}/financials`, publicJson, {
    revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 300_000,
  });

  const price = quoteMap.get(ticker)?.price ?? 0;
  const held = holdings.find((h) => h.ticker.toUpperCase() === ticker.toUpperCase());
  const has52 = keyStats?.high52 != null && keyStats?.low52 != null;

  const quarters = fin.data?.quarters ?? [];
  const ttm = fin.data?.ttm ?? null;
  const chips = [profile?.industry, profile?.exchange, profile?.currency].filter(Boolean) as string[];

  const money = (v: number | null) => (v == null ? "—" : `${v < 0 ? "−" : ""}$${compact(Math.abs(v))}`);
  const pct = (v: number | null, d = 1) => (v == null ? "—" : `${fmt(v * 100, d)}%`);

  return (
    <div className="fade-in">
      <div style={{ display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: 0 }} className="overview-grid">
        {/* ── left · the ledger ── */}
        <div style={{ paddingRight: 32 }} className="overview-left">
          <Rule>The Finava Read</Rule>
          {verdict ? (
            <>
              <p className="serif" style={{ margin: 0, fontSize: "var(--text-title)", lineHeight: 1.55, color: "var(--color-text)", maxWidth: "62ch" }}>
                {verdict.fallback ? verdict.take : <>&ldquo;{verdict.take}&rdquo;</>}
              </p>
              {(verdict.catalysts.length > 0 || verdict.risks.length > 0) && (
                <div style={{ marginTop: 12 }}>
                  {verdict.catalysts.map((c) => <LedgerChip key={c} text={c} tone="bull" />)}
                  {verdict.risks.map((r) => <LedgerChip key={r} text={r} tone="bear" />)}
                </div>
              )}
              <p className="mono" style={{ margin: "8px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
                {verdict.fallback ? "Factor data only" : "AI-generated narrative"} · not investment advice
              </p>
            </>
          ) : status === "streaming" ? (
            <p className="shimmer-text" style={{ margin: 0, fontSize: "var(--text-sm)" }}>Finava&apos;s agents are reading {ticker}…</p>
          ) : resolving ? (
            <div className="skeleton" style={{ width: "80%", height: 44 }} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
              <p style={{ margin: 0, fontSize: "var(--text-sm)", lineHeight: 1.65, color: "var(--color-text-secondary)", maxWidth: "56ch" }}>
                No read yet — deploy Finava&apos;s five agents to score {ticker} and argue the bull and bear case.
              </p>
              <button className="tbtn on" onClick={() => onOpenAnalysis({ run: true })}>GENERATE FINAVA&apos;S READ</button>
            </div>
          )}

          {facts.data?.score.value && (
            <div style={{ marginTop: 20 }}>
              <Rule>Score pillars</Rule>
              {facts.data.score.value.pillars.map((p) =>
                p.score == null ? (
                  <div key={p.key} className="mono" style={{ display: "flex", gap: 10, padding: "4px 0", fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>
                    <span style={{ width: 86, flexShrink: 0 }}>{p.label}</span>No data
                  </div>
                ) : (
                  <PillarRow key={p.key} label={p.label} value={p.score} />
                )
              )}
            </div>
          )}

          {/* About — demoted to the bottom of the ledger column */}
          {profile && (
            <div style={{ marginTop: 20 }}>
              <Rule>About</Rule>
              <p style={{ margin: 0, fontSize: "var(--text-sm)", lineHeight: 1.62, color: "var(--color-text-secondary)", maxWidth: "82ch" }}>
                {profile.name ?? ticker}{profile.exchange ? ` trades on ${profile.exchange}` : ""}
                {profile.industry ? ` in the ${profile.industry} industry` : ""}.
                {keyStats?.marketCap != null ? ` Market capitalisation is approximately $${compact(keyStats.marketCap * 1e6)}.` : ""}
              </p>
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                {chips.map((c) => chip(c))}
                {profile.weburl && (
                  <a href={profile.weburl} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: "var(--text-micro)", fontWeight: 600, color: "var(--color-accent)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    Website <ExternalLinkIcon />
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── right · evidence ── */}
        <div style={{ borderLeft: "1px solid var(--color-border)", paddingLeft: 32 }} className="overview-right">
          <Rule>Financial trajectory</Rule>
          {fin.isLoading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 8 }}>
              <div className="skeleton" style={{ width: "100%", height: 34 }} />
              <div className="skeleton" style={{ width: "100%", height: 34 }} />
              <div className="skeleton" style={{ width: "100%", height: 34 }} />
            </div>
          ) : quarters.length > 0 ? (
            <>
              <TrajectoryMini label="Revenue" quarters={quarters} value={(q) => q.revenue}
                format={(v, q) => `$${compact(v)}${q.revenueYoY != null ? ` · ${q.revenueYoY >= 0 ? "+" : ""}${fmt(q.revenueYoY * 100, 0)}%` : ""}`} />
              <TrajectoryMini label="EPS" quarters={quarters} value={(q) => q.epsDiluted} format={(v) => `$${fmt(v)}`} />
              <TrajectoryMini label="Gross margin" quarters={quarters} value={(q) => q.grossMargin} format={(v) => `${fmt(v * 100, 1)}%`} />
            </>
          ) : (
            <p className="mono" style={{ margin: "0 0 8px", fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>
              Unavailable — no quarterly filings for {ticker}.
            </p>
          )}

          {news && news.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <Rule>Latest news</Rule>
              {news.slice(0, 4).map((n) => (
                <a key={n.url} href={n.url} target="_blank" rel="noopener noreferrer" className="newslink" style={{ textDecoration: "none", display: "flex", gap: 10, padding: "8px 0", borderBottom: "1px solid color-mix(in oklab, var(--color-border) 55%, transparent)" }}>
                  <span className="mono" style={{ width: 74, flexShrink: 0, fontSize: "var(--text-micro)", color: "var(--color-muted)", paddingTop: 2, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {n.source} · {timeAgo(n.datetime)}
                  </span>
                  <span className="h" style={{ fontSize: "var(--text-sm)", fontWeight: 600, lineHeight: 1.45, color: "var(--color-text)" }}>{n.headline}</span>
                </a>
              ))}
            </div>
          )}

          {/* Snapshot — the old facts, demoted to a slim strip */}
          <div style={{ marginTop: 14 }}>
            <Rule>Snapshot</Rule>
            <p className="mono" style={{ margin: 0, fontSize: "var(--text-meta)", lineHeight: 1.9, color: "var(--color-text-secondary)" }}>
              {keyStats?.marketCap != null ? `$${compact(keyStats.marketCap * 1e6)}` : "—"} mkt cap
              {" · "}P/E {keyStats?.peTTM != null ? fmt(keyStats.peTTM, 1) : "—"}
              {" · "}EPS {keyStats?.epsTTM != null ? `$${fmt(keyStats.epsTTM)}` : "—"}
              {" · "}β {keyStats?.beta != null ? fmt(keyStats.beta, 2) : "—"}
              {keyStats?.dividendYield != null ? ` · ${fmt(keyStats.dividendYield, 2)}% yield` : ""}
            </p>
            {has52 && (
              <div style={{ padding: "10px 0 2px" }}>
                <RangeBar lo={keyStats!.low52!} hi={keyStats!.high52!} cur={price > 0 ? price : keyStats!.low52!} />
              </div>
            )}
            {held && price > 0 && (() => {
              const mv = held.shares * price;
              const cb = held.shares * held.avgCost;
              const gl = mv - cb;
              const glp = cb > 0 ? (gl / cb) * 100 : 0;
              return (
                <p className="mono" style={{ margin: "8px 0 0", fontSize: "var(--text-meta)", color: "var(--color-text-secondary)" }}>
                  You hold {fmt(held.shares, held.shares % 1 === 0 ? 0 : 2)} sh · ${compact(mv)} ·{" "}
                  <span style={{ color: gl >= 0 ? "var(--color-bull)" : "var(--color-bear)", fontWeight: 700 }}>
                    {gl >= 0 ? "+" : "−"}${compact(Math.abs(gl))} ({signed(glp, 1)}%)
                  </span>
                </p>
              );
            })()}
          </div>
        </div>
      </div>

      {/* ── full-width · quarterly ledger table ── */}
      {quarters.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <Rule>Financials · quarterly</Rule>
          <div style={{ overflowX: "auto" }}>
            <table className="dt" style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Metric</th>
                  {quarters.map((q) => (
                    <th key={qLabel(q)} style={{ ...thStyle, textAlign: "right" }}>{qLabel(q)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([
                  ["Revenue", (q: FinQuarter) => money(q.revenue), undefined],
                  ["YoY growth", (q: FinQuarter) => (q.revenueYoY == null ? "—" : `${q.revenueYoY >= 0 ? "+" : ""}${fmt(q.revenueYoY * 100, 0)}%`), (q: FinQuarter) => (q.revenueYoY == null ? undefined : q.revenueYoY >= 0 ? "var(--color-bull)" : "var(--color-bear)")],
                  ["EPS (diluted)", (q: FinQuarter) => (q.epsDiluted == null ? "—" : `$${fmt(q.epsDiluted)}`), undefined],
                  ["Gross margin", (q: FinQuarter) => pct(q.grossMargin), undefined],
                  ["Free cash flow", (q: FinQuarter) => money(q.fcf), undefined],
                ] as Array<[string, (q: FinQuarter) => string, ((q: FinQuarter) => string | undefined) | undefined]>).map(([label, cell, color]) => (
                  <tr key={label}>
                    <td style={{ padding: "7px 10px", borderBottom: "1px solid var(--color-border)", fontSize: "var(--text-sm)", color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>{label}</td>
                    {quarters.map((q) => (
                      <td key={qLabel(q)} className="mono" style={{ padding: "7px 10px", borderBottom: "1px solid var(--color-border)", fontSize: "var(--text-meta)", fontWeight: 600, textAlign: "right", whiteSpace: "nowrap", color: color?.(q) ?? "var(--color-text)" }}>
                        {cell(q)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {fin.data?.fcfIsProxy && (
            <p className="mono" style={{ margin: "8px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
              FCF uses operating cash flow where capex isn&apos;t reported.
            </p>
          )}
        </div>
      )}

      {/* ── full-width · TTM three-statement summary ── */}
      {ttm && (
        <div style={{ marginTop: 26 }}>
          <Rule>Three-statement summary · TTM</Rule>
          <div className="overview-ttm" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
            <StatementCol
              title="Income"
              lines={[
                ["Revenue", money(ttm.income.revenue)],
                ["Gross profit", money(ttm.income.grossProfit)],
                ["Operating income", money(ttm.income.operatingIncome)],
                ["Net income", money(ttm.income.netIncome)],
                ["EPS (diluted)", ttm.income.epsDiluted == null ? "—" : `$${fmt(ttm.income.epsDiluted)}`],
              ]}
            />
            <div style={{ borderLeft: "1px solid var(--color-border)" }}>
              <StatementCol
                title={`Balance sheet${ttm.balance.asOf ? ` · ${ttm.balance.asOf}` : ""}`}
                lines={[
                  // The label says short-term investments are included, so show the figure that includes them.
                  ["Cash & ST inv.", money(ttm.balance.cashAndShortTermInvestments ?? ttm.balance.cash)],
                  ["Total debt", money(ttm.balance.totalDebt)],
                  ["Net cash", money(ttm.balance.netCash), ttm.balance.netCash != null ? (ttm.balance.netCash >= 0 ? "var(--color-bull)" : "var(--color-bear)") : undefined],
                  ["Total assets", money(ttm.balance.totalAssets)],
                  ["Book value / share", ttm.balance.bookValuePerShare == null ? "—" : `$${fmt(ttm.balance.bookValuePerShare)}`],
                ]}
              />
            </div>
            <div style={{ borderLeft: "1px solid var(--color-border)" }}>
              <StatementCol
                title="Cash flow"
                lines={[
                  ["Operating CF", money(ttm.cashflow.operatingCF)],
                  ["CapEx", ttm.cashflow.capex == null ? "—" : `−$${compact(Math.abs(ttm.cashflow.capex))}`],
                  ["Free cash flow", money(ttm.cashflow.fcf)],
                  ["Buybacks", money(ttm.cashflow.buybacks)],
                  ["FCF margin", pct(ttm.cashflow.fcfMargin)],
                ]}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-micro)",
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--color-muted)",
  background: "var(--color-surface)",
  textAlign: "left",
  padding: "7px 10px",
  borderBottom: "1px solid var(--color-border-strong)",
  whiteSpace: "nowrap",
};

/* ── Financials ──────────────────────────────────────────────────────────── */
export function FinancialsTab({ fundamentals }: { fundamentals: FundamentalTimeSeries | null }) {
  if (!fundamentals || (fundamentals.revenue.length === 0 && fundamentals.netIncome.length === 0)) {
    return <div className="fade-in"><p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>Financial statements are not available for this symbol.</p></div>;
  }
  const metrics = [
    { label: "Revenue", data: fundamentals.revenue, color: "var(--color-accent)" },
    { label: "Net income", data: fundamentals.netIncome, color: "var(--color-bull)" },
    { label: "Operating cash flow", data: fundamentals.operatingCashFlow, color: "var(--color-warn)" },
    { label: "Total debt", data: fundamentals.totalDebt, color: "var(--color-text-secondary)" },
  ].filter((m) => m.data.length > 0);

  const rows = fundamentals.revenue;
  const niByYear = new Map(fundamentals.netIncome.map((d) => [d.year, d.value]));

  return (
    <div className="fade-in">
      <Rule>Annual performance</Rule>
      <div className="fin-grid" style={{ display: "grid", gridTemplateColumns: `repeat(${metrics.length}, 1fr)`, paddingBottom: 24, marginBottom: 22, borderBottom: "1px solid var(--color-border)" }}>
        {metrics.map((m, i) => (
          <div key={m.label} style={{ paddingLeft: i ? 24 : 0, paddingRight: 18, borderLeft: i ? "1px solid var(--color-border)" : "none" }}>
            <FinMetric label={m.label} data={m.data} color={m.color} />
          </div>
        ))}
      </div>

      {rows.length > 0 && (
        <>
          <Rule>Income statement</Rule>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 440 }}>
              <thead>
                <tr>
                  {["Fiscal year", "Revenue", "Net income", "Net margin"].map((h, i) => (
                    <th key={h} className="mono eyebrow-label" style={{ textAlign: i === 0 ? "left" : "right", color: "var(--color-muted)", padding: "8px 12px", borderBottom: "1px solid var(--color-border-strong)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const ni = niByYear.get(r.year);
                  const margin = ni != null && r.value ? (ni / r.value) * 100 : null;
                  const last = i === rows.length - 1;
                  return (
                    <tr key={r.year} style={{ background: last ? "var(--color-accent-light)" : "transparent" }}>
                      <td className="mono" style={{ fontSize: "var(--text-sm)", fontWeight: last ? 700 : 600, padding: "9px 12px", borderBottom: "1px solid var(--color-border)", color: last ? "var(--color-accent)" : "var(--color-text)" }}>FY{r.year}</td>
                      <td className="mono" style={{ textAlign: "right", fontSize: "var(--text-sm)", padding: "9px 12px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text)" }}>${compact(r.value)}</td>
                      <td className="mono" style={{ textAlign: "right", fontSize: "var(--text-sm)", padding: "9px 12px", borderBottom: "1px solid var(--color-border)", color: "var(--color-text)" }}>{ni != null ? `$${compact(ni)}` : "—"}</td>
                      <td className="mono" style={{ textAlign: "right", fontSize: "var(--text-sm)", padding: "9px 12px", borderBottom: "1px solid var(--color-border)", color: margin != null ? "var(--color-bull)" : "var(--color-muted)" }}>{margin != null ? `${fmt(margin, 1)}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)", margin: "12px 0 0" }}>Figures from SEC EDGAR filings · highlighted row is most recent fiscal year.</p>
        </>
      )}
    </div>
  );
}

/* ── Analysts ────────────────────────────────────────────────────────────── */
export function AnalystsTab({ analysts, price }: { analysts: AnalystRatings | null; price: number | null }) {
  if (!analysts) {
    return <div className="fade-in"><p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>Analyst coverage is not available for this symbol.</p></div>;
  }
  const total = analysts.strongBuy + analysts.buy + analysts.hold + analysts.sell + analysts.strongSell;
  const buyish = analysts.strongBuy + analysts.buy;
  const upside = price && price > 0 && analysts.targetMean != null ? ((analysts.targetMean - price) / price) * 100 : null;
  const rows: [string, number, string][] = [
    ["Strong Buy", analysts.strongBuy, "var(--color-bull)"],
    ["Buy", analysts.buy, "color-mix(in oklab, var(--color-bull) 70%, var(--color-surface))"],
    ["Hold", analysts.hold, "var(--color-muted)"],
    ["Sell", analysts.sell, "color-mix(in oklab, var(--color-bear) 70%, var(--color-surface))"],
    ["Strong Sell", analysts.strongSell, "var(--color-bear)"],
  ];
  const hasTarget = analysts.targetLow != null && analysts.targetHigh != null;

  return (
    <div className="fade-in analyst-grid" style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 0 }}>
      <div style={{ paddingRight: 32 }} className="analyst-left">
        <Rule>Rating distribution{total > 0 ? ` · ${total} analysts` : ""}</Rule>
        {rows.map(([l, v, c]) => (
          <div key={l} style={{ display: "grid", gridTemplateColumns: "92px 1fr 24px", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: "var(--text-meta)", color: "var(--color-text-secondary)" }}>{l}</span>
            <div style={{ height: 8, borderRadius: 99, background: "var(--color-surface-2)", overflow: "hidden" }}>
              <div style={{ width: `${total > 0 ? (v / total) * 100 : 0}%`, height: "100%", background: c }} />
            </div>
            <span className="mono" style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)", textAlign: "right" }}>{v}</span>
          </div>
        ))}
        {total > 0 && (
          <p className="mono" style={{ margin: "8px 0 0", fontSize: "var(--text-meta)", color: "var(--color-text-secondary)" }}>
            {Math.round((buyish / total) * 100)}% rate Buy or better.
          </p>
        )}
      </div>
      <div style={{ borderLeft: "1px solid var(--color-border)", paddingLeft: 32 }} className="analyst-right">
        <Rule>Price target{analysts.numberOfAnalysts ? ` · ${analysts.numberOfAnalysts} analysts` : ""}</Rule>
        {analysts.targetMean == null ? (
          <p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)", margin: "10px 0 0", lineHeight: 1.5 }}>
            Unavailable — analyst price targets aren’t provided on the current data tier.
          </p>
        ) : (
          <>
            <Fact l="Mean target" v={`$${fmt(analysts.targetMean)}`} big />
            <Fact l="Implied upside" v={upside != null ? `${signed(upside, 1)}%` : "—"} color={upside == null ? undefined : upside >= 0 ? "var(--color-bull)" : "var(--color-bear)"} big />
            {hasTarget && (
              <div style={{ padding: "16px 0 4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>Target range</span>
                  {price && price > 0 && <span className="mono" style={{ fontSize: "var(--text-meta)", color: "var(--color-text-secondary)" }}>now ${fmt(price)}</span>}
                </div>
                <RangeBar lo={analysts.targetLow!} hi={analysts.targetHigh!} cur={price && price > 0 ? price : analysts.targetLow!} mean={analysts.targetMean ?? undefined} />
                <p className="mono" style={{ margin: "8px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)", display: "flex", alignItems: "center", gap: 5 }}>
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="3.5" fill="var(--color-accent)" /></svg>
                  price ·
                  <svg width="4" height="10" viewBox="0 0 4 10" aria-hidden="true"><line x1="2" y1="0.5" x2="2" y2="9.5" stroke="var(--color-warn)" strokeWidth="2" /></svg>
                  mean target
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Sentiment strip (Street & News · spec §4a block 2) ──────────────────────
   Two gauges on one bear→warn→bull scale: News tone (headline-based aggregate)
   and Street stance (derived from the ratings distribution). Disagreement
   between the two is the story. */

function toneColor(score: number): string {
  if (score >= 60) return "var(--color-bull)";
  if (score >= 40) return "var(--color-warn)";
  return "var(--color-bear)";
}

function GaugeCell({
  label,
  score,
  note,
  action,
}: {
  label: string;
  score: number | null;
  note: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div style={{ padding: "13px 16px", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span className="mono eyebrow-label" style={{ color: "var(--color-muted)" }}>{label}</span>
        {score != null ? (
          <span className="mono" style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: toneColor(score) }}>{score}</span>
        ) : (
          <span className="mono" style={{ fontSize: "var(--text-sm)", fontWeight: 700, color: "var(--color-muted)" }}>—</span>
        )}
      </div>
      <div style={{ height: 7, borderRadius: 99, background: "var(--color-surface-2)", overflow: "hidden", margin: "8px 0 7px" }}>
        {score != null && (
          <div style={{ display: "block", width: `${Math.max(2, Math.min(100, score))}%`, height: "100%", borderRadius: 99, background: toneColor(score) }} />
        )}
      </div>
      <div style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)", lineHeight: 1.5, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {note}
        {action}
      </div>
    </div>
  );
}

export function SentimentStrip({
  sentiment,
  analysts,
}: {
  sentiment: SentimentRead | null;
  analysts: AnalystRatings | null;
}) {
  // Street stance — deterministic weighted read of the ratings distribution.
  let street: { score: number; caption: string } | null = null;
  if (analysts) {
    const total = analysts.strongBuy + analysts.buy + analysts.hold + analysts.sell + analysts.strongSell;
    if (total > 0) {
      const weighted =
        (analysts.strongBuy * 100 + analysts.buy * 75 + analysts.hold * 50 + analysts.sell * 25) / total;
      street = {
        score: Math.round(weighted),
        caption: `${analysts.strongBuy + analysts.buy} Buy · ${analysts.hold} Hold · ${analysts.sell + analysts.strongSell} Sell`,
      };
    }
  }

  return (
    <div>
      <Rule>Sentiment</Rule>
      <div className="sentiment-strip" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
        <div>
          <GaugeCell
            label="News tone · 30d"
            score={sentiment?.score ?? null}
            note={<span>{sentiment ? `Headline-based estimate · ${sentiment.sampleSize} items` : "Unavailable"}</span>}
          />
        </div>
        <div style={{ borderLeft: "1px solid var(--color-border)" }}>
          <GaugeCell
            label="Street stance"
            score={street?.score ?? null}
            note={<span>{street ? street.caption : "No analyst coverage"}</span>}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Street & News (consolidated tab — spec §4a) ─────────────────────────── */
export function StreetNewsTab({
  analysts,
  price,
  news,
  sentiment,
}: {
  analysts: AnalystRatings | null;
  price: number | null;
  news: NewsItem[] | null;
  sentiment: SentimentRead | null;
}) {
  return (
    <div className="fade-in">
      <AnalystsTab analysts={analysts} price={price} />
      <div style={{ marginTop: 26 }}>
        <SentimentStrip sentiment={sentiment} analysts={analysts} />
      </div>
      <div style={{ marginTop: 26 }}>
        <NewsTab news={news} />
      </div>
    </div>
  );
}

/* ── News ────────────────────────────────────────────────────────────────── */
export function NewsTab({ news }: { news: NewsItem[] | null }) {
  // Resolve accurate per-article images + publisher domains (Finnhub's url is a
  // redirect and its image is often a generic logo). Hook runs before any early
  // return so hook order stays stable.
  const og = useNewsImages((news ?? []).map((n) => n.url));
  if (!news || news.length === 0) {
    return <div className="fade-in"><p style={{ fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>No recent coverage for this symbol.</p></div>;
  }
  // Prefer the scraped article image + resolved domain; fall back to Finnhub's
  // image and the redirect host until the scrape resolves.
  const pick = (n: NewsItem) => ({
    image: (og[n.url]?.image || n.image) ?? "",
    domain: og[n.url]?.domain || domainOf(n.url),
  });
  const featured = news[0];
  const f = pick(featured);
  const rest = news.slice(1);

  return (
    <div className="fade-in" style={{ maxWidth: 880 }}>
      <Rule>Latest coverage</Rule>
      {/* Featured */}
      <a
        href={featured.url}
        target="_blank"
        rel="noopener noreferrer"
        className="newslink"
        style={{ display: "grid", gridTemplateColumns: "1fr 1.15fr", gap: 24, alignItems: "center", paddingBottom: 24, marginBottom: 22, borderBottom: "1px solid var(--color-border)", textDecoration: "none" }}
      >
        <NewsThumb src={f.image} domain={f.domain} style={{ width: "100%", aspectRatio: "16 / 10", borderRadius: "var(--radius-md)" }} />
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <SourceLogo domain={f.domain} size={18} />
            <span className="mono eyebrow-label" style={{ color: "var(--color-text-secondary)" }}>{featured.source}</span>
            {featured.datetime > 0 && (
              <>
                <span style={{ width: 3, height: 3, borderRadius: 99, background: "var(--color-muted)" }} />
                <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>{timeAgo(featured.datetime)}</span>
              </>
            )}
          </div>
          <p className="serif h" style={{ margin: 0, fontSize: "var(--text-display)", fontWeight: 700, lineHeight: 1.22, letterSpacing: "-0.01em", color: "var(--color-text)" }}>{featured.headline}</p>
          {featured.summary && <p style={{ margin: "10px 0 0", fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--color-text-secondary)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{featured.summary}</p>}
        </div>
      </a>

      {/* Grid */}
      <div className="news-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px 28px" }}>
        {rest.map((n, i) => {
          const p = pick(n);
          return (
            <a key={`${n.url}-${i}`} href={n.url} target="_blank" rel="noopener noreferrer" className="newslink" style={{ display: "flex", gap: 14, alignItems: "flex-start", textDecoration: "none" }}>
              <NewsThumb src={p.image} domain={p.domain} style={{ width: 104, height: 72, borderRadius: "var(--radius-sm)" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                  <SourceLogo domain={p.domain} size={14} />
                  <span className="mono" style={{ fontSize: "var(--text-micro)", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--color-muted)" }}>{n.source}{n.datetime > 0 ? ` · ${timeAgo(n.datetime)}` : ""}</span>
                </div>
                <p className="h" style={{ margin: 0, fontSize: "var(--text-sm)", fontWeight: 500, lineHeight: 1.4, color: "var(--color-text)" }}>{n.headline}</p>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
