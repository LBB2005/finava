// Investment horizons — resolving "for the next two years" to a dated target.
//
// A horizon is the single most load-bearing field in an investment report: an
// expected return without one is meaningless, and a 14.5% estimate is a Buy over
// one year and a Watch over two. So it is resolved once, explicitly, and carried
// through request → valuation → cache key → persistence → UI → outcome
// resolution without ever changing units. `assumed` records whether the user
// actually said it, because a default the user never chose must be visible and
// changeable rather than presented as their intent.
//
// WHY CALENDAR MONTHS ARE THE SUPPORTED UNIT
//
// Resolving a *trading-day* horizon to an exact future session requires an
// exchange calendar, and this repository does not have one. Both session helpers
// say so explicitly: marketHours.ts ("does not account for exchange holidays")
// and marketSession.ts ("exchange holidays ignored"). Counting forward 63
// weekdays would land on Thanksgiving or Christmas and call it a session, which
// is precision we have not earned — the kind of quiet fabrication that makes an
// outcome unresolvable later, because the date the report promised was never a
// trading day.
//
// Calendar months need no such table: add months, clip to month-end, done. That
// covers the entire product spec (1–60 months; Short/Medium/Long = 3/12/36), so
// the supported unit is the one we can compute honestly, and `trading_days`
// returns `unsupported_calendar` until a calendar adapter exists. Finava Live's
// 5/21/63/126-day horizons are why the unit is in the contract at all.

/** The two units a horizon can be expressed in. */
export type HorizonUnit = "calendar_months" | "trading_days";

export const MIN_MONTHS = 1;
export const MAX_MONTHS = 60;
export const MIN_TRADING_DAYS = 5;
export const MAX_TRADING_DAYS = 1260;

/** Preset labels. An explicit user duration always wins over a preset. */
export const PRESET_MONTHS = { short: 3, medium: 12, long: 36 } as const;

/**
 * Used when the user names no horizon at all. Surfaced as `assumed: true` so the
 * UI can show "assuming 12 months" and offer to change it — an invisible default
 * would let the user read a two-year thesis as a one-year one.
 */
export const DEFAULT_ASSUMED_MONTHS = PRESET_MONTHS.medium;

export interface HorizonInput {
  count: number;
  unit: HorizonUnit;
}

export interface ResolvedHorizon {
  count: number;
  unit: HorizonUnit;
  /** True when no horizon was supplied and the default was applied. */
  assumed: boolean;
  /** Resolved calendar date, YYYY-MM-DD, in the New York exchange timezone. */
  targetDate: string;
  /** Actual elapsed calendar days / 365.25. Used to annualize, never to display. */
  yearFraction: number;
  /**
   * A caveat about the resolved date that is true but not an error — currently
   * only "it is a weekend". The date is NOT shifted to the nearest session,
   * because we have no calendar to identify one; the note says what we know.
   */
  note: string | null;
}

export type HorizonResolution =
  | { status: "resolved"; horizon: ResolvedHorizon }
  /** The unit needs an exchange calendar we do not have. Distinct from invalid. */
  | { status: "unsupported_calendar"; reason: string }
  /** The request itself is out of range or unparseable. A client bug, not a gap. */
  | { status: "invalid"; reason: string };

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;

/** The New York calendar date of an instant, as {y, m, d}. */
function nyDateParts(at: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "", 10);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days in a month, 1-indexed month. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Add whole months to a calendar date, clipping to month-end when the source day
 * does not exist in the target month: 31 Jan + 1mo = 28 Feb, and 29 Feb + 12mo =
 * 28 Feb. Clipping (rather than rolling into the next month) keeps a horizon
 * from silently growing past the duration the user asked for.
 */
function addMonths(y: number, m: number, d: number, months: number) {
  const zeroBased = (m - 1) + months;
  const ty = y + Math.floor(zeroBased / 12);
  const tm = (zeroBased % 12 + 12) % 12 + 1;
  return { y: ty, m: tm, d: Math.min(d, daysInMonth(ty, tm)) };
}

/** True when a Y-M-D falls on a Saturday or Sunday. */
function isWeekend(y: number, m: number, d: number): boolean {
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

function invalid(reason: string): HorizonResolution {
  return { status: "invalid", reason };
}

/**
 * Resolve a horizon request against a run's as-of instant.
 *
 * `input` of null means the user named no horizon: the default is applied and
 * flagged `assumed`. An unparseable `asOf` is invalid rather than silently
 * replaced with the current time, because dating a report from "whenever this
 * ran" is how a horizon stops being reproducible.
 */
export function resolveHorizon(
  input: HorizonInput | null | undefined,
  asOf: string
): HorizonResolution {
  const at = new Date(asOf);
  if (Number.isNaN(at.getTime())) {
    return invalid(`unparseable as-of instant: ${String(asOf)}`);
  }

  const unit: HorizonUnit = input?.unit ?? "calendar_months";
  const assumed = input == null;
  const count = assumed ? DEFAULT_ASSUMED_MONTHS : input!.count;

  if (!Number.isFinite(count) || !Number.isInteger(count)) {
    return invalid(`horizon count must be a whole number, got ${String(count)}`);
  }

  // Range is checked before the calendar gap, so an out-of-range trading-day
  // request reports the client bug rather than hiding behind the missing calendar.
  if (unit === "trading_days") {
    if (count < MIN_TRADING_DAYS || count > MAX_TRADING_DAYS) {
      return invalid(
        `trading-day horizon must be ${MIN_TRADING_DAYS}–${MAX_TRADING_DAYS}, got ${count}`
      );
    }
    return {
      status: "unsupported_calendar",
      reason:
        "Trading-day horizons need an exchange calendar (sessions and holidays), which is not available. Ask for a duration in months instead.",
    };
  }

  if (count < MIN_MONTHS || count > MAX_MONTHS) {
    return invalid(`month horizon must be ${MIN_MONTHS}–${MAX_MONTHS}, got ${count}`);
  }

  const start = nyDateParts(at);
  const target = addMonths(start.y, start.m, start.d, count);
  const targetDate = iso(target.y, target.m, target.d);

  // Elapsed days from calendar arithmetic in UTC, so DST never adds or drops an
  // hour that could round the year fraction the wrong way.
  const startUtc = Date.UTC(start.y, start.m - 1, start.d);
  const targetUtc = Date.UTC(target.y, target.m - 1, target.d);
  const elapsedDays = (targetUtc - startUtc) / MS_PER_DAY;

  return {
    status: "resolved",
    horizon: {
      count,
      unit: "calendar_months",
      assumed,
      targetDate,
      yearFraction: elapsedDays / DAYS_PER_YEAR,
      note: isWeekend(target.y, target.m, target.d)
        ? "Target date falls on a weekend; it is a calendar date, not a confirmed exchange session."
        : null,
    },
  };
}
