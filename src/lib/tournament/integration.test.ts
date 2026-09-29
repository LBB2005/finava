import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryTournamentLedger,
  fileTournamentState,
  makeBatch,
} from "../live/ledgerTournament";
import { fixtureSnapshot, fixtureSessions } from "./fixtures";
import { makePrediction } from "./predictions";
import { sessionWindow } from "../marketCalendar";
import { gradeMatured } from "./grading";
import { markPortfolios } from "./portfolio";
import { buildReport } from "./report";
async function setup() {
  const s = fixtureSnapshot(),
    sessions = fixtureSessions(),
    w = sessionWindow(sessions, s.asOf.slice(0, 10), 1);
  const row = makePrediction({
    snapshot: s,
    arm: "growth",
    ticker: "T1",
    rank: 1,
    decile: 10,
    disposition: "long",
    horizon: 1,
    window: w,
    codeSha: "a".repeat(40),
    registrationHash: "b".repeat(64),
    createdAt: s.observedAt,
  });
  const batch = makeBatch([row], null, {
    date: row.date,
    asOf: s.asOf,
    createdAt: s.observedAt,
    codeSha: row.codeSha,
    registrationHash: row.registrationHash,
    snapshotHash: row.snapshotHash,
    namespace: "tournament_dryrun",
  });
  const ledger = new MemoryTournamentLedger();
  await ledger.appendBatch(batch, [row]);
  return { row, batch, ledger, sessions, w };
}
it("creates grades separately, preserves non-resolution and never regrades a published horizon", async () => {
  const { row, ledger, w } = await setup();
  let calls = 0;
  const provider = async () => {
    calls++;
    return {
      subject: {
        symbol: "T1",
        windowStart: w.entryDate,
        windowEnd: w.targetDate,
        startPrice: 100,
        endPrice: null,
        distributions: [],
        corporateActionAdjusted: true,
        adjustmentSource: "fixture halt",
      },
      benchmark: null,
      corporateAction: null,
      invalidationObservations: [],
    };
  };
  expect(await gradeMatured(ledger, provider, new Date(w.entryAt))).toEqual({
    graded: 0,
  });
  expect(await gradeMatured(ledger, provider, new Date(w.targetAt))).toEqual({
    graded: 1,
  });
  expect((await ledger.grades())[0].result).toMatchObject({
    status: "resolved",
    outcome: { realisedTotalReturn: null },
  });
  expect(await gradeMatured(ledger, provider, new Date(w.targetAt))).toEqual({
    graded: 0,
  });
  expect(calls).toBe(1);
  expect((await ledger.rows(row.date))[0]).toEqual(row);
  const report = buildReport(
    [row],
    await ledger.grades(),
    [],
    "tournament_dryrun",
  );
  expect(
    report.cohorts.find((c) => c.arm === "growth" && c.horizon === 1)
      ?.missingness,
  ).toMatchObject({});
});
it("applies split shares and distribution entitlements before next-day valuation", async () => {
  const { row, ledger, sessions } = await setup();
  await markPortfolios(
    ledger,
    [row],
    sessions.slice(1, 2),
    async () => ({
      open: 100,
      close: 100,
      splitFactor: 1,
      cashPerPreviousShare: 0,
      actionsComplete: true,
      reason: null,
    }),
    new Date(sessions[1].close),
  );
  const first = (await ledger.portfolios()).find((p) => p.arm === "growth")!;
  await markPortfolios(
    ledger,
    [row],
    sessions.slice(2, 3),
    async () => ({
      open: 50,
      close: 50,
      splitFactor: 2,
      cashPerPreviousShare: 1,
      actionsComplete: true,
      reason: null,
    }),
    new Date(sessions[2].close),
  );
  const second = (await ledger.portfolios()).find(
    (p) => p.arm === "growth" && p.date === sessions[2].date,
  )!;
  expect(second.positions[0].shares).toBeCloseTo(first.positions[0].shares * 2);
  expect(second.nav).toBeCloseTo(first.nav! + first.positions[0].shares);
  expect(second.costUsd).toBe(0);
});
it("persists the full chain across process-like reloads with conflicting writes refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "finava-tournament-test-"));
  try {
    const { row, batch } = await setup();
    const a = await fileTournamentState(dir);
    await a.ledger.appendBatch(batch, [row]);
    await a.journal.create("snapshot", { source: "fixture" });
    const b = await fileTournamentState(dir);
    expect(await b.journal.get("snapshot")).toEqual({ source: "fixture" });
    expect(await b.ledger.appendBatch(batch, [row])).toBe("duplicate");
    await expect(
      b.journal.create("snapshot", { source: "changed" }),
    ).rejects.toThrow(/conflict/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not grade proceeds from a termination before the entry date or substitute a non-SPY benchmark", async () => {
  const { row, w } = await setup();
  const { resolvePrediction, NON_RESOLUTION } = await import(
    "../investment/evaluation/outcomes"
  );
  const subject = {
    symbol: row.prediction.ticker,
    windowStart: w.entryDate,
    windowEnd: w.targetDate,
    startPrice: 100,
    endPrice: 110,
    distributions: [],
    corporateActionAdjusted: true,
    adjustmentSource: "fixture",
  };
  const base = {
    subject,
    benchmark: { ...subject, symbol: "QQQ" },
    corporateAction: null,
    invalidationObservations: [],
  };
  const mismatch = resolvePrediction(row.prediction, base, {
    now: new Date(w.targetAt),
  });
  expect(mismatch).toMatchObject({
    status: "resolved",
    outcome: { targets: { outperformBenchmark: { status: "unresolved" } } },
  });
  const before = resolvePrediction(
    row.prediction,
    {
      ...base,
      corporateAction: {
        kind: "cash_acquisition",
        effectiveDate: "2026-07-04",
        proceedsPerShare: 120,
        detail: "fixture",
      },
    },
    { now: new Date(w.targetAt) },
  );
  expect(before).toMatchObject({
    status: "unresolved",
    reason: NON_RESOLUTION.missingStartPrice,
  });
});
