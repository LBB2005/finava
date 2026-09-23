"use client";

// Driving a persisted research run from the client.
//
// The architecture this hook exposes is deliberately modest, and the modesty is
// the feature. A run advances ONE bounded stage per POST, because no serverless
// invocation can be trusted to outlive a multi-stage research job, and because
// fire-and-forget paid work after an HTTP response is how a cancelled tab still
// spends money. So the client is the thing that keeps advancing it.
//
// The honest consequence: when nothing is advancing a run, it is PAUSED, and the
// UI says paused. It does not say "working in the background", because nothing is.
// A refresh resumes from the last persisted stage rather than repeating completed
// work — the server returns the stored result for a replayed stage.
//
// `start()` is the only function that may spend money, and it only ever runs from
// an explicit user action. Mounting this hook, or landing on a URL with a ticker
// in it, must never trigger paid research.

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/authFetch";
import { resolveHorizon } from "@/lib/investment/horizon";
import type { InvestmentReport, RunStage, RunStatus } from "@/lib/investment/contracts";
import type { ResolvedHorizonContract } from "@/lib/investment/schemas";

export interface RunView {
  runId: string;
  stage: RunStage;
  status: RunStatus;
  reportId: string | null;
  gaps: string[];
  error: string | null;
  /**
   * The horizon the SERVER resolved for this run.
   *
   * Comes from the server rather than being recomputed here, so the label always
   * matches the horizon the numbers were actually produced for. When the server
   * does not supply it, the UI shows no horizon label at all rather than
   * asserting one it cannot verify.
   */
  horizon?: ResolvedHorizonContract;
}

