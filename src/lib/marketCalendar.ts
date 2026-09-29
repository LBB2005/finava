// Exchange sessions, never a weekday approximation. Cache entries expire so
// announced emergency closures do not remain hidden behind a permanent cache.
import { z } from "zod";
export interface MarketSession {
  date: string;
  open: string;
  close: string;
}
export interface CalendarCache {
  get(key: string): Promise<{ at: number; sessions: MarketSession[] } | null>;
  put(
    key: string,
    value: { at: number; sessions: MarketSession[] },
  ): Promise<void>;
}
export function validDate(date: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
export function easternDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
export function shiftDate(day: string, days: number): string {
  if (!validDate(day)) throw new Error("Invalid calendar date");
  return new Date(Date.parse(day) + days * 86400000).toISOString().slice(0, 10);
}
function nyInstant(date: string, time: string): string {
  const naive = Date.parse(
    `${date}T${time.length === 5 ? `${time}:00` : time}Z`,
  );
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const offset = parts
    .find((p) => p.type === "timeZoneName")
    ?.value.replace("GMT", "");
  if (!offset || !Number.isFinite(naive))
    throw new Error("Invalid exchange time");
  return new Date(
    `${date}T${time.length === 5 ? `${time}:00` : time}${offset}`,
  ).toISOString();
}
export function parseSessions(raw: unknown): MarketSession[] {
  const rows = z
    .array(
      z.object({
        date: z.string().refine(validDate),
        open: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
        close: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
      }),
    )
    .parse(raw);
  const sessions = rows
    .map((r) => ({
      date: r.date,
      open: nyInstant(r.date, r.open),
      close: nyInstant(r.date, r.close),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (
    new Set(sessions.map((s) => s.date)).size !== sessions.length ||
    sessions.some((s) => s.open >= s.close)
  )
    throw new Error("Invalid exchange sessions");
  return sessions;
}
export function sessionWindow(
  sessions: readonly MarketSession[],
  asOfDate: string,
  count: number,
) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !sessions.some((s) => s.date === asOfDate)
  )
    throw new Error("Missing source session or invalid horizon");
  const future = sessions
    .filter((s) => s.date > asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const entry = future[0],
    target = future[count - 1];
  if (!entry || !target)
    throw new Error("Exchange calendar does not cover horizon");
  return {
    entryDate: entry.date,
    entryAt: entry.open,
    targetDate: target.date,
    targetAt: target.close,
  };
}
export class ExchangeCalendar {
  constructor(
    private deps: {
      fetch?: typeof fetch;
      key?: string;
      secret?: string;
      baseUrl?: string;
      cache?: CalendarCache;
      now?: () => number;
    } = {},
  ) {}
  async range(start: string, end: string): Promise<MarketSession[]> {
    if (!validDate(start) || !validDate(end) || start > end)
      throw new Error("Invalid calendar range");
    const cacheKey = `${start}_${end}`,
      now = (this.deps.now ?? Date.now)();
    const cached = await this.deps.cache?.get(cacheKey);
    if (cached && now - cached.at >= 0 && now - cached.at < 6 * 3600000)
      return cached.sessions;
    const key = this.deps.key ?? process.env.ALPACA_API_KEY,
      secret = this.deps.secret ?? process.env.ALPACA_API_SECRET;
    if (!key || !secret) throw new Error("Alpaca calendar credentials missing");
    const base =
      this.deps.baseUrl ??
      process.env.ALPACA_BASE_URL ??
      "https://paper-api.alpaca.markets";
    if (
      !["paper-api.alpaca.markets", "api.alpaca.markets"].includes(
        new URL(base).hostname,
      )
    )
      throw new Error("Unsupported calendar host");
    const r = await (this.deps.fetch ?? fetch)(
      `${base.replace(/\/$/, "")}/v2/calendar?${new URLSearchParams({ start, end })}`,
      {
        headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) throw new Error(`Alpaca calendar unavailable (${r.status})`);
    const sessions = parseSessions(await r.json());
    if (sessions.some((s) => s.date < start || s.date > end))
      throw new Error("Calendar returned sessions outside requested range");
    await this.deps.cache?.put(cacheKey, { at: now, sessions });
    return sessions;
  }
  async mostRecentCompleted(now: Date): Promise<MarketSession> {
    const today = easternDate(now),
      sessions = await this.range(shiftDate(today, -30), today);
    const last = sessions
      .filter((s) => Date.parse(s.close) <= now.getTime())
      .at(-1);
    if (!last) throw new Error("No completed exchange session available");
    return last;
  }
}
