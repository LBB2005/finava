"use client";
import { useState, useMemo, useEffect } from "react";
import { HORIZONS, overlayLive, type HorizonKey } from "@/lib/research";
import { boardRanking } from "@/lib/verdict";
import { useLiveBoard } from "@/hooks/useLiveBoard";
import { useFactorUniverse } from "@/hooks/useFactorUniverse";
import { useChatStore } from "@/stores/chatStore";
import { buildResearchSnapshot } from "@/lib/pageContext";
import VerdictHero from "@/components/research/VerdictHero";
import BoardLeaderboard from "@/components/research/BoardLeaderboard";
import MoversRail from "@/components/research/MoversRail";
import ScreenMode from "@/components/research/ScreenMode";
import ResearchSearch from "@/components/research/ResearchSearch";
import ChatContextButton from "@/components/chat/ChatContextButton";
import PageHeader from "@/components/layout/PageHeader";
import RangeToggle from "@/components/ui/RangeToggle";

type Mode = "board" | "screen";

// Horizon options in the shape the shared RangeToggle wants.
const HORIZON_KEYS = HORIZONS.map((h) => h.key);
const HORIZON_LABELS = Object.fromEntries(HORIZONS.map((h) => [h.key, h.tag])) as Record<HorizonKey, string>;

const MODES: { key: Mode; label: string }[] = [
  { key: "board", label: "BOARD" },
  { key: "screen", label: "SCREEN" },
];

const SECTION_RULE: Partial<Record<Mode, string>> = {
  screen: "SCREEN · ASK IN PLAIN ENGLISH, MATCHED ON REAL FACTORS",
};

function SectionRule({ label }: { label: string }) {
  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      <span className="mono eyebrow-label" style={{ color: "var(--color-muted)" }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: "var(--color-border)" }} />
    </div>
  );
}

/** Hard-failure state for the factor feed. Shows nothing rather than a stand-in. */
function FactorsUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="empty-note flex flex-col items-center justify-center"
      style={{ minHeight: 280, gap: 12, textAlign: "center" }}
    >
      <p style={{ margin: 0 }}>
        Factor scores are unavailable right now, so the board has nothing to rank.
      </p>
      <button className="tbtn on" onClick={onRetry}>RETRY</button>
    </div>
  );
}

/** Format asOf ISO string → "Jun 2, 2026 · 9:30 AM ET" */
function fmtAsOf(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    }) + " ET";
  } catch {
    return iso;
  }
}

export default function ResearchPage() {
  const [mode, setMode] = useState<Mode>("board");
  const [horizon, setHorizon] = useState<HorizonKey>("week");

  // Real factor universe (S&P 500 + scannable extras, scored on real data).
  // There is deliberately no placeholder fallback: until the scores arrive the
  // Board shows a syncing state, and on failure it says so. Never a stand-in
  // number that could be mistaken for a market reading.
  const {
    universe: factorUniverse,
    isLoading: factorsLoading,
    error: factorsError,
    retry: retryFactors,
    asOf,
  } = useFactorUniverse();
  const baseUniverse = useMemo(() => factorUniverse ?? [], [factorUniverse]);

  // Live market overlay — price, % change, market cap, P/E, volume.
  // Re-keys to 503 tickers once the factor universe arrives.
  const tickers = useMemo(() => baseUniverse.map((s) => s.ticker), [baseUniverse]);
  const { liveMap, isLoading: pricesLoading } = useLiveBoard(tickers);
  const universe = useMemo(() => overlayLive(baseUniverse, liveMap), [baseUniverse, liveMap]);

  const isLoading = pricesLoading || factorsLoading;
  // A hard failure with nothing cached — the only honest thing to show is that
  // the data is unavailable.
  const factorsUnavailable = !!factorsError && baseUniverse.length === 0;
  const asOfLabel = asOf ? fmtAsOf(asOf) : factorsUnavailable ? "Unavailable" : "Syncing…";

  const rankedTop = useMemo(() => boardRanking(horizon, universe).ranked.slice(0, 8), [horizon, universe]);
  const feature = rankedTop[0];

  // Publish the active lens + top-ranked names as the app-wide page context, so a
  // chat sent here ("what are the best of these?") is scoped to what's shown.
  useEffect(() => {
    const setActivePageContext = useChatStore.getState().setActivePageContext;
    const modeLabel = MODES.find((m) => m.key === mode)?.label ?? mode;
    setActivePageContext({
      kind: "research",
      label: `${modeLabel} lens`,
      snapshot: buildResearchSnapshot(mode, horizon, rankedTop),
    });
    return () => setActivePageContext(null);
  }, [mode, horizon, rankedTop]);

  return (
    <div className="research-root term vB1 flex flex-col h-full overflow-hidden">
      {/* Standardized page header — pill lens tabs + segmented horizon. */}
      <PageHeader
        title="Research"
        subtitle="SCORE ENGINE"
        center={
          <div className="b-lenses b-lenses-pill">
            {MODES.map((m) => (
              <button key={m.key} className={"b-lens" + (mode === m.key ? " on" : "")} onClick={() => setMode(m.key)}>{m.label}</button>
            ))}
          </div>
        }
        actions={
          <>
            {mode === "board" && (
              <RangeToggle options={HORIZON_KEYS} value={horizon} onChange={setHorizon} labels={HORIZON_LABELS} />
            )}
            <span className="mono b-asof">{asOfLabel}</span>
            <ChatContextButton context="research" />
          </>
        }
      />

      {/* Scrolling body — outer scroller stays a plain block so the inner
          flex column grows to its content height instead of shrink-clipping. */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ scrollbarGutter: "stable both-edges" }}>
        <div style={{ padding: "var(--content-pad-top) var(--page-gutter) var(--content-pad-bottom)", display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Lookup first — the most common reason to open this page is one stock. */}
          <ResearchSearch />

          {factorsUnavailable ? (
            <FactorsUnavailable onRetry={retryFactors} />
          ) : (
            <>
              {mode === "board" && (
                <>
                  {feature && <VerdictHero feature={feature} horizon={horizon} />}
                  <div className="b-split">
                    <BoardLeaderboard horizon={horizon} universe={universe} loading={isLoading} />
                    <MoversRail horizon={horizon} universe={universe} loading={isLoading} />
                  </div>
                </>
              )}

              {mode === "screen" && (
                <>
                  <div style={{ marginTop: 8 }}><SectionRule label={SECTION_RULE.screen!} /></div>
                  <ScreenMode universe={universe} loading={isLoading} />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