interface State {
  run: RunView | null;
  report: InvestmentReport | null;
  /** True only while a request is in flight, not while a run sits paused. */
  busy: boolean;
  error: string | null;
  /** Wall-clock since start, for an honest progress indicator. */
  elapsedMs: number;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(["complete", "failed", "cancelled"]);

export function useInvestmentRun(existingRunId?: string | null) {
  const [state, setState] = useState<State>({
    run: null,
    report: null,
    busy: false,
    error: null,
    elapsedMs: 0,
  });

  // Guards against a stale response from an abandoned run overwriting a newer one.
  const activeRunId = useRef<string | null>(existingRunId ?? null);
  const startedAt = useRef<number | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      // Unmounting stops the client advancing the run. The run itself is
      // persisted and simply becomes paused; it is not lost and not continued.
      cancelled.current = true;
    };
  }, []);

  // Elapsed time ticks only while a request is genuinely in flight.
  useEffect(() => {
    if (!state.busy || startedAt.current == null) return;
    const id = setInterval(() => {
      if (startedAt.current != null) {
        setState((s) => ({ ...s, elapsedMs: Date.now() - startedAt.current! }));
      }
    }, 500);
    return () => clearInterval(id);
  }, [state.busy]);

  const read = useCallback(async (runId: string) => {
    // A GET is read-only: it reports state and never advances a stage, so
    // polling or refreshing cannot spend anything.
    const res = await authFetch(`/api/investment/runs/${runId}`);
    if (!res.ok) throw new Error(`Could not read run (${res.status})`);
    return (await res.json()) as { run: RunView; report: InvestmentReport | null };
  }, []);

  /** Resume a run that already exists. Safe on mount — it only reads. */
  const resume = useCallback(
    async (runId: string) => {
      activeRunId.current = runId;
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        const { run, report } = await read(runId);
        if (cancelled.current || activeRunId.current !== runId) return;
        setState((s) => ({ ...s, run, report, busy: false }));
      } catch (e) {
        if (cancelled.current) return;
        setState((s) => ({ ...s, busy: false, error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [read]
  );

  useEffect(() => {
    if (existingRunId) void resume(existingRunId);
  }, [existingRunId, resume]);

  /** Advance one stage. Returns the run so a caller can loop. */
  const advance = useCallback(
    async (runId: string): Promise<RunView | null> => {
      const res = await authFetch(`/api/investment/runs/${runId}/advance`, { method: "POST" });
      if (!res.ok) throw new Error(`Stage failed (${res.status})`);
      const body = (await res.json()) as { run: RunView; report: InvestmentReport | null };
      if (cancelled.current || activeRunId.current !== runId) return null;
      setState((s) => ({ ...s, run: body.run, report: body.report ?? s.report }));
      return body.run;
    },
    []
  );

  /**
   * Create a run and drive it to completion, one stage at a time.
   *
   * This is the ONLY money-spending entry point, and it must be called from an
   * explicit user action.
   */
  const start = useCallback(
    async (input: { ticker: string; horizonMonths: number; assumed?: boolean; query?: string }) => {
      startedAt.current = Date.now();
      setState({ run: null, report: null, busy: true, error: null, elapsedMs: 0 });
      try {
        // Resolved here so the request is well-formed, but the SERVER re-derives
        // targetDate and yearFraction and ignores what we send for them — the
        // hurdle compounds over yearFraction, so it is not the client's to set.
        const horizon = resolveHorizon(
          { count: input.horizonMonths, unit: "calendar_months" },
          new Date().toISOString()
        );
        if (horizon.status !== "resolved") {
          throw new Error(
            horizon.status === "unsupported_calendar"
              ? horizon.reason
              : `That horizon is not supported: ${horizon.reason}`
          );
        }

        const created = await authFetch("/api/investment/runs", {
          method: "POST",
          body: JSON.stringify({
            mandate: {
              mode: "analyze",
              query: input.query ?? `Analyze ${input.ticker} over ${input.horizonMonths} months`,
              ticker: input.ticker,
              horizon: { ...horizon.horizon, assumed: input.assumed ?? false },
              benchmark: "SPY",
              universeVersion: "sp500",
              hardFilter: null,
              qualitativeCriteria: [],
            },
            // Scoped so a retry of THIS analysis is deduplicated, while a genuine
            // re-run for a different horizon is a separate run with its own budget.
            idempotencyKey: `${input.ticker}:${input.horizonMonths}:${startedAt.current}`,
          }),
        });
        if (!created.ok) throw new Error(`Could not start research (${created.status})`);
        const body = (await created.json()) as {
          runId: string;
          status: RunView["status"];
          stage: RunView["stage"];
        };
        const run: RunView = {
          runId: body.runId,
          stage: body.stage,
          status: body.status,
          reportId: null,
          gaps: [],
          error: null,
        };
        activeRunId.current = run.runId;
        if (cancelled.current) return;
        setState((s) => ({ ...s, run }));

        // Bounded loop: one request per stage, with a hard ceiling so a server
        // that never reaches a terminal state cannot spin forever.
        let current: RunView | null = run;
        for (let i = 0; i < 12 && current && !TERMINAL.has(current.status); i++) {
          if (cancelled.current) return;
          current = await advance(run.runId);
        }
        if (!cancelled.current) setState((s) => ({ ...s, busy: false }));
      } catch (e) {
        if (cancelled.current) return;
        setState((s) => ({ ...s, busy: false, error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [advance]
  );

  const cancel = useCallback(async () => {
    const runId = activeRunId.current;
    if (!runId) return;
    try {
      await authFetch(`/api/investment/runs/${runId}/cancel`, { method: "POST" });
      const { run, report } = await read(runId);
      if (!cancelled.current) setState((s) => ({ ...s, run, report, busy: false }));
    } catch {
      // A failed cancel leaves the run as it was; the server is the source of
      // truth and the next read will show it.
      if (!cancelled.current) setState((s) => ({ ...s, busy: false }));
    }
  }, [read]);

  /**
   * True when a run exists, has not finished, and nothing is advancing it. The UI
   * must show this as "paused", never as work in progress.
   */
  const paused =
    state.run != null && !state.busy && !TERMINAL.has(state.run.status);

  return { ...state, paused, start, advance, resume, cancel };
}
