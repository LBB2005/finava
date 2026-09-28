// Strict tournament facts: unlike UI reads, undated inputs are withheld too.
import { standingOf } from "../live/asOf";
import { missing } from "./types";
import type { ScoreInputs } from "../finavaScore";
import type { InputFacts } from "../tournament/types";
export const INPUT_KEYS: (keyof ScoreInputs)[] = [
  "revenueYoY",
  "epsYoY",
  "revenueCagr3y",
  "grossMargin",
  "operatingMargin",
  "netMargin",
  "roe",
  "roa",
  "roic",
  "debtToEquity",
  "currentRatio",
  "fcfConversion",
  "price",
  "dcfFair",
  "peTTM",
  "peerPe",
  "psTTM",
  "peerPs",
  "ratingSkew",
  "targetUpsidePct",
  "estimateRevisionPct",
  "earningsSurprisePct",
  "trendVs200",
  "ret3m",
  "relStrength6m",
  "newsSentiment",
  "xSentiment",
  "insiderFlow",
  "beta",
  "annualizedVol",
];
export function emptyInputs(): InputFacts {
  return Object.fromEntries(
    INPUT_KEYS.map((k) => [
      k,
      missing("unavailable", "No point-in-time observation", ""),
    ]),
  ) as InputFacts;
}
export function cleanInputs(
  inputs: InputFacts,
  asOf: string,
): { values: ScoreInputs; inputs: InputFacts; reasons: string[] } {
  const reasons: string[] = [];
  const clean = emptyInputs();
  for (const key of INPUT_KEYS) {
    const f = inputs[key];
    const standing = standingOf(f?.asOf, asOf);
    if (
      !f ||
      f.value === null ||
      !Number.isFinite(f.value) ||
      standing !== "clean"
    ) {
      const note = f?.note ?? "missing";
      const reason =
        f?.value != null && standing !== "clean"
          ? `${key}:${standing}`
          : note.startsWith(`${key}:`)
            ? note
            : `${key}:${note}`;
      reasons.push(reason);
      clean[key] = missing(f?.source ?? "unavailable", reason, f?.asOf ?? "");
    } else clean[key] = { ...f };
  }
  return {
    inputs: clean,
    values: Object.fromEntries(
      INPUT_KEYS.map((k) => [k, clean[k].value]),
    ) as unknown as ScoreInputs,
    reasons,
  };
}
// SEC period-end is not availability. Filter by filing publication date BEFORE
// invoking the existing extractors; exclude same-day filings conservatively.
export function filterCompanyFacts(raw: unknown, asOf: string): unknown {
  if (!raw || typeof raw !== "object") return null;
  const clone = structuredClone(raw) as {
    facts?: Record<
      string,
      Record<string, { units?: Record<string, Record<string, unknown>[]> }>
    >;
  };
  const cutoff = asOf.slice(0, 10);
  for (const taxonomy of Object.values(clone.facts ?? {}))
    for (const concept of Object.values(taxonomy))
      for (const [unit, rows] of Object.entries(concept.units ?? {})) {
        concept.units![unit] = rows.filter(
          (r) =>
            typeof r.filed === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(r.filed) &&
            r.filed < cutoff &&
            typeof r.end === "string" &&
            r.end <= cutoff,
        );
      }
  return clone;
}
