import { easternDate, type ExchangeCalendar } from "../marketCalendar";
import type { ReservationStore } from "../live/budgetReservation";
import { DETERMINISTIC_ARMS, HORIZONS, type TournamentLedger } from "./types";
import { verifyLedger } from "./runtime";

export interface OperatorAudit {
  status: "PASS" | "FAILED";
  date: string;
  hashChainVerified: boolean;
  rows: number;
  previousDate: string | null;
  previousRows: number | null;
  universe: number;
  unscoredNames: { ticker: string; reasons: string[] }[];
  spend: { measuredUsd: number | null; upperUsd: number; capUsd: number; httpAttempts: number };
  predictionsGradedToday: number;
  errors: string[];
}

export function operatorAuditMarkdown(audit: OperatorAudit): string {
  return [
    `Date: ${audit.date}; batch rows: ${audit.rows}; previous: ${audit.previousRows ?? "missing"}; hash chain: ${audit.hashChainVerified ? "PASS" : "FAILED"}`,
    `Unscored names: ${audit.unscoredNames.length}/${audit.universe}; reasons: ${JSON.stringify(audit.unscoredNames)}`,
    `LLM spend (combined daily): ${audit.spend.measuredUsd === null ? "unknown measured USD" : `$${audit.spend.measuredUsd}`}; reserved upper USD: $${audit.spend.upperUsd}; cap: $${audit.spend.capUsd}`,
    `Predictions graded on session date: ${audit.predictionsGradedToday}; verification: ${audit.status}${audit.errors.length ? ` (${audit.errors.join(", ")})` : ""}`,
  ].join("\n");
}

export async function auditTournament(args: {
  ledger: TournamentLedger; date: string; previousSessionDate: string | null;
  reservations: ReservationStore; cap: number;
}): Promise<OperatorAudit> {
  const { ledger, date, previousSessionDate, reservations, cap } = args;
  const batches = await verifyLedger(ledger);
  const current = batches.find(b => b.date === date);
  const previous = batches.find(b => b.date === previousSessionDate);
  const rows = current ? await ledger.rows(date) : [];
  const tickers = [...new Set(rows.map(r => r.prediction.ticker))].sort();
  const errors: string[] = [];
  if (!current) errors.push("current_session_batch_missing");
  if (!previous || previous.rowIds.length === 0) errors.push("previous_session_batch_missing");
  else if (Math.abs(rows.length - previous.rowIds.length) > previous.rowIds.length * 0.1)
    errors.push("row_count_outside_10_percent");
  const combinations = new Set(rows.map(r => `${r.prediction.ticker}/${r.arm}/${r.prediction.horizonCount}`));
  const arms = [...DETERMINISTIC_ARMS, "ensemble", "jev"];
  if (!tickers.length || rows.length !== tickers.length * arms.length * HORIZONS.length ||
      tickers.some(t => arms.some(a => HORIZONS.some(h => !combinations.has(`${t}/${a}/${h}`)))))
    errors.push("incomplete_universe_rows");
  // A complete composite requires value, quality, growth and momentum. A
  // contrarian quality-floor rejection is intentionally not missing coverage.
  const unscoredNames = tickers.flatMap(ticker => {
    const row = rows.find(r => r.prediction.ticker === ticker && r.arm === "composite");
    return !row || row.disposition === "unscored"
      ? [{ ticker, reasons: row?.reasons.length ? [...new Set(row.reasons)] : ["composite_score_missing"] }]
      : [];
  });
  if (!tickers.length || unscoredNames.length / tickers.length >= 0.05)
    errors.push("unscored_names_at_least_5_percent");
  const entries = await (reservations.dailyEntries?.() ?? reservations.entries());
  const invalid = entries.some(e => !Number.isFinite(e.upperUsd) || e.upperUsd <= 0 ||
    (e.measuredUsd !== null && (!Number.isFinite(e.measuredUsd) || e.measuredUsd < 0)));
  if (invalid) errors.push("invalid_spend_evidence");
  const measuredUsd = entries.every(e => e.measuredUsd !== null)
    ? entries.reduce((sum, e) => sum + e.measuredUsd!, 0) : null;
  const upperUsd = entries.reduce((sum, e) => sum + Math.max(e.upperUsd, e.measuredUsd ?? 0), 0);
  if (!Number.isFinite(cap) || cap < 0 || !Number.isFinite(upperUsd) || upperUsd >= cap)
    errors.push("spend_not_below_daily_cap");
  const grades = await ledger.grades();
  return {
    status: errors.length ? "FAILED" : "PASS", date, hashChainVerified: true,
    rows: rows.length, previousDate: previous?.date ?? null, previousRows: previous?.rowIds.length ?? null,
    universe: tickers.length, unscoredNames,
    spend: { measuredUsd, upperUsd, capUsd: cap, httpAttempts: entries.length },
    predictionsGradedToday: grades.filter(g => easternDate(new Date(g.gradedAt)) === date).length,
    errors,
  };
}

export async function selectRunDate(
  calendar: Pick<ExchangeCalendar, "range" | "mostRecentCompleted">,
  now: Date,
): Promise<string | null> {
  const today = easternDate(now);
  if (!(await calendar.range(today, today)).length) return null;
  return (await calendar.mostRecentCompleted(now)).date;
}
