import { describe, expect, it } from "vitest";
import { isMarketOpen, lastCloseDate, asOfLastCloseLabel } from "./marketSession";

// All instants below are UTC; September 2026 is EDT (UTC−4).
describe("isMarketOpen", () => {
  it("is open during the regular weekday session", () => {
    expect(isMarketOpen(new Date("2026-09-15T14:00:00Z"))).toBe(true); // Tue 10:00 ET
  });

  it("is closed before the open, after the close, and on weekends", () => {
    expect(isMarketOpen(new Date("2026-09-15T13:00:00Z"))).toBe(false); // Tue 09:00 ET
    expect(isMarketOpen(new Date("2026-09-15T20:30:00Z"))).toBe(false); // Tue 16:30 ET
    expect(isMarketOpen(new Date("2026-09-19T15:00:00Z"))).toBe(false); // Sat 11:00 ET
  });
});

describe("lastCloseDate", () => {
  it("is today once the session has closed", () => {
    expect(lastCloseDate(new Date("2026-09-15T21:00:00Z"))).toBe("2026-09-15"); // Tue 17:00 ET
  });

  it("is the previous weekday before the open", () => {
    expect(lastCloseDate(new Date("2026-09-15T12:00:00Z"))).toBe("2026-09-14"); // Tue 08:00 ET
  });

  it("is Friday across a weekend and early Monday", () => {
    expect(lastCloseDate(new Date("2026-09-19T15:00:00Z"))).toBe("2026-09-18"); // Sat
    expect(lastCloseDate(new Date("2026-09-20T15:00:00Z"))).toBe("2026-09-18"); // Sun
    expect(lastCloseDate(new Date("2026-09-21T12:00:00Z"))).toBe("2026-09-18"); // Mon 08:00 ET
  });

  it("uses New York time, not UTC, around midnight", () => {
    // Sat 02:00 UTC = Fri 22:00 ET — Friday has closed.
    expect(lastCloseDate(new Date("2026-09-19T02:00:00Z"))).toBe("2026-09-18");
  });
});

describe("asOfLastCloseLabel", () => {
  it("names the last close in a short human form", () => {
    expect(asOfLastCloseLabel(new Date("2026-09-19T15:00:00Z"))).toBe("As of Fri Sep 18 close");
  });
});
