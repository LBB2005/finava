"use client";
import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useStockBundle } from "@/hooks/useStock";
import { useQuotes } from "@/hooks/useQuotes";
import { useTickerFacts } from "@/hooks/useTickerFacts";
import { factTitle } from "@/lib/facts/format";
import { useChatStore } from "@/stores/chatStore";
import { buildStockSnapshot } from "@/lib/pageContext";
import { useToast } from "@/hooks/useToast";
import { runFinava } from "@/lib/finavaStore";
import StockHero from "@/components/stock/StockHero";
import { OverviewTab, FinancialsTab, StreetNewsTab } from "@/components/stock/StockTabs";
import { DcfTab } from "@/components/stock/DcfTab";
import { FinavaTab } from "@/components/stock/FinavaTab";
import { MoneyMapTab } from "@/components/stock/MoneyMapTab";
import ChatContextButton from "@/components/chat/ChatContextButton";
import PageHeader from "@/components/layout/PageHeader";
import AddToWatchlistButton from "@/components/watchlist/AddToWatchlistButton";

const TABS = ["Overview", "Financials", "Street & News", "Finava", "Money Map"] as const;
type Tab = (typeof TABS)[number];

/** Resolve a ?tab= param (case-insensitive, tolerant of old names) to a Tab. */
function tabFromParam(raw: string | null): Tab | null {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase();
  const direct = TABS.find((t) => t.toLowerCase() === norm);
  if (direct) return direct;
  // Aliases — pre-consolidation names keep landing somewhere sane.
  if (norm === "analysts" || norm === "news" || norm === "street" || norm === "street-and-news") return "Street & News";
  if (norm === "finava-analysis" || norm === "analysis" || norm === "dcf") return "Finava";
  if (norm === "moneymap" || norm === "money-map") return "Money Map";
  return null;
}

/* useSearchParams requires a Suspense boundary in the App Router — the inner
   component holds all page logic; this wrapper only satisfies the bailout. */
export default function StockPage() {
  return (
    <Suspense fallback={null}>
      <StockPageInner />
    </Suspense>
  );
}

