// Minimal US market-session helpers for UI labels: only claim LIVE / "today"
// while the regular session is open; otherwise say "As of <last close>".
//
// Regular session only (09:30–16:00 ET, Mon–Fri), exchange holidays ignored —
// same scope as `usMarketStatus` in marketHours.ts, which this builds on.
// TODO(dedupe): fold into W1-3's promptClock market-session util once both land.

import { usMarketStatus } from "./marketHours";

export function isMarketOpen(now: Date = new Date()): boolean {
  return usMarketStatus(now).open;
}

interface NyParts {
  y: number;
  m: number;
  d: number;
  weekday: number; // 0 = Sun … 6 = Sat
  minutes: number; // minutes into the NY day
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function nyParts(now: Date): NyParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    y: parseInt(get("year"), 10),
    m: parseInt(get("month"), 10),
    d: parseInt(get("day"), 10),
    weekday: WEEKDAYS.indexOf(get("weekday")),
    minutes: (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10),
  };
}

/** The NY calendar date (YYYY-MM-DD) of the most recent completed regular session. */
export function lastCloseDate(now: Date = new Date()): string {
  const p = nyParts(now);
  // Walk back over calendar dates in UTC arithmetic (no DST involvement).
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d));
  let weekday = p.weekday;
  const closedToday = weekday >= 1 && weekday <= 5 && p.minutes >= 16 * 60;
  if (!closedToday) {
    do {
      day.setUTCDate(day.getUTCDate() - 1);
      weekday = (weekday + 6) % 7;
    } while (weekday === 0 || weekday === 6);
  }
  return day.toISOString().slice(0, 10);
}

/** "As of Fri Sep 18 close" — the honest stand-in for LIVE / "today" when closed. */
export function asOfLastCloseLabel(now: Date = new Date()): string {
  const [y, m, d] = lastCloseDate(now).split("-").map(Number);
  const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `As of ${label.replace(",", "")} close`;
}
