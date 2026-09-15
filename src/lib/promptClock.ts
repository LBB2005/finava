// The "what day is it" line every date-sensitive prompt carries.
//
// Models have no clock: without this, reports were dated months in the past,
// already-filed results were called projections, and estimated earnings dates
// were stated as fact. Everything is evaluated in America/New_York regardless of
// the server's timezone, because that is the calendar the US market runs on.
//
// Unlike marketHours.ts (a UI "Open/Closed" pill), this knows NYSE holidays, early
// closes and the pre-market/after-hours split, so it can name the last close.
// Years outside the table fall back to the weekday rule (no holidays).

export type MarketPhase = "pre-market" | "open" | "after-hours" | "weekend" | "holiday";

export interface MarketSession {
  phase: MarketPhase;
  /** Holiday name when phase === "holiday". */
  holiday?: string;
  /** Close time (minutes after midnight ET) of today's session, when it trades. */
  closeMinutes?: number;
}

// NYSE full-day closures, keyed YYYY-MM-DD (observed dates).
const HOLIDAYS: Record<string, string> = {
  "2025-01-01": "New Year's Day",
  "2025-01-09": "National Day of Mourning",
  "2025-01-20": "Martin Luther King Jr. Day",
  "2025-02-17": "Presidents' Day",
  "2025-04-18": "Good Friday",
  "2025-05-26": "Memorial Day",
  "2025-06-19": "Juneteenth",
  "2025-07-04": "Independence Day",
  "2025-09-01": "Labor Day",
  "2025-11-27": "Thanksgiving Day",
  "2025-12-25": "Christmas Day",
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King Jr. Day",
  "2026-02-16": "Presidents' Day",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day (observed)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
  "2027-01-01": "New Year's Day",
  "2027-01-18": "Martin Luther King Jr. Day",
  "2027-02-15": "Presidents' Day",
  "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth (observed)",
  "2027-07-05": "Independence Day (observed)",
  "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving Day",
  "2027-12-24": "Christmas Day (observed)",
};

// 13:00 ET early closes.
const EARLY_CLOSES = new Set(["2025-07-03", "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24", "2027-11-26"]);

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const EARLY_CLOSE_MIN = 13 * 60;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** A calendar date in ET (month is 1-based). */
interface EtDay {
  year: number;
  month: number;
  day: number;
}

function etParts(now: Date): EtDay & { minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const hour = get("hour") % 24; // Intl can emit "24" at midnight
  return { year: get("year"), month: get("month"), day: get("day"), minutes: hour * 60 + get("minute") };
}

// Date-only arithmetic runs on a UTC-noon Date so DST never shifts the day.
const asUtc = (d: EtDay) => new Date(Date.UTC(d.year, d.month - 1, d.day, 12));
const weekdayOf = (d: EtDay) => asUtc(d).getUTCDay();
const keyOf = (d: EtDay) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

function previousDay(d: EtDay): EtDay {
  const u = asUtc(d);
  u.setUTCDate(u.getUTCDate() - 1);
  return { year: u.getUTCFullYear(), month: u.getUTCMonth() + 1, day: u.getUTCDate() };
}

function isTradingDay(d: EtDay): boolean {
  const wd = weekdayOf(d);
  return wd !== 0 && wd !== 6 && !HOLIDAYS[keyOf(d)];
}

function closeMinutesOf(d: EtDay): number {
  return EARLY_CLOSES.has(keyOf(d)) ? EARLY_CLOSE_MIN : CLOSE_MIN;
}

/** Where the US regular session stands at `now`. */
export function usMarketSession(now: Date = new Date()): MarketSession {
  const et = etParts(now);
  const wd = weekdayOf(et);
  if (wd === 0 || wd === 6) return { phase: "weekend" };
  const holiday = HOLIDAYS[keyOf(et)];
  if (holiday) return { phase: "holiday", holiday };
  const closeMinutes = closeMinutesOf(et);
  if (et.minutes < OPEN_MIN) return { phase: "pre-market", closeMinutes };
  if (et.minutes < closeMinutes) return { phase: "open", closeMinutes };
  return { phase: "after-hours", closeMinutes };
}

/** The most recent completed regular session on or before `now`. */
function lastCloseDay(now: Date, session: MarketSession): EtDay {
  const et = etParts(now);
  let d: EtDay = { year: et.year, month: et.month, day: et.day };
  // Today counts only once its session has closed.
  if (session.phase !== "after-hours") d = previousDay(d);
  // Bounded walk — no run of US market closures is anywhere near 10 days.
  for (let i = 0; i < 10 && !isTradingDay(d); i++) d = previousDay(d);
  return d;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * One line for a system prompt, e.g.
 * "Today is Monday, 14 September 2026 (US/Eastern). US market: closed (weekend); last close Fri 11 Sep."
 */
export function promptClockLine(now: Date = new Date()): string {
  const et = etParts(now);
  const today = `${WEEKDAYS[weekdayOf(et)]}, ${et.day} ${MONTHS[et.month - 1]} ${et.year}`;
  const session = usMarketSession(now);

  const status = (() => {
    switch (session.phase) {
      case "weekend":
        return "closed (weekend)";
      case "holiday":
        return `closed (holiday: ${session.holiday})`;
      case "pre-market":
        return "pre-market (opens 09:30 ET)";
      case "open":
        return `open (regular session, closes ${hhmm(session.closeMinutes ?? CLOSE_MIN)} ET)`;
      case "after-hours":
        return "closed (after hours)";
    }
  })();

  const last = lastCloseDay(now, session);
  const lastLabel = `${WEEKDAYS[weekdayOf(last)].slice(0, 3)} ${last.day} ${MONTHS[last.month - 1].slice(0, 3)}`;

  return `Today is ${today} (US/Eastern). US market: ${status}; last close ${lastLabel}.`;
}
