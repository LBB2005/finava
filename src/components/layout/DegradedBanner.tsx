"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Slim, dismissible notice shown while an AI provider is failing (from
 * /api/health). Exists so an outage is visible instead of silently producing
 * thinner answers — the 13 Sep failure mode.
 *
 * Polls on window focus and every 60s, and never while the tab is hidden.
 * A dismissal lasts until health recovers; the next incident shows it again.
 */

const POLL_MS = 60_000;
// A focus burst (alt-tabbing) shouldn't fire a request per focus event.
const MIN_GAP_MS = 10_000;

type LlmStatus = "ok" | "degraded" | "down";

export default function DegradedBanner() {
  const [llm, setLlm] = useState<LlmStatus>("ok");
  const [dismissed, setDismissed] = useState(false);
  const lastCheck = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastCheck.current < MIN_GAP_MS) return;
      lastCheck.current = now;
      try {
        const res = await fetch("/api/health?scope=providers", { cache: "no-store" });
        const body = (await res.json()) as { llm?: LlmStatus };
        if (cancelled || !body.llm) return;
        setLlm(body.llm);
        if (body.llm === "ok") setDismissed(false);
      } catch {
        // Health endpoint unreachable says nothing about AI providers — keep state.
      }
    };

    const startPolling = () => {
      if (!timer) timer = setInterval(check, POLL_MS);
    };
    const stopPolling = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void check();
        startPolling();
      } else {
        stopPolling();
      }
    };

    void check();
    if (document.visibilityState === "visible") startPolling();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stopPolling();
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  if (llm === "ok" || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-3 md:px-4 py-1.5 flex-shrink-0 text-[12.5px] leading-snug fade-in"
      style={{
        background: "var(--color-warn-bg)",
        borderBottom: "1px solid var(--color-warn-border)",
        color: "var(--color-warn-text)",
      }}
    >
      <span
        aria-hidden
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: "var(--color-warn)" }}
      />
      <span className="flex-1 min-w-0">
        Some AI providers are having trouble — answers may be slower or less complete.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss notice"
        className="w-6 h-6 flex items-center justify-center rounded-md flex-shrink-0 hover:bg-[color-mix(in_srgb,var(--color-warn)_12%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-warn)] transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
    </div>
  );
}