function StockPageInner() {
  const params = useParams<{ ticker: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const ticker = (params?.ticker ?? "").toUpperCase();

  const { bundle, error, isLoading, mutate } = useStockBundle(ticker || null);
  const { quoteMap } = useQuotes(ticker ? [ticker] : []);
  const facts = useTickerFacts(ticker || null);
  const [tab, setTab] = useState<Tab>(() => tabFromParam(searchParams.get("tab")) ?? "Overview");

  // ?run=1 deep link (rail "Generate", notifications): start a metered run once
  // the page is mounted. runFinava self-dedupes, so a re-render can't double-fire.
  useEffect(() => {
    if (ticker && searchParams.get("run") === "1") {
      // Deep-link intent: this fires once per ticker to land the user on the tab
      // they asked for, so the extra render is the point, not a cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTab("Finava");
      void runFinava(ticker, { force: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);
  // Flips on if the bundle hasn't arrived after a beat, so the skeleton can admit
  // it's taking longer than usual and offer a manual retry instead of hanging.
  const [slow, setSlow] = useState(false);

  // Surface genuine load failures via a toast in addition to the inline state.
  // A 404 (unknown symbol) is a user-input issue already explained clearly in
  // the full-page state, so we skip toasting for it to avoid redundant noise.
  useEffect(() => {
    if (error && error.status !== 404) {
      toast.error(`Couldn't load ${ticker}. The data service may be unavailable — please retry.`);
    }
  }, [error, ticker, toast]);

  // Publish the loaded bundle as the app-wide "active page context" so the chat
  // composer can attach a ticker+data snapshot to whatever the user asks — and
  // resolve vague references ("is this a buy?") to this stock. Cleared on
  // unmount / ticker change so a stale ticker can never leak into an off-page chat.
  useEffect(() => {
    const setActivePageContext = useChatStore.getState().setActivePageContext;
    if (bundle && ticker) {
      setActivePageContext({ kind: "stock", ticker, snapshot: buildStockSnapshot(bundle) });
    }
    return () => setActivePageContext(null);
  }, [bundle, ticker]);

  // Arm a slow-load timer while loading; the cleanup clears it and resets the
  // flag whenever the ticker changes or the bundle finishes loading.
  const loadingBundle = isLoading || !bundle;
  useEffect(() => {
    if (!loadingBundle || error) return;
    const id = window.setTimeout(() => setSlow(true), 9000);
    return () => {
      window.clearTimeout(id);
      setSlow(false);
    };
  }, [loadingBundle, error, ticker]);

  /* ── Error states ─────────────────────────────────────────────────────── */
  if (error) {
    const notFound = error.status === 404;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6" style={{ background: "var(--color-bg)" }}>
        <p className="text-[length:var(--text-title)] font-semibold text-[var(--color-text)]" style={{ fontFamily: "var(--font-serif)" }}>
          {notFound ? `Couldn't find “${ticker}”` : "Couldn't load this stock"}
        </p>
        <p className="text-[length:var(--text-sm)] text-[var(--color-muted)] max-w-[360px] text-center">
          {notFound
            ? "Double-check the symbol, or try another ticker."
            : error.message || "The data service may be unavailable right now."}
        </p>
        <button onClick={() => router.push("/portfolio")} className="btn btn-primary mt-1">
          Back to portfolio
        </button>
      </div>
    );
  }

  /* ── Loading state ────────────────────────────────────────────────────── */
  if (loadingBundle) {
    return (
      <div className="research-root h-full flex flex-col overflow-hidden" style={{ background: "var(--color-bg)" }} aria-busy="true" aria-label={`Loading ${ticker}`}>
        <PageHeader title={ticker} />
        <div className="flex-1 min-h-0 overflow-y-auto">
        <div style={{ padding: "18px var(--page-gutter) 0", background: "linear-gradient(180deg, var(--color-accent-light), transparent 80%)" }}>
          <div className="flex items-center gap-3.5">
            <div className="w-[44px] h-[44px] rounded-[var(--radius-sm)] skeleton" />
            <div className="flex flex-col gap-2">
              <div className="h-[20px] w-[160px] skeleton" />
              <div className="h-[12px] w-[120px] skeleton" />
            </div>
          </div>
          <div className="h-[46px] w-[200px] skeleton mt-4" />
          <div className="h-[300px] skeleton mt-3" />

          {!slow ? (
            <p className="mt-3.5 text-[length:var(--text-meta)] flex items-center gap-2" style={{ color: "var(--color-muted)" }}>
              <span className="spin inline-block w-3 h-3 rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-accent)]" />
              Loading quote &amp; chart for {ticker}…
            </p>
          ) : (
            <div className="mt-3.5 flex items-center gap-3">
              <p className="text-[length:var(--text-meta)]" style={{ color: "var(--color-muted)" }}>
                Taking longer than usual — the data service may be busy.
              </p>
              <button
                onClick={() => { setSlow(false); mutate(); }}
                className="btn"
                style={{ borderColor: "var(--color-accent)", color: "var(--color-accent)", background: "var(--color-accent-light)" }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
        </div>
      </div>
    );
  }

  /* ── Loaded ───────────────────────────────────────────────────────────── */
  const livePrice = quoteMap.get(ticker)?.price ?? bundle.quote?.price ?? null;
  const chg = quoteMap.get(ticker)?.changePct ?? null;
  const subtitle = [
    bundle.profile?.exchange ? `${bundle.profile.exchange}: ${ticker}` : ticker,
    bundle.profile?.industry,
  ].filter(Boolean).join(" · ");

  return (
    <div className="research-root stock-page h-full flex flex-col overflow-hidden" style={{ background: "var(--color-bg)" }}>
      {/* Standard masthead — same bar, title type, and gutters as every page. */}
      <PageHeader
        title={bundle.profile?.name ?? ticker}
        subtitle={subtitle}
        actions={<AddToWatchlistButton ticker={ticker} variant="button" />}
      />
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ scrollbarGutter: "stable both-edges" }}>
      <StockHero
        ticker={ticker}
        profile={bundle.profile}
        fallbackQuote={bundle.quote}
        initialCandles={bundle.candles}
        initialRange={bundle.candleRange}
        onOpenAnalysis={(opts) => {
          setTab("Finava");
          if (opts?.run) void runFinava(ticker, { force: true });
        }}
        onOpenDcf={() => {
          setTab("Finava");
          // Let the tab mount, then bring the DCF chapter into view.
          requestAnimationFrame(() => {
            document.getElementById("dcf-chapter")?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        }}
      />

      {/* Sticky tab bar — pill lenses + mini ticker/price (F2d) */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", rowGap: 12,
          padding: "10px var(--page-gutter)",
          borderBottom: "1px solid var(--color-border)",
          background: "color-mix(in oklab, var(--color-surface) 92%, transparent)",
          backdropFilter: "blur(8px)",
          position: "sticky", top: 0, zIndex: 5,
        }}
      >
        <div className="b-lenses b-lenses-pill">
          {TABS.map((t) => (
            <button key={t} className={"b-lens" + (tab === t ? " on" : "")} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <span className="ticker-chip">{ticker}</span>
          {livePrice != null && (
            <span className="serif" title={facts.data ? factTitle(facts.data.price) : undefined} style={{ fontSize: "var(--text-lg)", fontWeight: 800, color: "var(--color-text)" }}>
              ${livePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
          {chg != null && (
            <span className="mono" style={{ fontSize: "var(--text-meta)", fontWeight: 700, color: chg >= 0 ? "var(--color-bull)" : "var(--color-bear)" }}>
              {chg >= 0 ? "+" : ""}{chg.toFixed(2)}%
            </span>
          )}
          <span style={{ width: 1, height: 22, background: "var(--color-border)" }} />
          <ChatContextButton context={`stock:${ticker}`} />
        </div>
      </div>

      {/* Tab content */}
      <div style={{ padding: "22px var(--page-gutter) var(--content-pad-bottom)" }}>
        {tab === "Overview" && (
          <OverviewTab
            ticker={ticker}
            profile={bundle.profile}
            keyStats={bundle.keyStats}
            news={bundle.news}
            onOpenAnalysis={(opts) => {
              setTab("Finava");
              if (opts?.run) void runFinava(ticker, { force: true });
            }}
          />
        )}
        {tab === "Financials" && <FinancialsTab fundamentals={bundle.fundamentals} />}
        {tab === "Street & News" && (
          <StreetNewsTab analysts={bundle.analysts} price={livePrice} news={bundle.news} sentiment={bundle.sentiment} />
        )}
        {tab === "Finava" && (
          <>
            <FinavaTab ticker={ticker} />
            {/* DCF chapter — merged under Finava (full two-chapter hero lands in Phase E) */}
            <div id="dcf-chapter" style={{ marginTop: 34 }}>
              <DcfTab ticker={ticker} />
            </div>
          </>
        )}
        {tab === "Money Map" && <MoneyMapTab ticker={ticker} />}
      </div>
      </div>
    </div>
  );
}
