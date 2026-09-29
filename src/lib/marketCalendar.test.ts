import { describe, expect, it, vi } from "vitest";
import {
  ExchangeCalendar,
  parseSessions,
  sessionWindow,
} from "./marketCalendar";
import { resolveHorizon } from "./investment/horizon";
const raw = [
  { date: "2026-07-02", open: "09:30", close: "13:00" },
  { date: "2026-07-06", open: "09:30", close: "16:00" },
  { date: "2026-07-07", open: "09:30", close: "16:00" },
];
describe("exchange session horizons", () => {
  it("uses holiday-aware next open and counts the entry session as day one", () => {
    const sessions = parseSessions(raw);
    expect(sessionWindow(sessions, "2026-07-02", 1)).toMatchObject({
      entryAt: "2026-07-06T13:30:00.000Z",
      targetAt: "2026-07-06T20:00:00.000Z",
    });
    expect(sessionWindow(sessions, "2026-07-02", 2).targetDate).toBe(
      "2026-07-07",
    );
    expect(
      resolveHorizon(
        { count: 1, unit: "trading_days" },
        sessions[0].close,
        sessions,
      ).status,
    ).toBe("resolved");
  });
  it("knows early closes and both DST offsets", () => {
    expect(parseSessions(raw)[0].close).toBe("2026-07-02T17:00:00.000Z");
    expect(
      parseSessions([{ date: "2026-12-24", open: "09:30", close: "13:00" }])[0]
        .open,
    ).toBe("2026-12-24T14:30:00.000Z");
  });
  it("does not manufacture missing sessions or accept invalid dates", () => {
    expect(() => sessionWindow(parseSessions(raw), "2026-07-03", 1)).toThrow();
    expect(() => sessionWindow(parseSessions(raw), "2026-07-02", 5)).toThrow();
    expect(() =>
      parseSessions([{ date: "2026-02-30", open: "09:30", close: "16:00" }]),
    ).toThrow();
  });
  it("caches calendar responses, including closed dates, without weekday guessing", async () => {
    const values = new Map();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(raw)));
    const c = new ExchangeCalendar({
      fetch: fetcher,
      key: "test",
      secret: "test",
      cache: {
        get: async (k) => values.get(k) ?? null,
        put: async (k, v) => {
          values.set(k, v);
        },
      },
    });
    const s = await c.range("2026-07-02", "2026-07-07");
    expect(s.some((x) => x.date === "2026-07-03")).toBe(false);
    await c.range("2026-07-02", "2026-07-07");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
