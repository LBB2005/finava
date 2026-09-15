import { describe, it, expect } from "vitest";
import { promptClockLine, usMarketSession } from "./promptClock";

// All instants are UTC; September 2026 is EDT (UTC-4), January is EST (UTC-5).
const at = (iso: string) => new Date(iso);

describe("promptClockLine", () => {
  it("names the weekend and the previous Friday's close on a Sunday", () => {
    // Sun 13 Sep 2026, 12:00 ET
    expect(promptClockLine(at("2026-09-13T16:00:00Z"))).toBe(
      "Today is Sunday, 13 September 2026 (US/Eastern). US market: closed (weekend); last close Fri 11 Sep."
    );
  });

  it("reports pre-market before 09:30 ET and points at the prior session's close", () => {
    // Tue 15 Sep 2026, 08:00 ET
    expect(promptClockLine(at("2026-09-15T12:00:00Z"))).toBe(
      "Today is Tuesday, 15 September 2026 (US/Eastern). US market: pre-market (opens 09:30 ET); last close Mon 14 Sep."
    );
  });

  it("reports the regular session as open with its closing time", () => {
    // Mon 14 Sep 2026, 10:15 ET
    expect(promptClockLine(at("2026-09-14T14:15:00Z"))).toBe(
      "Today is Monday, 14 September 2026 (US/Eastern). US market: open (regular session, closes 16:00 ET); last close Fri 11 Sep."
    );
  });

  it("reports after-hours with today's session as the last close", () => {
    // Mon 14 Sep 2026, 17:30 ET
    expect(promptClockLine(at("2026-09-14T21:30:00Z"))).toBe(
      "Today is Monday, 14 September 2026 (US/Eastern). US market: closed (after hours); last close Mon 14 Sep."
    );
  });

  it("names an exchange holiday and skips it when finding the last close", () => {
    // Mon 7 Sep 2026 (Labor Day), 11:00 ET
    expect(promptClockLine(at("2026-09-07T15:00:00Z"))).toBe(
      "Today is Monday, 7 September 2026 (US/Eastern). US market: closed (holiday: Labor Day); last close Fri 4 Sep."
    );
  });

  it("walks back over a holiday that follows a weekend", () => {
    // Tue 8 Sep 2026, 07:00 ET — Mon was Labor Day, so the last close is Fri 4 Sep.
    expect(promptClockLine(at("2026-09-08T11:00:00Z"))).toContain("last close Fri 4 Sep.");
  });

  it("uses the ET calendar date, not the UTC one, late in the evening", () => {
    // 02:00 UTC Tue = 22:00 ET Mon 14 Sep
    expect(promptClockLine(at("2026-09-15T02:00:00Z"))).toContain("Today is Monday, 14 September 2026");
  });

  it("handles standard time (EST) in winter", () => {
    // Fri 15 Jan 2027, 09:45 ET = 14:45 UTC
    expect(promptClockLine(at("2027-01-15T14:45:00Z"))).toContain("US market: open");
  });

  it("honours an early close (day after Thanksgiving)", () => {
    // Fri 27 Nov 2026, 14:00 ET — the session closed at 13:00.
    const line = promptClockLine(at("2026-11-27T19:00:00Z"));
    expect(line).toContain("US market: closed (after hours)");
    expect(line).toContain("last close Fri 27 Nov.");
  });
});

describe("usMarketSession", () => {
  it("classifies each phase of a trading day", () => {
    expect(usMarketSession(at("2026-09-14T13:29:00Z")).phase).toBe("pre-market");
    expect(usMarketSession(at("2026-09-14T13:30:00Z")).phase).toBe("open");
    expect(usMarketSession(at("2026-09-14T19:59:00Z")).phase).toBe("open");
    expect(usMarketSession(at("2026-09-14T20:00:00Z")).phase).toBe("after-hours");
    expect(usMarketSession(at("2026-09-12T15:00:00Z")).phase).toBe("weekend");
    expect(usMarketSession(at("2026-12-25T15:00:00Z")).phase).toBe("holiday");
  });
});
