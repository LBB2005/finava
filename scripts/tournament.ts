import { config } from "dotenv";
import { firestoreCalendar } from "../src/lib/marketCalendar.server";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ExchangeCalendar,
  validDate,
  shiftDate,
  easternDate,
  type MarketSession,
} from "../src/lib/marketCalendar";
import { runDaily, verifyLedger } from "../src/lib/tournament/runtime";
import { DatedSources } from "../src/lib/tournament/sources";
import {
  fileTournamentState,
  firestoreTournamentLedger,
  firestoreTournamentJournal,
  withTournamentLock,
} from "../src/lib/live/ledgerTournament";
import {
  MemoryReservations,
  tournamentCap,
  type ReservationStore,
} from "../src/lib/live/budgetReservation";
import {
  fixtureSnapshot,
  fixtureSessions,
} from "../src/lib/tournament/fixtures";
import {
  gradeMatured,
  type ReturnProvider,
} from "../src/lib/tournament/grading";
import {
  markPortfolios,
  type MarkProvider,
} from "../src/lib/tournament/portfolio";
import { buildReport, reportMarkdown } from "../src/lib/tournament/report";
import type { TournamentLedger, Namespace } from "../src/lib/tournament/types";

async function main() {
  config({ path: [".env.local", ".env"], quiet: true });
  const args = process.argv.slice(2),
    command = args.shift() ?? "daily";
  const dry = args.includes("--dry-run"),
    offline = args.includes("--offline");
  const value = (key: string) =>
    args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
  if (!["daily", "grade", "report"].includes(command))
    throw new Error("Use daily, grade or report");
  if (offline && !dry) throw new Error("Offline fixtures require --dry-run");
  if (
    args.some(
      (a) =>
        !["--dry-run", "--offline"].includes(a) &&
        !/^--(?:date|state-dir)=/.test(a),
    )
  )
    throw new Error("Unknown tournament option");
  const namespace: Namespace = dry ? "tournament_dryrun" : "tournament";
  const codeSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const registrationHash = createHash("sha256")
    .update(await readFile("docs/tournament/SCORING.md"))
    .digest("hex");
  const source = new DatedSources();
  const now = offline ? new Date(fixtureSnapshot().observedAt) : new Date();
  let sessions: MarketSession[] = [];
  const calendar: ExchangeCalendar | undefined = offline
    ? undefined
    : await firestoreCalendar();
  const supplied = value("--date");
  if (supplied && !validDate(supplied)) throw new Error("Invalid date");
  const date =
    supplied ??
    (offline
      ? fixtureSessions()[0].date
      : command === "daily"
        ? (await calendar!.mostRecentCompleted(now)).date
        : easternDate(now));
  if (command === "daily") {
    sessions = offline
      ? fixtureSessions()
      : await calendar!.range(date, shiftDate(date, 400));
    if (!sessions.some((s) => s.date === date)) {
      console.log("market closed");
      process.exit(0);
    }
  }
  const state = offline
    ? await fileTournamentState(
        resolve(value("--state-dir") ?? ".tournament/offline"),
      )
    : {
        ledger: await firestoreTournamentLedger(namespace),
        journal: await firestoreTournamentJournal(namespace),
      };
  const reservations: ReservationStore = offline
    ? new MemoryReservations()
    : (await import("../src/lib/live/budget")).tournamentReservations(
        date,
        namespace,
      );
  async function allRows(ledger: TournamentLedger) {
    const batches = await verifyLedger(ledger);
    return (await Promise.all(batches.map((b) => ledger.rows(b.date)))).flat();
  }
  const fixtureReturns: ReturnProvider = async (row) => {
    const p = row.prediction,
      w = p.evaluationWindow!;
    const n = Number(p.ticker.slice(1));
    const series = {
      symbol: p.ticker,
      windowStart: w.entryAt.slice(0, 10),
      windowEnd: p.targetDate,
      startPrice: 100,
      endPrice: 100 + (Number.isFinite(n) ? n - 15 : 0),
      distributions: [],
      corporateActionAdjusted: true,
      adjustmentSource: "SYNTHETIC FIXTURE - NOT LIVE PRICES",
    };
    return {
      subject: series,
      benchmark: { ...series, symbol: "SPY", endPrice: 101 },
      corporateAction: null,
      invalidationObservations: [],
    };
  };
  const fixtureMark: MarkProvider = async () => ({
    open: 100,
    close: 101,
    splitFactor: 1,
    cashPerPreviousShare: 0,
    actionsComplete: true,
    reason: "SYNTHETIC FIXTURE",
  });
  async function grade() {
    const rows = await allRows(state.ledger);
    const gradeNow = offline ? new Date(fixtureSessions()[120].close) : now;
    const first = rows
      .map((r) => r.prediction.evaluationWindow!.entryAt.slice(0, 10))
      .sort()[0];
    const marksSessions = offline
      ? fixtureSessions().slice(1, 121)
      : first
        ? await calendar!.range(first, easternDate(now))
        : [];
    const grades = await gradeMatured(
      state.ledger,
      offline ? fixtureReturns : (r) => source.returns(r),
      gradeNow,
    );
    const portfolios = await markPortfolios(
      state.ledger,
      rows,
      marksSessions,
      offline
        ? fixtureMark
        : (ticker, session) => source.mark(ticker, session.date),
      gradeNow,
    );
    return { ...grades, portfolios };
  }
  async function report() {
    const rows = await allRows(state.ledger),
      grades = await state.ledger.grades(),
      portfolios = await state.ledger.portfolios();
    const data = buildReport(rows, grades, portfolios, namespace),
      entries = await reservations.entries();
    const cost = {
      httpAttempts: entries.length,
      measuredUsd: entries.every((e) => e.measuredUsd !== null)
        ? entries.reduce((n, e) => n + e.measuredUsd!, 0)
        : null,
      reservedUpperUsd: entries.reduce((n, e) => n + e.upperUsd, 0),
      capUsd: tournamentCap(),
      modelsExecuted: entries.length > 0,
    };
    const directory = `reports/${namespace}`;
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${directory}/${date}.json`,
      JSON.stringify(
        {
          ...data,
          generatedAt: now.toISOString(),
          codeSha,
          registrationHash,
          offline,
          cost,
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      `${directory}/${date}.md`,
      reportMarkdown(data) +
        `\nMode: ${offline ? "offline synthetic fixture; no paid models" : "prospective data"}. HTTP model attempts: ${cost.httpAttempts}. Measured USD: ${cost.measuredUsd ?? "unknown"}. Reserved upper USD: ${cost.reservedUpperUsd.toFixed(6)}.\n`,
    );
    return { report: `${directory}/${date}.md`, cost };
  }
  async function work() {
    if (command === "daily") {
      // A repeat only verifies the chain; it does not require fresh upstream inputs.
      if ((await verifyLedger(state.ledger)).some((b) => b.date === date)) {
        console.log(
          JSON.stringify({ status: "duplicate", date, verified: true }),
        );
        return;
      }
      if (
        !dry &&
        execFileSync(
          "git",
          [
            "status",
            "--porcelain",
            "--untracked-files=normal",
            "--",
            "src",
            "scripts",
            "docs/tournament/SCORING.md",
          ],
          { encoding: "utf8" },
        ).trim()
      )
        throw new Error(
          "Commit tournament code before a live run; provenance must identify the executing code",
        );
      const archived = await state.journal.get<
        Parameters<typeof runDaily>[0]["snapshot"]
      >(`${date}_snapshot`);
      const snapshot =
        archived ?? (offline ? fixtureSnapshot() : await source.snapshot(date));
      console.log(
        JSON.stringify(
          await runDaily({
            ...state,
            reservations,
            cap: tournamentCap(),
            snapshot,
            sessions,
            codeSha,
            registrationHash,
            namespace,
            now: () => (offline ? now : new Date()),
            modelsDisabled: offline,
          }),
        ),
      );
      if (dry) {
        console.log(JSON.stringify(await grade()));
        console.log(JSON.stringify(await report()));
      }
    } else if (command === "grade") console.log(JSON.stringify(await grade()));
    else console.log(JSON.stringify(await report()));
  }
  try {
    if (offline) await work();
    else await withTournamentLock(namespace, work);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Tournament command failed",
    );
    process.exitCode = 1;
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Tournament setup failed",
  );
  process.exitCode = 1;
});
