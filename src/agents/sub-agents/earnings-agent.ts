import { generate } from "@/lib/llm";
import { getEarnings, getEarningsCalendar, getRecommendationTrends } from "@/lib/finnhub";
import { getSkillsPrompt } from "@/agents/skills";

/** One row of Finnhub's earnings calendar. */
export interface EarningsCalendarRow {
  symbol?: string;
  date?: string;
  epsEstimate?: number | null;
  epsActual?: number | null;
  revenueEstimate?: number | null;
  quarter?: number;
  year?: number;
}

export interface NextEarnings {
  date: string;
  quarter: number | null;
  year: number | null;
  epsEstimate: number | null;
  epsActual: number | null;
  status: "upcoming" | "last-reported";
  /** A scheduled date is the company's or the vendor's expectation, not a fact. */
  estimated: boolean;
}

/** Today's date in US/Eastern — the calendar the US market runs on. */
function easternToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

/**
 * The next earnings report: the NEAREST FUTURE row, falling back to the most
 * recent past one.
 *
 * Finnhub's calendar is not ordered, and can hold several quarters at once, so
 * taking the first row that matched the symbol announced whichever the vendor
 * happened to list first — Costco's December date instead of the September one,
 * with December's consensus attached to it.
 */
export function pickNextEarnings(rows: EarningsCalendarRow[], today: string): NextEarnings | null {
  const dated = rows.filter((r): r is EarningsCalendarRow & { date: string } => typeof r?.date === "string" && !!r.date);
  if (!dated.length) return null;

  const upcoming = dated.filter((r) => r.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  const past = dated.filter((r) => r.date < today).sort((a, b) => b.date.localeCompare(a.date))[0];
  const row = upcoming ?? past;
  if (!row) return null;

  return {
    date: row.date,
    quarter: row.quarter ?? null,
    year: row.year ?? null,
    epsEstimate: row.epsEstimate ?? null,
    epsActual: row.epsActual ?? null,
    status: upcoming ? "upcoming" : "last-reported",
    estimated: !!upcoming,
  };
}

export async function runEarningsAgent(input: unknown): Promise<string> {
  const { tickers } = input as { tickers: string[] };

  const earningsData: Record<string, object> = {};
  const fromDate = new Date().toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await Promise.allSettled(
    tickers.map(async (ticker) => {
      try {
        const [eps, calendar, recs] = await Promise.all([
          getEarnings(ticker),
          getEarningsCalendar(fromDate, toDate, ticker),
          getRecommendationTrends(ticker),
        ]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const epsHistory = (eps ?? []).slice(0, 6).map((e: any) => ({
          period: e.period,
          actual: e.actual,
          estimate: e.estimate,
          surprise: e.surprisePercent ? `${e.surprisePercent.toFixed(1)}%` : "N/A",
        }));

        const rows = ((calendar.earningsCalendar ?? []) as EarningsCalendarRow[]).filter(
          (e) => e.symbol === ticker
        );
        const next = pickNextEarnings(rows, easternToday());

        const latestRec = (recs ?? [])[0];

        earningsData[ticker] = {
          epsHistory,
          nextEarningsDate: next?.date ?? "Not scheduled in next 90 days",
          // A scheduled date is expected, not confirmed — say so, so the report
          // does not state it as fact.
          dateIsEstimated: next ? next.estimated : null,
          reportStatus: next?.status ?? "none-scheduled",
          fiscalQuarter: next?.quarter != null ? `Q${next.quarter} ${next.year ?? ""}`.trim() : "Unavailable",
          // The consensus belongs to the quarter of the date above, not to
          // whichever row the vendor listed first.
          epsEstimateForThatQuarter: next?.epsEstimate ?? "Unavailable",
          epsActualIfReported: next?.epsActual ?? null,
          analystRating: latestRec ? {
            strongBuy: latestRec.strongBuy,
            buy: latestRec.buy,
            hold: latestRec.hold,
            sell: latestRec.sell,
            strongSell: latestRec.strongSell,
          } : "No data",
        };
      } catch {
        earningsData[ticker] = { error: "Could not fetch earnings data" };
      }
    })
  );

  return generate({
    agent: "earnings",
    system: getSkillsPrompt("earnings"),
    maxTokens: 1500,
    prompt: `Analyze earnings history, upcoming catalysts, and analyst sentiment for ${tickers.join(", ")}.\n\n${JSON.stringify(earningsData, null, 2)}\n\nProvide: EPS trends, beat/miss history, upcoming earnings dates, analyst consensus, and earnings-based investment thesis for each ticker.

When \`dateIsEstimated\` is true the date is EXPECTED, not confirmed — write it as "expected [date]". When \`reportStatus\` is "last-reported" no date is scheduled yet: say when the company last reported instead of naming a future date. Quote \`epsEstimateForThatQuarter\` only against \`fiscalQuarter\`.`,
  });
}
