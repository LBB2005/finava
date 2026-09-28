import { scoreFactors } from "../finavaScore";
import { cleanInputs } from "../facts/pointInTime";
import {
  DETERMINISTIC_ARMS,
  type DeterministicArm,
  type TournamentSnapshot,
  type RankedName,
} from "./types";
const mean = (xs: (number | null)[]) => {
  const valid = xs.filter((x): x is number => x !== null);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
};
export function rankStrategies(
  snapshot: TournamentSnapshot,
): Record<DeterministicArm, RankedName[]> {
  const members = new Set(snapshot.membership.members.map((m) => m.ticker));
  const raw = snapshot.names
    .filter((n) => members.has(n.ticker))
    .map((n) => {
      const clean = cleanInputs(n.inputs, snapshot.asOf);
      const f = Object.fromEntries(
        scoreFactors(clean.values).map((f) => [f.key, f.score]),
      );
      const quality = mean([f.profitability, f.returns, f.health, f.cashflow]);
      const value = mean([f.relativeVal, f.absoluteVal]),
        growth = f.growth,
        momentum = mean([f.trend, f.relStrength]);
      const contrarian =
        quality !== null && quality >= 50 && momentum !== null
          ? 100 - momentum
          : null;
      const parts = [value, quality, growth, momentum];
      const scores = {
        value,
        quality,
        growth,
        momentum,
        contrarian,
        composite: parts.every((v) => v !== null) ? mean(parts) : null,
      };
      if (clean.values.price === null || !snapshot.membership.verified)
        for (const arm of DETERMINISTIC_ARMS) scores[arm] = null;
      return {
        ticker: n.ticker,
        scores,
        reasons: [
          ...n.reasons,
          ...clean.reasons,
          ...(!snapshot.membership.verified
            ? ["unverified_universe_membership"]
            : []),
        ],
      };
    });
  return Object.fromEntries(
    DETERMINISTIC_ARMS.map((arm) => {
      const sorted = [...raw].sort(
        (a, b) =>
          (b.scores[arm] ?? -Infinity) - (a.scores[arm] ?? -Infinity) ||
          a.ticker.localeCompare(b.ticker),
      );
      const count = sorted.filter((n) => n.scores[arm] !== null).length;
      const size = Math.min(10, Math.floor(count / 2));
      return [
        arm,
        sorted.map(
          (n, i): RankedName => ({
            ticker: n.ticker,
            score: n.scores[arm],
            rank: n.scores[arm] === null ? null : i + 1,
            decile:
              n.scores[arm] === null
                ? null
                : 10 - Math.min(9, Math.floor((i * 10) / count)),
            disposition:
              n.scores[arm] === null
                ? "unscored"
                : i < size
                  ? "long"
                  : i >= count - size
                    ? "avoid"
                    : "neutral",
            reasons: n.reasons,
          }),
        ),
      ];
    }),
  ) as Record<DeterministicArm, RankedName[]>;
}
export function modelShortlist(
  arms: Record<DeterministicArm, RankedName[]>,
): string[] {
  return [
    ...new Set(
      [
        ...arms.composite.filter(
          (r) => r.disposition === "long" || r.disposition === "avoid",
        ),
        ...arms.contrarian.filter((r) => r.score !== null).slice(0, 5),
      ].map((r) => r.ticker),
    ),
  ].slice(0, 25);
}
// TODO: enable only with verified Finnhub estimates entitlement and dated revisions.
export function earningsRevisions() {
  return {
    status: "unavailable" as const,
    reason: "Finnhub estimates are premium-gated; no revisions arm is scored",
  };
}
