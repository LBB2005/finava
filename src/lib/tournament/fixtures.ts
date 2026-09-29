// Synthetic pipeline fixtures. Never admissible to prospective calibration.
import calendar from "../../../scripts/fixtures/tournament/calendar.json";
import { parseSessions } from "../marketCalendar";
import { emptyInputs } from "../facts/pointInTime";
import type { TournamentSnapshot } from "./types";
export const fixtureSessions = () => parseSessions(calendar);
export function fixtureSnapshot(): TournamentSnapshot {
  const session = fixtureSessions()[0];
  return {
    evidenceClass: "synthetic",
    asOf: session.close,
    observedAt: session.close
      .replace("20:00", "21:00")
      .replace("17:00", "18:00"),
    membership: {
      date: session.date,
      source: "SYNTHETIC FIXTURE - NOT S&P 500",
      verified: true,
      members: Array.from({ length: 30 }, (_, i) => ({
        ticker: `T${i}`,
        name: `Synthetic ${i}`,
        sector: "fixture",
      })),
    },
    names: Array.from({ length: 30 }, (_, i) => {
      const f = (value: number) => ({
        value,
        source: "SYNTHETIC FIXTURE",
        asOf: session.close,
      });
      return {
        ticker: `T${i}`,
        sector: "fixture",
        inputs: {
          ...emptyInputs(),
          price: f(100),
          revenueYoY: f(i),
          netMargin: f(i),
          peTTM: f(30 - i / 2),
          peerPe: f(20),
          ret3m: f(i - 15),
        },
        reasons: [
          "Synthetic fixture; hindsight-contaminated; excluded from calibration",
        ],
      };
    }),
  };
}
