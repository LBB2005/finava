"use client";
import { useFinava } from "@/hooks/useFinava";
import { useVerdictCache, verdictAge } from "@/hooks/useVerdictCache";
import { useQuotes } from "@/hooks/useQuotes";
import { useTickerFacts } from "@/hooks/useTickerFacts";
import { pillarsToSignals } from "@/lib/facts/signals";
import { factTitle } from "@/lib/facts/format";
import { blendFairValue } from "@/lib/finavaScore";
import {
  SIGNAL_ORDER,
  SIGNAL_LABELS,
  verdictLabel,
  type FinavaSignal,
  type Stance,
  type SignalKey,
} from "@/lib/finava";
import ModelBadge, { PoweredByStrip } from "@/components/ui/ModelBadge";
import Rule from "@/components/ui/Rule";
import { slugToBrand, rosterFromBrands, BRAND_META, type Brand } from "@/lib/models";

/* ── tokens / helpers ─────────────────────────────────────────────────────── */
function stanceColor(stance: Stance): string {
  if (stance === "bullish") return "var(--color-bull)";
  if (stance === "bearish") return "var(--color-bear)";
  return "var(--color-warn)";
}
function fmtMoney(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n)
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
}
function signedPct(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/* ── score orb (hero, docked right) — breathes only while streaming ───────── */
function ScoreOrb({
  score,
  stance,
  color,
  live,
}: {
  score: number | null;
  stance: string | null;
  color: string;
  live: boolean;
}) {
  const pct = score ?? 0;
  const bg =
    score == null
      ? "conic-gradient(var(--color-border-strong) 0% 25%, var(--color-surface-2) 25% 100%)"
      : `conic-gradient(${color} 0% ${pct}%, var(--color-surface-2) ${pct}% 100%)`;
  return (
    <div
      className={live ? "orb-live" : undefined}
      style={{
        width: 96,
        height: 96,
        borderRadius: "50%",
        background: bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background 0.6s ease",
      }}
    >
      <div style={{ width: 74, height: 74, background: "var(--color-bg)", borderRadius: "50%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        {score == null ? (
          <span className="skeleton" style={{ width: 30, height: 10, borderRadius: 99 }} aria-label="Scoring" />
        ) : (
          <>
            <span className="serif" style={{ fontSize: "var(--text-stat)", fontWeight: 800, color: "var(--color-text)", lineHeight: 1 }}>{score}</span>
            <span className="mono" style={{ fontSize: 7.5, color: "var(--color-muted)", letterSpacing: "0.1em", marginTop: 2, textTransform: "uppercase", maxWidth: 62, textAlign: "center", lineHeight: 1.3 }}>
              {stance ?? "/ 100"}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** "The debate is sizing, not direction. Rest of the take…" → headline + dek. */
function splitTake(take: string): { headline: string; dek: string | null } {
  // [\s\S] instead of dotAll — tsconfig targets ES2017 (no `s` flag).
  const m = take.match(/^([\s\S]+?[.!?])["'”’]?\s+([\s\S]+)$/);
  return m ? { headline: m[1], dek: m[2] } : { headline: take, dek: null };
}

function RefreshGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

/* ── one signal bar (progressive) ─────────────────────────────────────────── */
function SignalBar({ signalKey, signal }: { signalKey: SignalKey; signal: FinavaSignal | undefined }) {
  const label = SIGNAL_LABELS[signalKey];
  if (!signal) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "9px 0" }}>
        <span style={{ fontSize: "var(--text-meta)", color: "var(--color-muted)", width: 96, flexShrink: 0 }}>{label}</span>
        <div className="skeleton" style={{ flex: 1, height: 4, borderRadius: 99 }} />
        <span className="skeleton" style={{ width: 24, height: 10, borderRadius: 99 }} />
      </div>
    );
  }
  const color = stanceColor(signal.stance);
  // A pillar the engine had to exclude carries no score. Show it dark and empty —
  // painting the neutral 50 would read as a real "middling" verdict on the data.
  const isNoData = signal.isNoData === true;
  return (
    <div className="fade-in" style={{ margin: "9px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: "var(--text-meta)", color: isNoData ? "var(--color-muted)" : "var(--color-text-secondary)", width: 96, flexShrink: 0 }}>{label}</span>
        <div style={{ flex: 1, height: 4, borderRadius: 99, background: "var(--color-surface-2)", overflow: "hidden" }}>
          {!isNoData && (
            <div style={{ width: `${signal.score}%`, height: "100%", background: color, borderRadius: 99, transition: "width 0.5s ease" }} />
          )}
        </div>
        <span className="mono" style={{ fontSize: "var(--text-micro)", fontWeight: 600, color: isNoData ? "var(--color-muted)" : "var(--color-text)", width: 24, textAlign: "right" }}>
          {isNoData ? "—" : signal.score}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "3px 0 0 106px" }}>
        <p style={{ margin: 0, flex: 1, fontSize: "var(--text-meta)", color: "var(--color-muted)", lineHeight: 1.4, fontStyle: isNoData ? "italic" : undefined }}>
          {isNoData ? "No data available" : signal.headline}
        </p>
        {signal.model && <ModelBadge slug={signal.model} size={11} />}
      </div>
    </div>
  );
}

function CompareBox({ src, value, price, highlight, title }: { src: string; value: number | null; price: number | null; highlight?: boolean; title?: string }) {
  const up = value != null && price && price > 0 ? ((value - price) / price) * 100 : null;
  return (
    <div title={title} style={{ flex: 1, textAlign: "center", padding: "9px 6px", borderRadius: "var(--radius-md)", background: highlight ? "var(--color-accent-light)" : "var(--color-surface)", border: `1px solid ${highlight ? "var(--color-accent-medium)" : "var(--color-border)"}` }}>
      <div className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 3 }}>{src}</div>
      <div className="serif" style={{ fontSize: "var(--text-lg)", fontWeight: 700, color: "var(--color-text)" }}>{value != null ? fmtMoney(value).replace(".00", "") : "—"}</div>
      <div className="mono" style={{ fontSize: "var(--text-micro)", marginTop: 1, color: up == null ? "var(--color-muted)" : up >= 0 ? "var(--color-bull)" : "var(--color-bear)" }}>{up != null ? signedPct(up) : "n/a"}</div>
    </div>
  );
}

/* ── main ─────────────────────────────────────────────────────────────────── */
export function FinavaTab({ ticker }: { ticker: string }) {
  const { status, analysis, error, run, retry, refresh, updatedAt } = useFinava(ticker);
  const { quoteMap } = useQuotes([ticker]);
  const price = quoteMap.get(ticker)?.price ?? null;

  // Cached-first: hydrate the store from the persisted verdict (free) instead
  // of auto-running on mount. Runs start ONLY from explicit actions — the
  // button below or the rail's Generate/↻ (a ?run=1 link only opens the tab).
  const { neverRun, resolving } = useVerdictCache(ticker);

  const verdict = analysis.verdict;
  const streaming = status === "streaming";
  const age = verdictAge(updatedAt);

  // One set of numbers: while a run streams, show it live; otherwise the facts
  // layer's canonical score, pillars and valuation lead, and a cached narrative
  // is shown as written earlier.
  const facts = useTickerFacts(ticker);
  const scored = facts.data?.score.value ?? null;
  const canonical = !streaming && scored ? scored : null;
  const signalsShown = canonical ? pillarsToSignals(canonical.pillars) : analysis.signals;
  const byKey = new Map(signalsShown.map((s) => [s.key, s]));
  const orbScore = canonical?.total ?? verdict?.score ?? null;
  const orbStance = canonical ? verdictLabel(canonical.total) : verdict?.stance ?? null;
  const orbConfidence = canonical?.confidence ?? verdict?.confidence ?? null;
  const ringColor = orbScore != null ? stanceColor(orbScore >= 60 ? "bullish" : orbScore <= 40 ? "bearish" : "neutral") : "var(--color-accent)";
  const scoreTitle = facts.data ? factTitle(facts.data.score) : undefined;
  const dcfValue = facts.data?.dcf.value?.fairValue ?? null;
  const streetValue = facts.data?.streetTarget.value ?? null;
  const blended = blendFairValue({ dcf: dcfValue, street: streetValue });
  const narrativeScoreDiffers = !!(verdict && canonical && verdict.score !== canonical.total);

  if (status === "idle") {
    if (resolving && !neverRun) {
      return (
        <div style={{ display: "flex", gap: 26, alignItems: "flex-start" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="skeleton" style={{ width: "70%", height: 30 }} />
            <div className="skeleton" style={{ width: "50%", height: 16 }} />
          </div>
          <div className="skeleton" style={{ width: 96, height: 96, borderRadius: "50%" }} />
        </div>
      );
    }
    // Never run (or cache unavailable) — the one-click metered entry point.
    return (
      <div className="fade-in finava-hero" style={{ display: "flex", gap: 26, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="finava-hero-eyebrow mono eyebrow-label" style={{ color: "var(--color-accent)", display: "flex", alignItems: "center", gap: 6 }}>
            Finava&apos;s Read · 15 factors
          </div>
          <p className="serif" style={{ margin: "10px 0 6px", fontSize: "var(--text-display)", fontWeight: 800, lineHeight: 1.3, color: "var(--color-text)", letterSpacing: "-0.01em" }}>
            No verdict on {ticker.toUpperCase()} yet.
          </p>
          <p style={{ margin: "0 0 14px", fontSize: "var(--text-sm)", color: "var(--color-text-secondary)", maxWidth: 480, lineHeight: 1.6 }}>
            Score it on 15 measured factors across six pillars — fundamentals, valuation,
            momentum, sentiment, analyst and insider — and write the verdict.
          </p>
          <button className="tbtn on" onClick={run}>RUN FINAVA&apos;S ANALYSIS</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <div title={scoreTitle}>
            <ScoreOrb score={orbScore} stance={orbStance} color={ringColor} live={false} />
          </div>
          <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)", letterSpacing: "0.1em" }}>CONFIDENCE {orbConfidence ? orbConfidence.toUpperCase() : "—"}</span>
        </div>
      </div>
    );
  }

  if (status === "error" && analysis.signals.length === 0) {
    return (
      <div className="fade-in" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--color-bear)" }}>{error ?? "The analysis failed."}</p>
        <button className="tbtn on" onClick={retry}>RETRY ANALYSIS</button>
      </div>
    );
  }

  // A failed AI narrative ships factor data only — never a canned "take" under a model badge.
  const aiFallback = verdict?.fallback === true;
  const take = verdict && !aiFallback ? splitTake(verdict.take) : null;
  const narrator = verdict?.model && !aiFallback ? BRAND_META[slugToBrand(verdict.model)].label : null;

  return (
    <div className="fade-in" style={{ minWidth: 0 }}>
      {/* ── Chapter 1 · verdict hero — headline leads, orb docked right ────── */}
      <div className="finava-hero" style={{ display: "flex", gap: 26, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="finava-hero-eyebrow mono eyebrow-label" style={{ color: "var(--color-accent)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>Finava&apos;s Read · 15 factors{!streaming && age ? ` · ${age}` : ""}</span>
            {streaming ? (
              <span className="shimmer-text" style={{ textTransform: "none", letterSpacing: 0 }}>streaming…</span>
            ) : (
              <button
                onClick={refresh}
                title="Re-run the analysis (uses credits)"
                aria-label="Refresh the analysis"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-accent)", padding: 2, display: "inline-flex" }}
              >
                <RefreshGlyph />
              </button>
            )}
          </div>
          {aiFallback ? (
            <p role="status" style={{ margin: "10px 0 0", fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--color-text-secondary)", maxWidth: "68ch" }}>
              AI analysis unavailable right now — showing factor data only.
            </p>
          ) : take ? (
            <>
              <p className="serif" style={{ margin: "10px 0 0", fontSize: "var(--text-stat)", fontWeight: 800, lineHeight: 1.25, color: "var(--color-text)", letterSpacing: "-0.015em", textWrap: "balance" }}>
                {take.headline}
              </p>
              {take.dek && (
                <p style={{ margin: "8px 0 0", fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--color-text-secondary)", maxWidth: "68ch" }}>
                  {take.dek}
                </p>
              )}
              {narrativeScoreDiffers && (
                <p className="mono" style={{ margin: "6px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
                  Narrative written{age ? ` ${age}` : " earlier"} when the score was {verdict!.score}. Score now {canonical!.total}.
                </p>
              )}
            </>
          ) : (
            <p className="shimmer-text serif" style={{ margin: "10px 0 0", fontSize: "var(--text-display)", fontWeight: 800 }}>
              Scoring {ticker.toUpperCase()} — 15 factors across six pillars…
            </p>
          )}

          {/* Crew ribbon — frost summary once settled; the live bars stream below. */}
          {!streaming && signalsShown.length > 0 && (
            <div className="frost-card" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 13px", borderRadius: "var(--radius-lg)", marginTop: 14, flexWrap: "wrap" }}>
              {signalsShown.map((s) => (
                <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--text-micro)", color: "var(--color-text-secondary)", fontWeight: s.stance === "bearish" ? 700 : 500 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: stanceColor(s.stance), flexShrink: 0 }} />
                  {s.label}
                </span>
              ))}
              <span style={{ marginLeft: "auto", display: "inline-flex", gap: 5 }}>
                {Array.from(new Set(signalsShown.flatMap((s) => (s.model ? [s.model] : [])))).slice(0, 3).map((m) => (
                  <ModelBadge key={m} slug={m} size={11} />
                ))}
              </span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, flexShrink: 0 }}>
          <div title={scoreTitle}>
            <ScoreOrb score={orbScore} stance={orbStance} color={ringColor} live={streaming} />
          </div>
          <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--color-muted)", letterSpacing: "0.1em" }}>
            CONFIDENCE {orbConfidence ? orbConfidence.toUpperCase() : "—"}
          </span>
        </div>
      </div>

      {/* ── detail column ──────────────────────────────────────────────────── */}
      <div style={{ minWidth: 0, marginTop: 24 }}>
        <Rule>Signal Breakdown</Rule>
        {SIGNAL_ORDER.map((k) => (
          <SignalBar key={k} signalKey={k} signal={byKey.get(k)} />
        ))}

        {(verdict || dcfValue != null || streetValue != null) && (
          <div className="fade-in" style={{ marginTop: 20 }}>
            <Rule>Valuation · vs ${price != null ? price.toFixed(2) : "—"}</Rule>
            <div style={{ display: "flex", gap: 8 }}>
              <CompareBox
                src={dcfValue != null && streetValue != null ? "DCF + Street" : "Finava"}
                title={dcfValue != null && streetValue != null ? "Blend of DCF and Street target (equal weight)" : "The one available anchor"}
                value={blended}
                price={price}
                highlight
              />
              <CompareBox src="Street" value={streetValue} price={price} title={facts.data ? factTitle(facts.data.streetTarget) : undefined} />
              <CompareBox src="DCF" value={dcfValue} price={price} title={facts.data ? factTitle(facts.data.dcf) : undefined} />
            </div>
          </div>
        )}

        {verdict && (verdict.catalysts.length > 0 || verdict.risks.length > 0) && (
          <div className="fade-in" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 20 }}>
            {verdict.catalysts.length > 0 && (
              <div>
                <Rule>Catalysts</Rule>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {verdict.catalysts.map((c, i) => (
                    <span key={i} style={{ fontSize: "var(--text-micro)", color: "var(--color-bull)", background: "var(--color-bg)", border: "1px solid color-mix(in oklab, var(--color-bull) 35%, var(--color-border))", borderRadius: "var(--radius-xs)", padding: "3px 8px" }}>{c}</span>
                  ))}
                </div>
              </div>
            )}
            {verdict.risks.length > 0 && (
              <div>
                <Rule>Risk Flags</Rule>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {verdict.risks.map((r, i) => (
                    <span key={i} style={{ fontSize: "var(--text-micro)", color: "var(--color-bear)", background: "var(--color-bg)", border: "1px solid color-mix(in oklab, var(--color-bear) 35%, var(--color-border))", borderRadius: "var(--radius-xs)", padding: "3px 8px" }}>{r}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {(() => {
          const brands = rosterFromBrands([
            ...Array.from(byKey.values()).flatMap((s): Brand[] => (s?.model ? [slugToBrand(s.model)] : [])),
            ...(verdict?.model && !aiFallback ? [slugToBrand(verdict.model)] : []),
          ]);
          return brands.length ? (
            <div className="fade-in" style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--color-border)" }}>
              <PoweredByStrip brands={brands} />
            </div>
          ) : null;
        })()}

        <p className="mono" style={{ margin: "14px 0 0", fontSize: "var(--text-micro)", color: "var(--color-muted)" }}>
          {narrator
            ? `Six computed factor pillars · narrative written by ${narrator} · AI-generated, may contain errors · research color, not investment advice.`
            : "Six computed factor pillars · no AI narrative for this run · research color, not investment advice."}
        </p>
      </div>
    </div>
  );
}
