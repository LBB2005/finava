import { describe, it, expect } from "vitest";
import {
  resolveHorizon,
  PRESET_MONTHS,
  DEFAULT_ASSUMED_MONTHS,
  MIN_MONTHS,
  MAX_MONTHS,
  MIN_TRADING_DAYS,
  MAX_TRADING_DAYS,
} from "./horizon";

const ASOF = "2026-09-21T13:45:00.000Z"; // Mon 21 Sep 2026, 09:45 ET

describe("resolveHorizon — calendar months", () => {
  it("resolves an explicit 24-month horizon to the same day two years out", () => {
    const r = resolveHorizon({ count: 24, unit: "calendar_months" }, ASOF);
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.horizon.targetDate).toBe("2028-09-21");
    expect(r.horizon.assumed).toBe(false);
    expect(r.horizon.yearFraction).toBeCloseTo(731 / 365.25, 6);
  });

  it("marks an omitted horizon as assumed 12 months rather than guessing silently", () => {
    const r = resolveHorizon(null, ASOF);
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.horizon.count).toBe(DEFAULT_ASSUMED_MONTHS);
    expect(r.horizon.assumed).toBe(true);
    expect(r.horizon.targetDate).toBe("2027-09-21");
  });

  it("clips to month-end when the source day does not exist in the target month", () => {
    // 31 Jan + 1 month has no 31 Feb.
    const r = resolveHorizon({ count: 1, unit: "calendar_months" }, "2026-01-31T12:00:00.000Z");
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.horizon.targetDate).toBe("2026-02-28");
  });

  it("clips a leap day to 28 Feb in a non-leap target year", () => {
    const r = resolveHorizon({ count: 12, unit: "calendar_months" }, "2028-02-29T12:00:00.000Z");
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.horizon.targetDate).toBe("2029-02-28");
  });

  it("clips to 29 Feb, not 28, when the target month is a leap February", () => {
    // 31 Jan 2028 + 1 month: February 2028 has 29 days, so clipping stops at 29.
    const r = resolveHorizon({ count: 1, unit: "calendar_months" }, "2028-01-31T12:00:00.000Z");
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.horizon.targetDate).toBe("2028-02-29");
  });

  it("crosses a year boundary correctly", () => {
    const r = resolveHorizon({ count: 6, unit: "calendar_months" }, "2026-11-30T12:00:00.000Z");
    if (r.status !== "resolved") throw new Error("expected resolved");
    expect(r.horizon.targetDate).toBe("2027-05-30");
  });

  it("notes a weekend target date instead of silently shifting it", () => {
    // 21 Sep 2026 + 3 months = 21 Dec 2026 (Mon). Use 19 Sep → 19 Dec 2026 (Sat).
    const r = resolveHorizon({ count: 3, unit: "calendar_months" }, "2026-09-19T12:00:00.000Z");
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.horizon.targetDate).toBe("2026-12-19");
    expect(r.horizon.note).toMatch(/weekend/i);
  });

  it("leaves a weekday target date unannotated", () => {
    const r = resolveHorizon({ count: 3, unit: "calendar_months" }, ASOF);
    if (r.status !== "resolved") throw new Error("expected resolved");
    expect(r.horizon.targetDate).toBe("2026-12-21");
    expect(r.horizon.note).toBeNull();
  });

  it("uses the New York calendar date, not UTC, for a late-evening as-of", () => {
    // 02:30 UTC on 22 Sep is still 21 Sep in New York.
    const r = resolveHorizon({ count: 12, unit: "calendar_months" }, "2026-09-22T02:30:00.000Z");
    if (r.status !== "resolved") throw new Error("expected resolved");
    expect(r.horizon.targetDate).toBe("2027-09-21");
  });

  it("rejects a count outside the supported 1–60 month range", () => {
    for (const count of [0, -3, MAX_MONTHS + 1, 1000]) {
      expect(resolveHorizon({ count, unit: "calendar_months" }, ASOF).status).toBe("invalid");
    }
    expect(resolveHorizon({ count: MIN_MONTHS, unit: "calendar_months" }, ASOF).status).toBe("resolved");
    expect(resolveHorizon({ count: MAX_MONTHS, unit: "calendar_months" }, ASOF).status).toBe("resolved");
  });

  it("rejects a non-integer or non-finite count", () => {
    for (const count of [1.5, NaN, Infinity]) {
      expect(resolveHorizon({ count, unit: "calendar_months" }, ASOF).status).toBe("invalid");
    }
  });

  it("rejects an unparseable as-of rather than dating from now", () => {
    expect(resolveHorizon({ count: 12, unit: "calendar_months" }, "not-a-date").status).toBe("invalid");
  });

  it("exposes presets that match the product spec", () => {
    expect(PRESET_MONTHS).toEqual({ short: 3, medium: 12, long: 36 });
  });
});

describe("resolveHorizon — trading days", () => {
  it("reports unsupported_calendar rather than inventing a session date", () => {
    const r = resolveHorizon({ count: 63, unit: "trading_days" }, ASOF);
    expect(r.status).toBe("unsupported_calendar");
    if (r.status !== "unsupported_calendar") return;
    // The reason must say why, so the UI can explain it without guessing.
    expect(r.reason).toMatch(/exchange calendar/i);
  });

  it("never counts weekdays as exchange sessions", () => {
    // Every in-range trading-day request is unsupported — none resolve to a date.
    for (const count of [MIN_TRADING_DAYS, 21, 126, MAX_TRADING_DAYS]) {
      const r = resolveHorizon({ count, unit: "trading_days" }, ASOF);
      expect(r.status).toBe("unsupported_calendar");
    }
  });

  it("still validates the range before reporting unsupported", () => {
    // An out-of-range request is invalid input, a distinct problem from a
    // missing calendar — collapsing them would hide a client bug.
    expect(resolveHorizon({ count: 0, unit: "trading_days" }, ASOF).status).toBe("invalid");
    expect(resolveHorizon({ count: MAX_TRADING_DAYS + 1, unit: "trading_days" }, ASOF).status).toBe("invalid");
  });
});
