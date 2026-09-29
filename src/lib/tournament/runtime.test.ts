import { it, expect, vi } from "vitest";
import { runDaily, MemoryJournal, sanitizeSnapshot } from "./runtime";
import { MemoryTournamentLedger } from "../live/ledgerTournament";
import { MemoryReservations } from "../live/budgetReservation";
import { fixtureSnapshot, fixtureSessions } from "./fixtures";
it("publishes all names and horizons, keeps model failures, and reruns without spending", async () => {
  const ledger = new MemoryTournamentLedger(),
    journal = new MemoryJournal();
  const s = fixtureSnapshot();
  const model = vi.fn().mockResolvedValue({
    status: "unavailable",
    forecasts: [],
    reason: "test missing key",
    model: null,
    costUsd: null,
    latencyMs: null,
  });
  const args = {
    ledger,
    journal,
    reservations: new MemoryReservations(),
    cap: 8,
    snapshot: s,
    sessions: fixtureSessions(),
    codeSha: "a".repeat(40),
    registrationHash: "b".repeat(64),
    namespace: "tournament_dryrun" as const,
    now: () => new Date(s.observedAt),
    model,
  };
  const a = await runDaily(args);
  expect(a.status).toBe("created");
  expect((await ledger.rows(s.asOf.slice(0, 10))).length).toBe(
    s.names.length * 8 * 5,
  );
  expect(model.mock.calls.length).toBeLessThanOrEqual(4);
  const n = model.mock.calls.length;
  expect((await runDaily(args)).status).toBe("duplicate");
  expect(model).toHaveBeenCalledTimes(n);
});
it("forbids forward-looking facts and late backfill before model spend", async () => {
  const s = fixtureSnapshot();
  const model = vi.fn();
  const args = {
    ledger: new MemoryTournamentLedger(),
    journal: new MemoryJournal(),
    reservations: new MemoryReservations(),
    cap: 8,
    snapshot: s,
    sessions: fixtureSessions(),
    codeSha: "a".repeat(40),
    registrationHash: "b".repeat(64),
    namespace: "tournament" as const,
    now: () => new Date("2026-07-07T21:00:00Z"),
    model,
  };
  await expect(runDaily(args)).rejects.toThrow(/entry/);
  expect(model).not.toHaveBeenCalled();
});
it("uses a create-only checkpoint and never replays an interrupted paid step", async () => {
  const j = new MemoryJournal();
  await j.create("model", { status: "started" });
  await expect(j.create("model", { status: "done" })).rejects.toThrow(
    /conflict/,
  );
});

it("sanitizing a checkpoint twice is byte stable", () => {
  const s = fixtureSnapshot();
  s.names[0].inputs.price.asOf = "2028-01-01";
  const clean = sanitizeSnapshot(s);
  expect(sanitizeSnapshot(clean)).toEqual(clean);
});

it("never relabels checkpointed forecasts with changed code or scoring registration", async () => {
  const ledger = new MemoryTournamentLedger(),
    journal = new MemoryJournal(),
    s = fixtureSnapshot();
  const originalAppend = ledger.appendBatch.bind(ledger);
  ledger.appendBatch = vi
    .fn()
    .mockRejectedValue(new Error("publication interrupted"));
  const model = vi
    .fn()
    .mockResolvedValue({
      status: "unavailable",
      forecasts: [],
      reason: "fixture",
      model: null,
      costUsd: 0,
      latencyMs: 0,
    });
  const options = {
    ledger,
    journal,
    reservations: new MemoryReservations(),
    cap: 8,
    snapshot: s,
    sessions: fixtureSessions(),
    codeSha: "a".repeat(40),
    registrationHash: "b".repeat(64),
    namespace: "tournament_dryrun" as const,
    now: () => new Date(s.observedAt),
    model,
  };
  await expect(runDaily(options)).rejects.toThrow(/interrupted/);
  const calls = model.mock.calls.length;
  ledger.appendBatch = originalAppend;
  await expect(
    runDaily({ ...options, codeSha: "c".repeat(40) }),
  ).rejects.toThrow(/metadata/);
  await expect(
    runDaily({ ...options, registrationHash: "d".repeat(64) }),
  ).rejects.toThrow(/metadata/);
  expect(model).toHaveBeenCalledTimes(calls);
  expect((await runDaily(options)).status).toBe("created");
  expect(model).toHaveBeenCalledTimes(calls);
});
