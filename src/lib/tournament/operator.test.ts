import { expect, it, vi } from "vitest";
import { MemoryTournamentLedger } from "../live/ledgerTournament";
import { MemoryReservations } from "../live/budgetReservation";
import { fixtureSessions, fixtureSnapshot } from "./fixtures";
import { runDaily, MemoryJournal } from "./runtime";
import { auditTournament, operatorAuditMarkdown, selectRunDate, markingSessions } from "./operator";
import { buildReport, leaderboardMarkdown, reportMarkdown } from "./report";

async function setup(count = 20, unscored = 0, previousCount = count) {
  const ledger = new MemoryTournamentLedger();
  for (const [date, size, absent] of [["2026-07-02", previousCount, 0], ["2026-07-06", count, unscored]] as const) {
    const snapshot = fixtureSnapshot();
    const session = fixtureSessions().find(s => s.date === date)!;
    snapshot.asOf = session.close;
    snapshot.observedAt = new Date(Date.parse(session.close) + 60_000).toISOString();
    snapshot.membership.date = date;
    snapshot.membership.members = snapshot.membership.members.slice(0, size);
    snapshot.names = snapshot.names.slice(0, size);
    for (const name of snapshot.names.slice(0, absent)) {
      name.inputs.price = { value: null, asOf: session.close, source: "fixture", note: "opening feed unavailable" };
    }
    await runDaily({ ledger, journal: new MemoryJournal(), snapshot,
      sessions: fixtureSessions(), codeSha: "a".repeat(40), registrationHash: "b".repeat(64),
      namespace: "tournament_dryrun", now: () => new Date(snapshot.observedAt),
      reservations: new MemoryReservations(), cap: 8, modelsDisabled: true });
  }
  return { ledger, date: "2026-07-06", previousSessionDate: "2026-07-02", reservations: new MemoryReservations(), cap: 8 };
}

it("verifies the chain and counts names once across eight arms and five horizons", async () => {
  const result = await auditTournament(await setup());
  expect(result.status).toBe("PASS");
  expect(result.hashChainVerified).toBe(true);
  expect(result.rows).toBe(800);
  expect(result.universe).toBe(20);
  expect(result.unscoredNames).toEqual([]);
  expect(result.previousRows).toBe(800);
});

it("fails at exactly five percent unscored rather than hiding it across horizons", async () => {
  const result = await auditTournament(await setup(20, 1));
  expect(result.status).toBe("FAILED");
  expect(result.errors).toContain("unscored_names_at_least_5_percent");
  expect(result.unscoredNames).toHaveLength(1);
  expect(result.unscoredNames[0].reasons.join(" ")).toContain("opening feed unavailable");
});

it("allows exactly ten percent row movement but fails beyond it", async () => {
  expect((await auditTournament(await setup(22, 0, 20))).status).toBe("PASS");
  expect((await auditTournament(await setup(23, 0, 20))).errors).toContain("row_count_outside_10_percent");
});

it("fails when the immediately previous exchange session is missing, including first run", async () => {
  const args = await setup();
  expect((await auditTournament({ ...args, previousSessionDate: "2026-07-01" })).errors)
    .toContain("previous_session_batch_missing");
  expect((await auditTournament({ ...args, date: "2026-07-07" })).errors)
    .toContain("current_session_batch_missing");
});

it("reports unknown invoice dollars honestly and tests the retained reservation against the strict cap", async () => {
  const args = await setup();
  await args.reservations.reserve("unknown", 0.25, 8);
  const result = await auditTournament(args);
  expect(result.status).toBe("PASS");
  expect(result.spend.measuredUsd).toBeNull();
  expect(result.spend.upperUsd).toBe(0.25);
  expect((await auditTournament({ ...args, cap: 0.25 })).errors).toContain("spend_not_below_daily_cap");
});

it("does not accept a mutated sealed row as a verified operator report", async () => {
  const args = await setup();
  const rows = args.ledger.rows.bind(args.ledger);
  args.ledger.rows = async date => { const result = await rows(date); result[0].reasons.push("tampered"); return result; };
  await expect(auditTournament(args)).rejects.toThrow();
});

it("does not fall back to Friday when the routine runs on a holiday", async () => {
  const calendar = { range: async () => [], mostRecentCompleted: async () => fixtureSessions()[0] };
  expect(await selectRunDate(calendar, new Date("2026-07-03T21:30:00Z"))).toBeNull();
});

it("uses the same completed-session date for all commands", async () => {
  const last = fixtureSessions().find(s => s.date === "2026-07-06")!;
  const calendar = { range: async () => [last], mostRecentCompleted: async () => last };
  expect(await selectRunDate(calendar, new Date("2026-07-07T02:00:00Z"))).toBe("2026-07-06");
});

it("prints the report's leaderboard verbatim with minimum-sample labels", () => {
  const report = buildReport([], [], [], "tournament");
  report.leaderboard = [{arm:"value",cohortVersion:"v1",primaryMean:null,tStatistic:null,dailyObservations:1,brier:null,status:"insufficient data"}];
  const table = leaderboardMarkdown(report);
  expect(table).toContain("| value | insufficient data | insufficient data | 1 | insufficient data |");
  expect(reportMarkdown(report)).toContain(table);
});

it("makes a failed saved report explicit without inventing measured spend", async () => {
  const args = await setup();
  await args.reservations.reserve("pending", 0.25, 8);
  const audit = await auditTournament({ ...args, previousSessionDate: null });
  const text = operatorAuditMarkdown(audit);
  expect(text).toContain("verification: FAILED (previous_session_batch_missing)");
  expect(text).toContain("unknown measured USD; reserved upper USD: $0.25");
  expect(text.split("\n")).toHaveLength(4);
});
it('audits the combined daily budget including rehearsal reservations',async()=>{
 const args=await setup();
 const store={reserve:args.reservations.reserve.bind(args.reservations),measure:args.reservations.measure.bind(args.reservations),
  entries:async()=>[{id:'live',upperUsd:3,measuredUsd:null}],
  dailyEntries:async()=>[{id:'live',upperUsd:3,measuredUsd:null},{id:'dry',upperUsd:5,measuredUsd:null}]};
 const result=await auditTournament({...args,reservations:store});
 expect(result.spend.upperUsd).toBe(8);expect(result.spend.httpAttempts).toBe(2);
 expect(result.errors).toContain('spend_not_below_daily_cap');
});

it("does not request a reversed calendar range before the first prediction entry", async () => {
  const range = vi.fn(async (start: string, end: string) => {
    if (start > end) throw new Error("Invalid calendar range");
    return fixtureSessions();
  });
  expect(await markingSessions({range}, "2026-09-30", "2026-09-29")).toEqual([]);
  expect(await markingSessions({range}, undefined, "2026-09-29")).toEqual([]);
  expect(range).not.toHaveBeenCalled();
  expect(await markingSessions({range}, "2026-09-30", "2026-09-30")).toEqual(fixtureSessions());
  expect(range).toHaveBeenCalledWith("2026-09-30", "2026-09-30");
});
