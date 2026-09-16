"use client";
// The intelligence rail — Finava's four differentiators beside the chart
// (spec §1, "icon ledger" voice): Score · AI Verdict (cached-first) ·
// Fair value (DCF defaults) · Your Lens. Deterministic cells always render;
// the verdict cell never fires a run by itself.

import useSWR from "swr";
import { useQuotes } from "@/hooks/useQuotes";
import { useFinava } from "@/hooks/useFinava";
import { useVerdictCache, verdictAge, verdictIsStale } from "@/hooks/useVerdictCache";
import { useTickerFacts } from "@/hooks/useTickerFacts";
import { authFetcher } from "@/lib/authFetch";
import { stanceFromScore, verdictLabel } from "@/lib/finava";
import { factTitle } from "@/lib/facts/format";

interface LensResponse {
  line: string | null;
  tone?: string;
  href?: string;
}

function fmt(n: number, d = 0) {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function gradeColor(g: string): string {
  const letter = g.charAt(0);
  if (letter === "A" || letter === "B") return "var(--color-bull)";
  if (letter === "C") return "var(--color-warn)";
  return "var(--color-bear)";
}

/* Drawn icons — 24-box, stroke 2, currentColor (house icon voice). */
function TileIcon({ kind }: { kind: "score" | "verdict" | "value" | "lens" }) {
  const paths = {
    score: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
    verdict: (
      <>
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </>
    ),
    value: (
      <>
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </>
    ),
    lens: (
      <>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </>
    ),
  } as const;
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[kind]}
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

interface Props {
  ticker: string;
  /** Open the Finava analysis destination; opts.run starts a metered run. */
  onOpenAnalysis: (opts?: { run?: boolean }) => void;
  /** Open the DCF destination. */
  onOpenDcf: () => void;
}

export default function IntelligenceRail({ ticker, onOpenAnalysis, onOpenDcf }: Props) {
  const sym = ticker.toUpperCase();

  // ── Deterministic cells ────────────────────────────────────────────────────
  // Score and fair value both come from the facts layer: the same numbers the
  // Finava tab, Research board and watchlist show.
  const facts = useTickerFacts(sym);
  const scoreFact = facts.data?.score;
  const dcfFact = facts.data?.dcf;
  const scorePending = facts.isLoading || (facts.computing && !scoreFact?.value);
  const dcfPending = facts.isLoading || (facts.computing && !dcfFact?.value);
  const lens = useSWR<LensResponse>(`/api/dna/lens?ticker=${encodeURIComponent(sym)}`, authFetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  // ── Verdict (cached-first; store is the single source once hydrated) ──────
  const { neverRun, resolving } = useVerdictCache(sym);
  const finava = useFinava(sym);
  const verdict = finava.analysis.verdict;

  const { quoteMap } = useQuotes([sym]);
  const livePrice = quoteMap.get(sym)?.price ?? null;

  const fairValue = dcfFact?.value?.fairValue ?? null;
  const fvPrice = livePrice ?? facts.data?.price.value ?? null;
  const upsidePct =
    fairValue != null && fvPrice != null && fvPrice > 0
      ? ((fairValue - fvPrice) / fvPrice) * 100
      : null;
  // One stance: from the canonical score. A cached narrative can be older than the score.
  const canonicalScore = scoreFact?.value?.total ?? null;

  const keyed = (fn: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div className="intel-rail">
      {/* ── Finava Score ── */}
      <div
        className="intel-cell intel-clickable"
        role="button"
        tabIndex={0}
        onClick={() => onOpenAnalysis()}
        onKeyDown={keyed(() => onOpenAnalysis())}
        aria-label="Open the Finava analysis tab"
      >
        <span className="intel-tile"><TileIcon kind="score" /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eyebrow-label" style={{ color: "var(--color-muted)" }}>Finava Score</div>
          {scorePending ? (
            <div className="skeleton" style={{ width: 72, height: 22, marginTop: 4 }} />
          ) : scoreFact?.value ? (
            <div className="serif" title={factTitle(scoreFact)} style={{ fontSize: "var(--text-display)", fontWeight: 800, color: "var(--color-text)", lineHeight: 1.15 }}>
              {scoreFact.value.total}{" "}
              <span style={{ fontSize: "var(--text-sm)", color: gradeColor(scoreFact.value.grade) }}>{scoreFact.value.grade}</span>
            </div>
          ) : (
            <div title={scoreFact ? factTitle(scoreFact) : undefined}>
              <div className="serif" style={{ fontSize: "var(--text-display)", fontWeight: 800, color: "var(--color-muted)", lineHeight: 1.15 }}>—</div>
              <div className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>{scoreFact?.note ?? "Not yet scored"}</div>
            </div>
          )}
        </div>
        {scoreFact?.value && <span className="intel-jump">→</span>}
      </div>

      {/* ── AI Verdict ── */}
      <div className="intel-cell">
        <span className="intel-tile"><TileIcon kind="verdict" /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eyebrow-label" style={{ color: "var(--color-muted)" }}>AI Verdict</div>
          {verdict ? (
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4, flexWrap: "wrap" }}>
              <span
                className={
                  "pill " +
                  (stanceFromScore(canonicalScore ?? verdict.score) === "bullish"
                    ? "pill-bull"
                    : stanceFromScore(canonicalScore ?? verdict.score) === "bearish"
                      ? "pill-bear"
                      : "pill-warn") +
                  (finava.status === "streaming" ? " model-badge-lit" : "")
                }
              >
                {canonicalScore != null ? verdictLabel(canonicalScore) : verdict.stance}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-micro)",
                  color:
                    finava.status === "streaming"
                      ? "var(--color-muted)"
                      : verdictIsStale(finava.updatedAt)
                        ? "var(--color-warn)"
                        : "var(--color-muted)",
                }}
              >
                {finava.status === "streaming"
                  ? "refreshing…"
                  : `${verdict.confidence} conf${verdictAge(finava.updatedAt) ? ` · ${verdictAge(finava.updatedAt)}` : ""}`}
              </span>
            </div>
          ) : finava.status === "streaming" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4 }}>
              <span className="pill pill-accent model-badge-lit">Analysing…</span>
            </div>
          ) : resolving ? (
            <div className="skeleton" style={{ width: 110, height: 18, marginTop: 5 }} />
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              <span style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)" }}>No verdict yet</span>
              <button className="btn btn-primary" style={{ padding: "2px 9px", fontSize: "var(--text-meta)" }} onClick={() => onOpenAnalysis({ run: true })}>
                Generate
              </button>
            </div>
          )}
        </div>
        {verdict && finava.status !== "streaming" && (
          <button
            className="intel-jump"
            style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}
            title="Re-run the 5-agent analysis (uses credits)"
            aria-label="Refresh the AI verdict"
            onClick={finava.refresh}
          >
            <RefreshIcon />
          </button>
        )}
      </div>

      {/* ── Fair value (DCF defaults) ── */}
      <div
        className="intel-cell intel-clickable"
        role="button"
        tabIndex={0}
        onClick={onOpenDcf}
        onKeyDown={keyed(onOpenDcf)}
        aria-label="Open the interactive DCF"
      >
        <span className="intel-tile"><TileIcon kind="value" /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eyebrow-label" style={{ color: "var(--color-muted)" }}>Fair value · DCF</div>
          {dcfPending ? (
            <div className="skeleton" style={{ width: 88, height: 20, marginTop: 4 }} />
          ) : fairValue != null ? (
            <div className="serif" title={dcfFact ? factTitle(dcfFact) : undefined} style={{ fontSize: "var(--text-lg)", fontWeight: 800, color: "var(--color-text)", lineHeight: 1.2 }}>
              ${fmt(fairValue, fairValue >= 100 ? 0 : 2)}{" "}
              {upsidePct != null && (
                <span style={{ fontSize: "var(--text-meta)", color: upsidePct >= 0 ? "var(--color-bull)" : "var(--color-bear)" }}>
                  {upsidePct >= 0 ? "+" : ""}
                  {fmt(upsidePct, 0)}%
                </span>
              )}
            </div>
          ) : (
            <div>
              <div className="serif" style={{ fontSize: "var(--text-lg)", fontWeight: 800, color: "var(--color-muted)", lineHeight: 1.2 }}>—</div>
              <div className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>{dcfFact?.note ?? "Insufficient data"}</div>
            </div>
          )}
        </div>
        {fairValue != null && <span className="intel-jump">→</span>}
      </div>

      {/* ── Your Lens ── */}
      <div className="intel-cell intel-grow">
        <span className="intel-tile"><TileIcon kind="lens" /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eyebrow-label" style={{ color: "var(--color-muted)" }}>Your lens</div>
          {lens.isLoading ? (
            <div className="skeleton" style={{ width: "90%", height: 26, marginTop: 5 }} />
          ) : lens.data?.line ? (
            <p
              title={lens.data.line}
              style={{
                margin: "4px 0 0",
                fontSize: "var(--text-meta)",
                lineHeight: 1.5,
                color: "var(--color-text-secondary)",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {lens.data.line}
            </p>
          ) : (
            <p style={{ margin: "4px 0 0", fontSize: "var(--text-meta)", lineHeight: 1.5, color: "var(--color-muted)" }}>
              Add holdings to see how {sym} fits your portfolio.{" "}
              <a href="/portfolio" style={{ color: "var(--color-accent)", fontWeight: 600, textDecoration: "none" }}>
                Connect →
              </a>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
